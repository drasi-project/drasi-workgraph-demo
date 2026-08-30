#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import { isDeepStrictEqual, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { parseRuntimeTask } from "./workgraph-v1-definition.mjs";

const API = "https://api.github.com";
const OWNER = "drasi-project";
const REPO = "drasi-workgraph-demo";
const REPOSITORY_URL = `${API}/repos/${OWNER}/${REPO}`;
const TASK_TYPE_NAME = "WorkGraphTask";
const WORKFLOW_DEFINITION_ID = "issue-lifecycle";
const WORKFLOW_DEFINITION_VERSION = "v1";
const WORKFLOW_DEFINITION_DIGEST = `sha256:${"a".repeat(64)}`;
const ROOT_TASK_DEFINITION_ID = "root-v1";
const VALIDATOR_TASK_DEFINITION_ID = "validate-v1";
const TASK_DISPATCH_MARKER = "WorkGraphTaskDispatch/v1";
const TASK_RESULT_MARKER = "WorkGraphTaskResult/v1";
const LEASE_VALIDATION_PATH = "/github/workgraph-v1/lease/validate";
const MAX_ID_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;
const TASK_IDENTITY_KEYS = [
  "taskId",
  "workflowRunId",
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
];

export class WorkGraphReporterError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys, label) {
  if (
    !object(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  ) {
    throw new WorkGraphReporterError(
      `${label} properties must be exactly ${[...keys].sort().join(", ")}`,
    );
  }
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function opaque(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ID_BYTES ||
    !wellFormed(value) ||
    /[\p{White_Space}\p{Cc}]/u.test(value)
  ) {
    throw new WorkGraphReporterError(`${label} must be a bounded opaque ID`);
  }
  return value;
}

function issueNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkGraphReporterError(`${label} must be a positive integer`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new WorkGraphReporterError(`${label} must be sha256:<64 lowercase hex>`);
  }
  return value;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJsonValue(value, label = "output", depth = 0) {
  if (depth > 32) {
    throw new WorkGraphReporterError(`${label} exceeds the maximum nesting depth`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!wellFormed(value)) {
      throw new WorkGraphReporterError(`${label} contains an unpaired UTF-16 surrogate`);
    }
    if (value.includes("\r") || value.includes("```")) {
      throw new WorkGraphReporterError(`${label} strings must be ordinary LF text`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new WorkGraphReporterError(
        `${label} numbers must be JavaScript-safe integers`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalJsonValue(entry, `${label}[${index}]`, depth + 1),
    );
  }
  if (!object(value)) {
    throw new WorkGraphReporterError(`${label} must contain only JSON values`);
  }
  for (const key of Object.keys(value)) {
    if (key.length === 0 || key.includes("\r") || key.includes("```")) {
      throw new WorkGraphReporterError(
        `${label} property names must be non-empty ordinary LF text`,
      );
    }
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort(utf8Compare)
      .map((key) => [
        canonicalJsonValue(key, `${label} key`, depth + 1),
        canonicalJsonValue(value[key], `${label}.${key}`, depth + 1),
      ]),
  );
}

function serdeJsonNumber(value) {
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isSafeInteger(value)) return String(value);

  const source = String(value).toLowerCase();
  let digits;
  let exponent;
  if (source.includes("e")) {
    const [coefficient, rawExponent] = source.split("e");
    digits = coefficient.replace(/^-/, "").replace(".", "");
    exponent = Number(rawExponent);
  } else {
    const unsigned = source.replace(/^-/, "");
    const point = unsigned.indexOf(".");
    const integer = point === -1 ? unsigned : unsigned.slice(0, point);
    const fraction = point === -1 ? "" : unsigned.slice(point + 1);
    if (integer !== "0") {
      digits = `${integer}${fraction}`;
      exponent = integer.length - 1;
    } else {
      const first = fraction.search(/[1-9]/);
      digits = fraction.slice(first);
      exponent = -first - 1;
    }
  }
  digits = digits.replace(/0+$/, "");
  const sign = value < 0 ? "-" : "";
  if (exponent <= -6 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    return `${sign}${digits[0]}${fraction}e${exponent >= 0 ? "+" : "-"}${Math.abs(exponent)}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  if (digits.length <= exponent + 1) {
    return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

function prettyJson(value, depth = 0, sortData = false) {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") return serdeJsonNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((entry) => `${childIndent}${prettyJson(entry, depth + 1, sortData)}`)
      .join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(value);
  if (sortData) keys.sort(utf8Compare);
  if (keys.length === 0) return "{}";
  return `{\n${keys
    .map((key) => {
      const childSort = sortData || key === "output";
      return `${childIndent}${JSON.stringify(key)}: ${prettyJson(
        value[key],
        depth + 1,
        childSort,
      )}`;
    })
    .join(",\n")}\n${indent}}`;
}

function canonicalBody(marker, value) {
  const body = `${marker}\n\n\`\`\`json\n${prettyJson(value)}\n\`\`\`\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new WorkGraphReporterError(`${marker} body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return body;
}

function parseCanonicalBody(body, marker, normalize) {
  if (
    typeof body !== "string" ||
    body.includes("\r") ||
    Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES
  ) {
    return null;
  }
  const prefix = `${marker}\n\n\`\`\`json\n`;
  const suffix = "\n```\n";
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) return null;
  try {
    const value = normalize(JSON.parse(body.slice(prefix.length, -suffix.length)));
    return canonicalBody(marker, value) === body ? value : null;
  } catch {
    return null;
  }
}

function normalizeTaskIdentity(value, label = "task identity") {
  exact(value, TASK_IDENTITY_KEYS, label);
  const normalized = Object.fromEntries(
    TASK_IDENTITY_KEYS.map((key) => [key, opaque(value[key], `${label}.${key}`)]),
  );
  digest(
    normalized.workflowDefinitionDigest,
    `${label}.workflowDefinitionDigest`,
  );
  return normalized;
}

function normalizeTaskDispatch(value) {
  exact(value, ["dispatchId", "launchId", "task", "lease"], "Dispatch");
  exact(
    value.lease,
    ["leaseId", "assignmentId", "executorId", "slotId"],
    "Dispatch.lease",
  );
  return {
    dispatchId: opaque(value.dispatchId, "Dispatch.dispatchId"),
    launchId: opaque(value.launchId, "Dispatch.launchId"),
    task: normalizeTaskIdentity(value.task, "Dispatch.task"),
    lease: {
      leaseId: opaque(value.lease.leaseId, "Dispatch.lease.leaseId"),
      assignmentId: opaque(
        value.lease.assignmentId,
        "Dispatch.lease.assignmentId",
      ),
      executorId: opaque(value.lease.executorId, "Dispatch.lease.executorId"),
      slotId: opaque(value.lease.slotId, "Dispatch.lease.slotId"),
    },
  };
}

export function formatTaskDispatch(value) {
  return canonicalBody(TASK_DISPATCH_MARKER, normalizeTaskDispatch(value));
}

export function parseTaskDispatch(body) {
  return parseCanonicalBody(body, TASK_DISPATCH_MARKER, normalizeTaskDispatch);
}

export function deriveWorkGraphTaskResultId(taskId, dispatchId, leaseId) {
  for (const [label, value] of [
    ["taskId", taskId],
    ["dispatchId", dispatchId],
    ["leaseId", leaseId],
  ]) {
    opaque(value, label);
  }
  return `workgraph-v1:result:sha256:${framedSha256([
    taskId,
    dispatchId,
    leaseId,
  ])}`;
}

function normalizeTaskResult(value) {
  exact(
    value,
    ["resultId", "taskId", "dispatchId", "leaseId", "outcome", "output"],
    "Result",
  );
  for (const key of ["resultId", "taskId", "dispatchId", "leaseId"]) {
    opaque(value[key], `Result.${key}`);
  }
  if (!["succeeded", "failed", "cancelled"].includes(value.outcome)) {
    throw new WorkGraphReporterError(
      "Result.outcome must be succeeded, failed, or cancelled",
    );
  }
  if (
    value.resultId !==
    deriveWorkGraphTaskResultId(value.taskId, value.dispatchId, value.leaseId)
  ) {
    throw new WorkGraphReporterError("Result.resultId is not canonical");
  }
  return {
    resultId: value.resultId,
    taskId: value.taskId,
    dispatchId: value.dispatchId,
    leaseId: value.leaseId,
    outcome: value.outcome,
    output: canonicalJsonValue(value.output),
  };
}

export function formatTaskResult(value) {
  return canonicalBody(TASK_RESULT_MARKER, normalizeTaskResult(value));
}

export function parseTaskResult(body) {
  return parseCanonicalBody(body, TASK_RESULT_MARKER, normalizeTaskResult);
}

function framedSha256(parts) {
  const hash = createHash("sha256");
  for (const value of parts) {
    const bytes = Buffer.from(value, "utf8");
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(frame);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function deriveWorkGraphAdmissionId(rootIssueId, deliveryId) {
  opaque(rootIssueId, "rootIssueId");
  opaque(deliveryId, "deliveryId");
  const hash = createHash("sha256");
  hash.update("workgraph-v1-admission-generation\0", "utf8");
  hash.update(rootIssueId, "utf8");
  hash.update("\0", "utf8");
  hash.update(deliveryId, "utf8");
  return `wga-${hash.digest("hex")}`;
}

export function deriveWorkGraphRootIssueContentDigest(title, body) {
  if (typeof title !== "string" || (body !== null && typeof body !== "string")) {
    throw new WorkGraphReporterError(
      "Root Issue title and body must be strings or a null body",
    );
  }
  return `sha256:${framedSha256([
    "workgraph-v1-root-issue-content",
    title,
    body ?? "",
  ])}`;
}

export function deriveWorkGraphWorkflowRunId(
  repositoryNodeId,
  rootIssueId,
  admissionId,
  workflowDefinitionId,
  workflowDefinitionVersion,
  workflowDefinitionDigest,
) {
  for (const [label, value] of [
    ["repositoryNodeId", repositoryNodeId],
    ["rootIssueId", rootIssueId],
    ["admissionId", admissionId],
    ["workflowDefinitionId", workflowDefinitionId],
    ["workflowDefinitionVersion", workflowDefinitionVersion],
    ["workflowDefinitionDigest", workflowDefinitionDigest],
  ]) {
    opaque(value, label);
  }
  digest(workflowDefinitionDigest, "workflowDefinitionDigest");
  return `workgraph-v1:run:sha256:${framedSha256([
    repositoryNodeId,
    rootIssueId,
    admissionId,
    workflowDefinitionId,
    workflowDefinitionVersion,
    workflowDefinitionDigest,
  ])}`;
}

export function deriveWorkGraphRootTaskId(workflowRunId, rootTaskDefinitionId) {
  opaque(workflowRunId, "workflowRunId");
  opaque(rootTaskDefinitionId, "rootTaskDefinitionId");
  return `wgt-${framedSha256([workflowRunId, rootTaskDefinitionId]).slice(0, 60)}`;
}

export function resultBodyDigest(body) {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function validateTaskLocator(value) {
  exact(
    value,
    [
      "repositoryOwner",
      "repositoryName",
      "repositoryNodeId",
      "issueNumber",
      "issueNodeId",
      "parentIssueNumber",
      "parentIssueNodeId",
    ],
    "arguments.taskLocator",
  );
  if (value.repositoryOwner !== OWNER || value.repositoryName !== REPO) {
    throw new WorkGraphReporterError("taskLocator repository is not authorized");
  }
  opaque(value.repositoryNodeId, "taskLocator.repositoryNodeId");
  issueNumber(value.issueNumber, "taskLocator.issueNumber");
  opaque(value.issueNodeId, "taskLocator.issueNodeId");
  issueNumber(value.parentIssueNumber, "taskLocator.parentIssueNumber");
  opaque(value.parentIssueNodeId, "taskLocator.parentIssueNodeId");
  if (
    value.issueNumber === value.parentIssueNumber ||
    value.issueNodeId === value.parentIssueNodeId
  ) {
    throw new WorkGraphReporterError("taskLocator task and parent must differ");
  }
  return value;
}

function env(name) {
  const value = process.env[name] ?? "";
  if (!value) throw new WorkGraphReporterError(`${name} is required`);
  return value;
}

function envUserId(name) {
  const value = Number(env(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkGraphReporterError(`${name} must be a positive integer`);
  }
  return value;
}

function apiBaseUrl() {
  const configured = process.env.WORKGRAPH_TEST_GITHUB_API_URL;
  if (!configured) return API;
  if (process.env.NODE_ENV !== "test") {
    throw new WorkGraphReporterError("test GitHub API URL is forbidden outside tests");
  }
  const url = new URL(configured);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new WorkGraphReporterError("test GitHub API URL must be loopback HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateLeaseValidationUrl(value) {
  let url;
  try {
    url = new URL(value);
    const testLoopback =
      process.env.NODE_ENV === "test" &&
      url.protocol === "http:" &&
      ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
    if (
      (!testLoopback && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== LEASE_VALIDATION_PATH
    ) {
      throw new Error();
    }
  } catch {
    throw new WorkGraphReporterError(
      `lease validation URL must use ${LEASE_VALIDATION_PATH}`,
    );
  }
  return url.toString();
}

function configuration(toolName) {
  if (!["get_root_issue", "submit_task_result"].includes(toolName)) {
    throw new WorkGraphReporterError(`unknown tool ${toolName}`);
  }
  const taskTypeId = env("COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID");
  opaque(taskTypeId, "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID");
  const config = {
    token: env("COPILOT_MCP_WORKGRAPH_TOKEN"),
    taskTypeId,
    launcherId: envUserId("COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID"),
    resultId: envUserId("COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID"),
    api: apiBaseUrl(),
  };
  if (toolName === "submit_task_result") {
    return {
      ...config,
      assignmentId: envUserId(
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
      ),
      executorId: env("COPILOT_MCP_WORKGRAPH_EXECUTOR_ID"),
      leaseValidationToken: env(
        "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
      ),
      leaseValidationUrl: validateLeaseValidationUrl(
        env("COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL"),
      ),
    };
  }
  return config;
}

class GitHub {
  constructor(config) {
    this.config = config;
  }

  async request(method, route, payload, { allowNotFound = false } = {}) {
    let response;
    try {
      response = await fetch(`${this.config.api}${route}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "User-Agent": "drasi-workgraph-v1-reporter",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new WorkGraphReporterError(`GitHub request failed: ${error.message}`);
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new WorkGraphReporterError("GitHub response was not JSON");
      }
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new WorkGraphReporterError(
        `GitHub request failed with HTTP ${response.status}: ${body?.message ?? text}`,
      );
    }
    return body;
  }

  identity() {
    return this.request("GET", "/user");
  }

  repository() {
    return this.request("GET", `/repos/${OWNER}/${REPO}`);
  }

  issue(number) {
    return this.request("GET", `/repos/${OWNER}/${REPO}/issues/${number}`);
  }

  parent(number) {
    return this.request(
      "GET",
      `/repos/${OWNER}/${REPO}/issues/${number}/parent`,
    );
  }

  async comments(number) {
    const comments = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${OWNER}/${REPO}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new WorkGraphReporterError(
          "paginated GitHub comments response must be an array",
        );
      }
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
    throw new WorkGraphReporterError("GitHub comments pagination exceeded 100 pages");
  }

  postComment(number, body) {
    return this.request(
      "POST",
      `/repos/${OWNER}/${REPO}/issues/${number}/comments`,
      { body },
    );
  }
}

function verifyReporterIdentity(identity, expectedId) {
  if (
    !object(identity) ||
    identity.id !== expectedId ||
    typeof identity.login !== "string" ||
    identity.login.length === 0
  ) {
    throw new WorkGraphReporterError(
      "token identity does not match the configured Result reporter",
    );
  }
}

function verifyRepository(repository, repositoryNodeId) {
  if (
    !object(repository) ||
    repository.name !== REPO ||
    repository.owner?.login !== OWNER ||
    repository.node_id !== repositoryNodeId
  ) {
    throw new WorkGraphReporterError("taskLocator repository does not match GitHub");
  }
}

function taskIssue(issue, locator, config, label) {
  if (
    !object(issue) ||
    issue.number !== locator.issueNumber ||
    issue.node_id !== locator.issueNodeId ||
    issue.repository_url !== REPOSITORY_URL ||
    !["open", "closed"].includes(issue.state) ||
    issue.type?.name !== TASK_TYPE_NAME ||
    issue.type?.node_id !== config.taskTypeId ||
    issue.user?.id !== config.launcherId
  ) {
    throw new WorkGraphReporterError(
      `${label} is not a trusted WorkGraphTask Issue`,
    );
  }
  try {
    return parseRuntimeTask(issue.body);
  } catch {
    throw new WorkGraphReporterError(
      `${label} body is not canonical WorkGraphTask/v1`,
    );
  }
}

function validateTaskContract(task, label) {
  if (
    task.workflowDefinitionId !== WORKFLOW_DEFINITION_ID ||
    task.workflowDefinitionVersion !== WORKFLOW_DEFINITION_VERSION ||
    task.workflowDefinitionDigest !== WORKFLOW_DEFINITION_DIGEST ||
    ![ROOT_TASK_DEFINITION_ID, VALIDATOR_TASK_DEFINITION_ID].includes(
      task.taskDefinitionId,
    )
  ) {
    throw new WorkGraphReporterError(
      `${label} does not belong to the pinned v1 workflow`,
    );
  }
  if (task.taskDefinitionId === ROOT_TASK_DEFINITION_ID) {
    exact(task.resolvedInputs, ["proofMode", "rootIssue"], `${label} resolvedInputs`);
    if (task.resolvedInputs.proofMode !== "isolated") {
      throw new WorkGraphReporterError(`${label} proofMode must be isolated`);
    }
  } else {
    exact(
      task.resolvedInputs,
      ["validationProfile"],
      `${label} resolvedInputs`,
    );
    if (task.resolvedInputs.validationProfile !== "new-issue-default") {
      throw new WorkGraphReporterError(
        `${label} validationProfile is not canonical`,
      );
    }
  }
}

function linkedIssue(link, number, nodeId, label) {
  if (
    !object(link) ||
    link.number !== number ||
    link.node_id !== nodeId ||
    link.repository_url !== REPOSITORY_URL
  ) {
    throw new WorkGraphReporterError(`${label} does not match GitHub`);
  }
}

function hasAdmissionLabel(issue) {
  return (
    Array.isArray(issue?.labels) &&
    issue.labels.some((label) => object(label) && label.name === "workgraph")
  );
}

function ordinaryRootIssue(issue, number, nodeId, config) {
  if (
    !object(issue) ||
    issue.number !== number ||
    issue.node_id !== nodeId ||
    issue.repository_url !== REPOSITORY_URL ||
    issue.state !== "open" ||
    !hasAdmissionLabel(issue) ||
    issue.pull_request ||
    issue.type?.name === TASK_TYPE_NAME ||
    issue.type?.node_id === config.taskTypeId ||
    typeof issue.title !== "string" ||
    (issue.body !== null && typeof issue.body !== "string")
  ) {
    throw new WorkGraphReporterError(
      "Root Issue is missing, stale, or not an open ordinary Issue",
    );
  }
  return { ...issue, body: issue.body ?? "" };
}

function validateRootAdmission(rootTask, rootIssue, repositoryNodeId) {
  validateTaskContract(rootTask, "Root Task");
  if (rootTask.taskDefinitionId !== ROOT_TASK_DEFINITION_ID) {
    throw new WorkGraphReporterError("task ancestry does not reach the v1 Root Task");
  }
  const input = rootTask.resolvedInputs.rootIssue;
  exact(
    input,
    [
      "repositoryOwner",
      "repositoryName",
      "repositoryNodeId",
      "issueNumber",
      "issueNodeId",
      "admissionId",
      "contentDigest",
    ],
    "Root Task resolvedInputs.rootIssue",
  );
  if (
    input.repositoryOwner !== OWNER ||
    input.repositoryName !== REPO ||
    input.repositoryNodeId !== repositoryNodeId ||
    input.issueNumber !== rootIssue.number ||
    input.issueNodeId !== rootIssue.node_id ||
    rootTask.rootIssueId !== rootIssue.node_id
  ) {
    throw new WorkGraphReporterError(
      "Root Task does not identify the current Root Issue",
    );
  }
  opaque(input.admissionId, "Root Task rootIssue.admissionId");
  digest(input.contentDigest, "Root Task rootIssue.contentDigest");
  const currentDigest = deriveWorkGraphRootIssueContentDigest(
    rootIssue.title,
    rootIssue.body,
  );
  if (currentDigest !== input.contentDigest) {
    throw new WorkGraphReporterError(
      "Root Issue title or body changed after admission",
    );
  }
  const workflowRunId = deriveWorkGraphWorkflowRunId(
    repositoryNodeId,
    rootIssue.node_id,
    input.admissionId,
    rootTask.workflowDefinitionId,
    rootTask.workflowDefinitionVersion,
    rootTask.workflowDefinitionDigest,
  );
  if (
    rootTask.workflowRunId !== workflowRunId ||
    rootTask.taskId !==
      deriveWorkGraphRootTaskId(workflowRunId, rootTask.taskDefinitionId)
  ) {
    throw new WorkGraphReporterError(
      "Root Task does not match its v1 admission identity",
    );
  }
  return { input, currentDigest };
}

async function loadTaskContext(locator, taskId, github, config, includeComments) {
  const [identity, repository, issue, parentLink, comments] = await Promise.all([
    github.identity(),
    github.repository(),
    github.issue(locator.issueNumber),
    github.parent(locator.issueNumber),
    includeComments ? github.comments(locator.issueNumber) : Promise.resolve([]),
  ]);
  verifyReporterIdentity(identity, config.resultId);
  verifyRepository(repository, locator.repositoryNodeId);
  const task = taskIssue(issue, locator, config, "Task");
  validateTaskContract(task, "Task");
  if (task.taskId !== taskId) {
    throw new WorkGraphReporterError("taskId does not match WorkGraphTask/v1");
  }
  linkedIssue(
    parentLink,
    locator.parentIssueNumber,
    locator.parentIssueNodeId,
    "task native parent",
  );

  let rootTask;
  let rootTaskIssue;
  let rootIssue;
  if (task.taskDefinitionId === ROOT_TASK_DEFINITION_ID) {
    rootTask = task;
    rootTaskIssue = issue;
    const fullRootIssue = await github.issue(locator.parentIssueNumber);
    linkedIssue(
      fullRootIssue,
      locator.parentIssueNumber,
      locator.parentIssueNodeId,
      "Root Issue",
    );
    rootIssue = ordinaryRootIssue(
      fullRootIssue,
      locator.parentIssueNumber,
      locator.parentIssueNodeId,
      config,
    );
  } else {
    const rootTaskLocator = {
      issueNumber: locator.parentIssueNumber,
      issueNodeId: locator.parentIssueNodeId,
    };
    const fullRootTaskIssue = await github.issue(rootTaskLocator.issueNumber);
    rootTaskIssue = fullRootTaskIssue;
    linkedIssue(
      fullRootTaskIssue,
      rootTaskLocator.issueNumber,
      rootTaskLocator.issueNodeId,
      "Root Task",
    );
    rootTask = taskIssue(
      fullRootTaskIssue,
      {
        ...rootTaskLocator,
      },
      config,
      "Root Task",
    );
    const rootIssueLink = await github.parent(rootTaskLocator.issueNumber);
    if (!object(rootIssueLink)) {
      throw new WorkGraphReporterError("Root Task has no Root Issue parent");
    }
    const fullRootIssue = await github.issue(rootIssueLink.number);
    linkedIssue(
      rootIssueLink,
      fullRootIssue?.number,
      fullRootIssue?.node_id,
      "Root Task native parent",
    );
    rootIssue = ordinaryRootIssue(
      fullRootIssue,
      rootIssueLink.number,
      rootIssueLink.node_id,
      config,
    );
    if (
      task.rootIssueId !== rootTask.rootIssueId ||
      task.workflowRunId !== rootTask.workflowRunId
    ) {
      throw new WorkGraphReporterError(
        "task identity does not match its Root Task",
      );
    }
  }
  const admission = validateRootAdmission(
    rootTask,
    rootIssue,
    locator.repositoryNodeId,
  );
  return {
    task,
    rootTask,
    rootTaskIssue,
    rootIssue,
    admission,
    issue,
    comments,
  };
}

function markedComments(comments, marker, parser) {
  if (!Array.isArray(comments)) {
    throw new WorkGraphReporterError("GitHub comments response must be an array");
  }
  return comments
    .filter(
      (comment) =>
        object(comment) &&
        typeof comment.body === "string" &&
        comment.body.startsWith(`${marker}\n`),
    )
    .map((comment) => {
      if (
        typeof comment.created_at !== "string" ||
        comment.updated_at !== comment.created_at
      ) {
        throw new WorkGraphReporterError(
          `${marker} comment is edited or lacks immutable revision evidence`,
        );
      }
      return { comment, payload: parser(comment.body) };
    });
}

function resultContext(context, input, config, expectedBody) {
  const dispatches = markedComments(
    context.comments,
    TASK_DISPATCH_MARKER,
    parseTaskDispatch,
  );
  const expectedExecutor =
    context.task.taskDefinitionId === ROOT_TASK_DEFINITION_ID
      ? "issue-coordinator"
      : "issue-validator";
  if (config.executorId !== expectedExecutor) {
    throw new WorkGraphReporterError(
      "reporter executor profile is not authorized for this task",
    );
  }
  if (
    dispatches.length === 0 ||
    dispatches.some(
      ({ comment, payload }) =>
        !payload ||
        comment.user?.id !== config.assignmentId ||
        TASK_IDENTITY_KEYS.some(
          (key) => payload.task[key] !== context.task[key],
        ) ||
        payload.lease.executorId !== expectedExecutor,
    ) ||
    new Set(dispatches.map(({ payload }) => payload.dispatchId)).size !==
      dispatches.length ||
    new Set(dispatches.map(({ payload }) => payload.lease.leaseId)).size !==
      dispatches.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, or duplicate WorkGraphTaskDispatch/v1",
    );
  }
  const matchingDispatches = dispatches.filter(
    ({ payload }) =>
      payload.dispatchId === input.dispatchId &&
      payload.task.taskId === input.taskId &&
      payload.lease.leaseId === input.leaseId,
  );
  if (matchingDispatches.length !== 1) {
    throw new WorkGraphReporterError(
      "Dispatch task or Lease identity does not match",
    );
  }
  const dispatch = matchingDispatches[0].payload;

  const results = markedComments(
    context.comments,
    TASK_RESULT_MARKER,
    parseTaskResult,
  );
  if (
    results.some(
      ({ comment, payload }) =>
        !payload ||
        comment.user?.id !== config.resultId ||
        payload.taskId !== context.task.taskId ||
        !dispatches.some(
          ({ payload: candidate }) =>
            candidate.dispatchId === payload.dispatchId &&
            candidate.task.taskId === payload.taskId &&
            candidate.lease.leaseId === payload.leaseId,
        ),
    ) ||
    new Set(results.map(({ payload }) => payload.resultId)).size !== results.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, duplicate, or conflicting Result",
    );
  }
  const matchingResults = results.filter(
    ({ payload }) =>
      payload.taskId === input.taskId &&
      payload.dispatchId === input.dispatchId &&
      payload.leaseId === input.leaseId,
  );
  if (matchingResults.length > 0) {
    if (
      matchingResults.length !== 1 ||
      matchingResults[0].comment.body !== expectedBody
    ) {
      throw new WorkGraphReporterError(
        "task has a malformed, foreign, duplicate, or conflicting Result",
      );
    }
    return { dispatch, existing: matchingResults[0].comment };
  }
  if (
    context.issue.state !== "open" ||
    context.rootTaskIssue.state !== "open"
  ) {
    throw new WorkGraphReporterError(
      "a new Result requires open task and Root Task Issues",
    );
  }
  return { dispatch, existing: null };
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new WorkGraphReporterError(`${label} must be a UTC timestamp`);
  }
  return value;
}

function now() {
  const configured = process.env.WORKGRAPH_TEST_NOW;
  if (process.env.NODE_ENV === "test" && configured) {
    timestamp(configured, "WORKGRAPH_TEST_NOW");
    return Date.parse(configured);
  }
  return Date.now();
}

async function validateActiveLease(dispatch, claimId, config) {
  const expected = {
    taskId: dispatch.task.taskId,
    leaseId: dispatch.lease.leaseId,
    assignmentId: dispatch.lease.assignmentId,
    executorId: dispatch.lease.executorId,
    slotId: dispatch.lease.slotId,
    claimId,
  };
  let response;
  try {
    response = await fetch(config.leaseValidationUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.leaseValidationToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(expected),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new WorkGraphReporterError(
      `Source Lease validation request failed: ${error.message}`,
    );
  }
  if (!response.ok) {
    throw new WorkGraphReporterError(
      `Source Lease validation failed with HTTP ${response.status}`,
    );
  }
  let snapshot;
  try {
    snapshot = await response.json();
  } catch {
    throw new WorkGraphReporterError(
      "Source Lease validation response was not JSON",
    );
  }
  exact(
    snapshot,
    [...Object.keys(expected), "acquiredAt", "expiresAt"],
    "Source Lease validation response",
  );
  if (Object.entries(expected).some(([key, value]) => snapshot[key] !== value)) {
    throw new WorkGraphReporterError(
      "Source Lease validation response does not match the Dispatch",
    );
  }
  timestamp(snapshot.acquiredAt, "Source Lease acquiredAt");
  timestamp(snapshot.expiresAt, "Source Lease expiresAt");
  if (
    Date.parse(snapshot.acquiredAt) >= Date.parse(snapshot.expiresAt) ||
    now() >= Date.parse(snapshot.expiresAt)
  ) {
    throw new WorkGraphReporterError(
      "Source Lease is expired or has an invalid interval",
    );
  }
}

function verifiedComment(comment, expectedBody, expectedActorId) {
  if (
    !object(comment) ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    typeof comment.node_id !== "string" ||
    comment.node_id.length === 0 ||
    comment.body !== expectedBody ||
    comment.user?.id !== expectedActorId
  ) {
    throw new WorkGraphReporterError(
      "GitHub did not return the expected Result comment",
    );
  }
  return comment;
}

async function getRootIssue(input, github, config) {
  exact(input, ["taskLocator", "taskId"], "arguments");
  const locator = validateTaskLocator(input.taskLocator);
  opaque(input.taskId, "arguments.taskId");
  const context = await loadTaskContext(
    locator,
    input.taskId,
    github,
    config,
    false,
  );
  if (context.task.taskDefinitionId !== VALIDATOR_TASK_DEFINITION_ID) {
    throw new WorkGraphReporterError(
      "get_root_issue requires the validator child task",
    );
  }
  if (
    context.issue.state !== "open" ||
    context.rootTaskIssue.state !== "open"
  ) {
    throw new WorkGraphReporterError(
      "get_root_issue requires open validator and Root Task Issues",
    );
  }
  return {
    taskId: context.task.taskId,
    rootTaskId: context.rootTask.taskId,
    rootIssueId: context.rootIssue.node_id,
    workflowRunId: context.rootTask.workflowRunId,
    rootIssue: {
      repositoryOwner: OWNER,
      repositoryName: REPO,
      repositoryNodeId: locator.repositoryNodeId,
      issueNumber: context.rootIssue.number,
      issueNodeId: context.rootIssue.node_id,
      admissionId: context.admission.input.admissionId,
      contentDigest: context.admission.currentDigest,
      title: context.rootIssue.title,
      body: context.rootIssue.body,
    },
  };
}

async function submitTaskResult(input, github, config) {
  exact(
    input,
    ["taskLocator", "taskId", "dispatchId", "leaseId", "outcome", "output"],
    "arguments",
  );
  const locator = validateTaskLocator(input.taskLocator);
  for (const key of ["taskId", "dispatchId", "leaseId"]) {
    opaque(input[key], `arguments.${key}`);
  }
  if (!["succeeded", "failed"].includes(input.outcome)) {
    throw new WorkGraphReporterError(
      "arguments.outcome must be succeeded or failed",
    );
  }
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      input.taskId,
      input.dispatchId,
      input.leaseId,
    ),
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    leaseId: input.leaseId,
    outcome: input.outcome,
    output: canonicalJsonValue(input.output),
  };
  const body = formatTaskResult(result);
  const claimId = randomUUID();

  const read = async () => {
    const context = await loadTaskContext(
      locator,
      input.taskId,
      github,
      config,
      true,
    );
    return { context, ...resultContext(context, input, config, body) };
  };

  const initial = await read();
  if (initial.existing) {
    return {
      commentNodeId: initial.existing.node_id,
      resultId: result.resultId,
      resultBodyDigest: resultBodyDigest(body),
      reconciled: true,
    };
  }
  const before = await read();
  if (before.existing) {
    return {
      commentNodeId: before.existing.node_id,
      resultId: result.resultId,
      resultBodyDigest: resultBodyDigest(body),
      reconciled: true,
    };
  }
  await validateActiveLease(before.dispatch, claimId, config);
  const posted = verifiedComment(
    await github.postComment(locator.issueNumber, body),
    body,
    config.resultId,
  );
  const after = await read();
  if (
    !after.existing ||
    after.existing.id !== posted.id ||
    after.existing.node_id !== posted.node_id ||
    after.existing.body !== body
  ) {
    throw new WorkGraphReporterError("Result creation did not reconcile");
  }
  return {
    commentNodeId: posted.node_id,
    resultId: result.resultId,
    resultBodyDigest: resultBodyDigest(body),
    reconciled: false,
  };
}

function schema(properties) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

const locatorSchema = schema({
  repositoryOwner: { type: "string", const: OWNER },
  repositoryName: { type: "string", const: REPO },
  repositoryNodeId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  issueNumber: { type: "integer", minimum: 1 },
  issueNodeId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  parentIssueNumber: { type: "integer", minimum: 1 },
  parentIssueNodeId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
});

export const tools = [
  {
    name: "get_root_issue",
    description:
      "Return the admitted ordinary Root Issue after verifying its Root Task ancestry and immutable content digest.",
    inputSchema: schema({
      taskLocator: locatorSchema,
      taskId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
    }),
  },
  {
    name: "submit_task_result",
    description:
      "Create or reconcile one canonical WorkGraphTaskResult/v1 after validating the exact active Dispatch Lease.",
    inputSchema: schema({
      taskLocator: locatorSchema,
      taskId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
      dispatchId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
      leaseId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
      outcome: { type: "string", enum: ["succeeded", "failed"] },
      output: {},
    }),
  },
];

export async function callTool(name, args) {
  const config = configuration(name);
  const github = new GitHub(config);
  if (name === "get_root_issue") return getRootIssue(args, github, config);
  if (name === "submit_task_result") {
    return submitTaskResult(args, github, config);
  }
  throw new WorkGraphReporterError(`unknown tool ${name}`);
}

async function rpc(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "drasi-workgraph-v1-reporter", version: "1.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try {
      const structuredContent = await callTool(
        message.params?.name,
        message.params?.arguments ?? {},
      );
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown WorkGraph tool failure";
      if (process.env.NODE_ENV !== "test") {
        process.stderr.write(`[drasi-workgraph-v1-reporter] ${message}\n`);
      }
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }
  throw new WorkGraphReporterError(`unsupported method ${message.method}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = await rpc(request);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "unknown error",
          },
        })}\n`,
      );
    }
  });
}
