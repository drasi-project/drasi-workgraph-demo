#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { isDeepStrictEqual, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  TASK_EVALUATION_MARKER,
  TASK_ROUTE_MARKER,
  formatTaskEvaluation,
  formatTaskRoute,
  normalizeCompiledWorkflowDefinition,
  parseRuntimeTask,
  parseTaskEvaluation,
  parseTaskRoute,
  validateTaskRouteAgainstDefinition,
} from "./workgraph-v1-definition.mjs";

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
const MAX_ATTEMPT = 17;
const RUNTIME_ROUTE_POLICY = Object.freeze({
  error: true,
  ignore: true,
});
const TASK_IDENTITY_KEYS = [
  "taskId",
  "workflowRunId",
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
];
const COMPILED_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../workgraph/fixtures/v1/issue-lifecycle.expected.json", import.meta.url),
    "utf8",
  ),
);
const COMPILED_WORKFLOW = normalizeCompiledWorkflowDefinition(
  COMPILED_FIXTURE.workgraphDefinition,
);
if (
  COMPILED_FIXTURE.definitionDigest !== COMPILED_WORKFLOW.digest ||
  COMPILED_WORKFLOW.workflowDefinitionId !== "issue-lifecycle" ||
  COMPILED_WORKFLOW.version !== "v1"
) {
  throw new Error("pinned compiled WorkGraph fixture is inconsistent");
}

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
  exact(
    value,
    [
      "dispatchId",
      "launchId",
      "rootIssueId",
      "workflowRunId",
      "taskId",
      "task",
      "lease",
    ],
    "Dispatch",
  );
  exact(
    value.lease,
    ["leaseId", "assignmentId", "executorId", "slotId"],
    "Dispatch.lease",
  );
  const task = normalizeTaskIdentity(value.task, "Dispatch.task");
  const workflowRunId = opaque(
    value.workflowRunId,
    "Dispatch.workflowRunId",
  );
  const taskId = opaque(value.taskId, "Dispatch.taskId");
  if (workflowRunId !== task.workflowRunId || taskId !== task.taskId) {
    throw new WorkGraphReporterError(
      "Dispatch top-level identities must match Dispatch.task",
    );
  }
  return {
    dispatchId: opaque(value.dispatchId, "Dispatch.dispatchId"),
    launchId: opaque(value.launchId, "Dispatch.launchId"),
    rootIssueId: opaque(value.rootIssueId, "Dispatch.rootIssueId"),
    workflowRunId,
    taskId,
    task,
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
    [
      "resultId",
      "rootIssueId",
      "workflowRunId",
      "taskId",
      "dispatchId",
      "leaseId",
      "attempt",
      "outcome",
      "output",
    ],
    "Result",
  );
  for (const key of [
    "resultId",
    "rootIssueId",
    "workflowRunId",
    "taskId",
    "dispatchId",
    "leaseId",
  ]) {
    opaque(value[key], `Result.${key}`);
  }
  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > MAX_ATTEMPT
  ) {
    throw new WorkGraphReporterError(
      `Result.attempt must be an integer from 1 through ${MAX_ATTEMPT}`,
    );
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
    rootIssueId: value.rootIssueId,
    workflowRunId: value.workflowRunId,
    taskId: value.taskId,
    dispatchId: value.dispatchId,
    leaseId: value.leaseId,
    attempt: value.attempt,
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

export function canonicalResultJson(value) {
  const normalized = normalizeTaskResult(value);
  return compactCanonicalJson(normalized);
}

export function resultValueDigest(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalResultJson(value), "utf8")
    .digest("hex")}`;
}

function compactCanonicalJson(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(compactCanonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(utf8Compare)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${compactCanonicalJson(value[key])}`,
    )
    .join(",")}}`;
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
  const lifecycleTools = [
    "get_task_snapshot",
    "submit_task_evaluation",
    "submit_task_route",
  ];
  if (
    !["get_root_issue", "submit_task_result", ...lifecycleTools].includes(
      toolName,
    )
  ) {
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
  if (lifecycleTools.includes(toolName)) {
    const evaluatorId = process.env.COPILOT_MCP_WORKGRAPH_EVALUATOR_ID ?? "";
    const orchestratorId =
      process.env.COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID ?? "";
    if ((evaluatorId === "") === (orchestratorId === "")) {
      throw new WorkGraphReporterError(
        "exactly one evaluator or orchestrator profile identity is required",
      );
    }
    const role = evaluatorId ? "evaluator" : "orchestrator";
    if (
      (toolName === "submit_task_evaluation" && role !== "evaluator") ||
      (toolName === "submit_task_route" && role !== "orchestrator")
    ) {
      throw new WorkGraphReporterError(
        `${toolName} is not available to the configured lifecycle role`,
      );
    }
    return {
      ...config,
      role,
      lifecycleAgentId: evaluatorId || orchestratorId,
      assignmentId: envUserId(
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
      ),
      evaluationId: envUserId(
        "COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID",
      ),
      routeId: envUserId("COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID"),
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

  async subIssues(number) {
    const issues = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${OWNER}/${REPO}/issues/${number}/sub_issues?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new WorkGraphReporterError(
          "paginated GitHub sub-issues response must be an array",
        );
      }
      issues.push(...batch);
      if (batch.length < 100) return issues;
    }
    throw new WorkGraphReporterError(
      "GitHub sub-issues pagination exceeded 100 pages",
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

function verifyReporterIdentity(identity, expectedId, label = "Result reporter") {
  if (
    !object(identity) ||
    identity.id !== expectedId ||
    typeof identity.login !== "string" ||
    identity.login.length === 0
  ) {
    throw new WorkGraphReporterError(
      `token identity does not match the configured ${label}`,
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

function validateRootAdmission(
  rootTask,
  rootIssue,
  repositoryNodeId,
  {
    taskDefinitionId = ROOT_TASK_DEFINITION_ID,
    staticInputs = { proofMode: "isolated" },
    validateContract = true,
  } = {},
) {
  if (validateContract) validateTaskContract(rootTask, "Root Task");
  if (rootTask.taskDefinitionId !== taskDefinitionId) {
    throw new WorkGraphReporterError("task ancestry does not reach the v1 Root Task");
  }
  exact(
    rootTask.resolvedInputs,
    [...Object.keys(staticInputs), "rootIssue"],
    "Root Task resolvedInputs",
  );
  for (const [key, value] of Object.entries(staticInputs)) {
    if (!isDeepStrictEqual(rootTask.resolvedInputs[key], value)) {
      throw new WorkGraphReporterError(
        `Root Task resolvedInputs.${key} does not match the compiled definition`,
      );
    }
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
        !dispatchMatchesTask(payload, context.task) ||
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
  dispatches.sort((left, right) =>
    commentOrder(left.comment, right.comment),
  );
  const matchingDispatches = dispatches.filter(
    ({ payload }) =>
      payload.dispatchId === input.dispatchId &&
      payload.taskId === input.taskId &&
      payload.lease.leaseId === input.leaseId,
  );
  if (matchingDispatches.length !== 1) {
    throw new WorkGraphReporterError(
      "Dispatch task or Lease identity does not match",
    );
  }
  const dispatch = matchingDispatches[0].payload;
  if (dispatch !== dispatches.at(-1).payload) {
    throw new WorkGraphReporterError(
      "Dispatch and Lease are not the current selected attempt",
    );
  }
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
        payload.rootIssueId !== context.task.rootIssueId ||
        payload.workflowRunId !== context.task.workflowRunId ||
        payload.taskId !== context.task.taskId ||
        payload.resultId !==
          deriveWorkGraphTaskResultId(
            payload.taskId,
            payload.dispatchId,
            payload.leaseId,
          ) ||
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
      (expectedBody !== null &&
        matchingResults[0].comment.body !== expectedBody)
    ) {
      throw new WorkGraphReporterError(
        "task has a malformed, foreign, duplicate, or conflicting Result",
      );
    }
    return {
      dispatch,
      existing: matchingResults[0].comment,
      existingResult: matchingResults[0].payload,
    };
  }
  if (
    context.issue.state !== "open" ||
    context.rootTaskIssue.state !== "open"
  ) {
    throw new WorkGraphReporterError(
      "a new Result requires open task and Root Task Issues",
    );
  }
  return { dispatch, existing: null, existingResult: null };
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
    taskId: dispatch.taskId,
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
    [...Object.keys(expected), "attempt", "acquiredAt", "expiresAt"],
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
    !Number.isSafeInteger(snapshot.attempt) ||
    snapshot.attempt < 1 ||
    snapshot.attempt > MAX_ATTEMPT
  ) {
    throw new WorkGraphReporterError(
      `Source Lease attempt must be an integer from 1 through ${MAX_ATTEMPT}`,
    );
  }
  if (
    Date.parse(snapshot.acquiredAt) >= Date.parse(snapshot.expiresAt) ||
    now() >= Date.parse(snapshot.expiresAt)
  ) {
    throw new WorkGraphReporterError(
      "Source Lease is expired or has an invalid interval",
    );
  }
  return snapshot.attempt;
}

function verifiedComment(
  comment,
  expectedBody,
  expectedActorId,
  label = "Result",
) {
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
      `GitHub did not return the expected ${label} comment`,
    );
  }
  return comment;
}

const LIFECYCLE_CONTEXT_KEYS = [
  "taskLocator",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "dispatchId",
  "leaseId",
  "resultId",
  "attempt",
];

function sameTaskIdentity(left, right) {
  return TASK_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function dispatchMatchesTask(dispatch, task) {
  return (
    dispatch.rootIssueId === task.rootIssueId &&
    dispatch.workflowRunId === task.workflowRunId &&
    dispatch.taskId === task.taskId &&
    sameTaskIdentity(dispatch.task, task)
  );
}

function compiledSource(taskDefinitionId) {
  const matches = Object.entries(COMPILED_WORKFLOW.steps).filter(
    ([, step]) =>
      step.type === "task" && taskDefinitionId in step.executionPolicies,
  );
  if (matches.length !== 1) {
    throw new WorkGraphReporterError(
      "taskDefinitionId does not identify one pinned compiled source step",
    );
  }
  const [sourceStepId, source] = matches[0];
  let parentTaskDefinitionId = null;
  const findParent = (task, parentId = null) => {
    if (task.taskDefinitionId === taskDefinitionId) {
      parentTaskDefinitionId = parentId;
      return true;
    }
    return task.children.some((child) =>
      findParent(child, task.taskDefinitionId),
    );
  };
  findParent(source.taskDefinition);
  return {
    sourceStepId,
    source,
    policy: source.executionPolicies[taskDefinitionId],
    isStepRoot: source.taskDefinition.taskDefinitionId === taskDefinitionId,
    parentTaskDefinitionId,
  };
}

function validateLifecycleTask(task, label) {
  if (
    task.workflowDefinitionId !== COMPILED_WORKFLOW.workflowDefinitionId ||
    task.workflowDefinitionVersion !== COMPILED_WORKFLOW.version ||
    task.workflowDefinitionDigest !== COMPILED_WORKFLOW.digest
  ) {
    throw new WorkGraphReporterError(
      `${label} does not belong to the pinned compiled workflow`,
    );
  }
  return compiledSource(task.taskDefinitionId);
}

function validateLifecycleContextInput(input, extraKeys = []) {
  exact(input, [...LIFECYCLE_CONTEXT_KEYS, ...extraKeys], "arguments");
  const locator = validateTaskLocator(input.taskLocator);
  for (const key of [
    "rootIssueId",
    "workflowRunId",
    "taskId",
    "dispatchId",
    "leaseId",
    "resultId",
  ]) {
    opaque(input[key], `arguments.${key}`);
  }
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > MAX_ATTEMPT
  ) {
    throw new WorkGraphReporterError(
      `arguments.attempt must be an integer from 1 through ${MAX_ATTEMPT}`,
    );
  }
  return locator;
}

function commentOrder(left, right) {
  const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
  return byTime || left.id - right.id;
}

function validateProtocolComment(entry, actorId, marker) {
  const { comment, payload } = entry;
  if (
    !payload ||
    comment.user?.id !== actorId ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    typeof comment.node_id !== "string" ||
    comment.node_id.length === 0
  ) {
    throw new WorkGraphReporterError(
      `task has a malformed or foreign ${marker}`,
    );
  }
  timestamp(comment.created_at, `${marker} created_at`);
  return entry;
}

async function loadLifecycleAncestry(
  locator,
  input,
  github,
  config,
  requireOpen = true,
) {
  const [identity, repository, issue, parentLink, comments] = await Promise.all([
    github.identity(),
    github.repository(),
    github.issue(locator.issueNumber),
    github.parent(locator.issueNumber),
    github.comments(locator.issueNumber),
  ]);
  verifyReporterIdentity(
    identity,
    config.role === "evaluator" ? config.evaluationId : config.routeId,
    `${config.role} reporter`,
  );
  verifyRepository(repository, locator.repositoryNodeId);
  const task = taskIssue(issue, locator, config, "Task");
  const compiled = validateLifecycleTask(task, "Task");
  if (requireOpen && issue.state !== "open") {
    throw new WorkGraphReporterError("lifecycle reporting requires an open Task");
  }
  if (
    task.rootIssueId !== input.rootIssueId ||
    task.workflowRunId !== input.workflowRunId ||
    task.taskId !== input.taskId
  ) {
    throw new WorkGraphReporterError(
      "rootIssueId, workflowRunId, and taskId must directly match the Task",
    );
  }
  linkedIssue(
    parentLink,
    locator.parentIssueNumber,
    locator.parentIssueNodeId,
    "task native parent",
  );

  let rootIssueCandidate;
  if (compiled.isStepRoot) {
    rootIssueCandidate = await github.issue(parentLink.number);
    linkedIssue(
      rootIssueCandidate,
      parentLink.number,
      parentLink.node_id,
      "top-level task Root Issue parent",
    );
  } else {
    let expectedParentDefinitionId = compiled.parentTaskDefinitionId;
    let ancestorLink = parentLink;
    for (let depth = 0; depth <= 5; depth += 1) {
      const ancestorIssue = await github.issue(ancestorLink.number);
      linkedIssue(
        ancestorIssue,
        ancestorLink.number,
        ancestorLink.node_id,
        "recursive task ancestor",
      );
      if (ancestorIssue.type?.name !== TASK_TYPE_NAME) {
        throw new WorkGraphReporterError(
          "recursive task ancestry ended before its compiled step root",
        );
      }
      if (requireOpen && ancestorIssue.state !== "open") {
        throw new WorkGraphReporterError(
          "lifecycle reporting requires an open recursive task ancestry",
        );
      }
      const ancestor = taskIssue(
        ancestorIssue,
        {
          issueNumber: ancestorIssue.number,
          issueNodeId: ancestorIssue.node_id,
        },
        config,
        "Recursive task ancestor",
      );
      const ancestorCompiled = validateLifecycleTask(
        ancestor,
        "Recursive task ancestor",
      );
      if (
        ancestor.taskDefinitionId !== expectedParentDefinitionId ||
        ancestor.rootIssueId !== task.rootIssueId ||
        ancestor.workflowRunId !== task.workflowRunId ||
        ancestor.workflowDefinitionId !== task.workflowDefinitionId ||
        ancestor.workflowDefinitionVersion !==
          task.workflowDefinitionVersion ||
        ancestor.workflowDefinitionDigest !== task.workflowDefinitionDigest
      ) {
        throw new WorkGraphReporterError(
          "recursive task ancestry does not match its compiled parent chain",
        );
      }
      const nextLink = await github.parent(ancestorIssue.number);
      if (ancestorCompiled.isStepRoot) {
        rootIssueCandidate = await github.issue(nextLink.number);
        linkedIssue(
          rootIssueCandidate,
          nextLink.number,
          nextLink.node_id,
          "top-level task Root Issue parent",
        );
        break;
      }
      expectedParentDefinitionId = ancestorCompiled.parentTaskDefinitionId;
      ancestorLink = nextLink;
    }
  }
  if (!rootIssueCandidate) {
    throw new WorkGraphReporterError(
      "Task ancestry does not reach its ordinary Root Issue",
    );
  }
  const rootIssue = ordinaryRootIssue(
    rootIssueCandidate,
    rootIssueCandidate.number,
    task.rootIssueId,
    config,
  );
  const rootChildren = await github.subIssues(rootIssue.number);
  const initialTasks = [];
  for (const child of rootChildren) {
    if (
      child?.type?.name !== TASK_TYPE_NAME ||
      child?.type?.node_id !== config.taskTypeId ||
      child?.user?.id !== config.launcherId
    ) {
      continue;
    }
    const candidate = taskIssue(
      child,
      { issueNumber: child.number, issueNodeId: child.node_id },
      config,
      "Initial Task candidate",
    );
    if (
      candidate.taskDefinitionId ===
        COMPILED_WORKFLOW.root.taskDefinitionId &&
      candidate.rootIssueId === task.rootIssueId &&
      candidate.workflowRunId === task.workflowRunId
    ) {
      initialTasks.push({ issue: child, task: candidate });
    }
  }
  if (initialTasks.length !== 1) {
    throw new WorkGraphReporterError(
      "Root Issue must have exactly one matching initial Task",
    );
  }
  const [{ issue: rootTaskIssue, task: rootTask }] = initialTasks;
  if (
    rootTask.taskDefinitionId !== COMPILED_WORKFLOW.root.taskDefinitionId ||
    rootTask.rootIssueId !== input.rootIssueId ||
    rootTask.workflowRunId !== input.workflowRunId
  ) {
    throw new WorkGraphReporterError("Initial Task direct identities do not match");
  }
  const admission = validateRootAdmission(
    rootTask,
    rootIssue,
    locator.repositoryNodeId,
    {
      taskDefinitionId: COMPILED_WORKFLOW.root.taskDefinitionId,
      staticInputs: COMPILED_WORKFLOW.root.staticInputs,
      validateContract: false,
    },
  );
  if (
    config.role === "evaluator" &&
    config.lifecycleAgentId !== compiled.policy.evaluatorId
  ) {
    throw new WorkGraphReporterError(
      "configured evaluator does not match the effective compiled policy",
    );
  }
  if (
    config.role === "orchestrator" &&
    config.lifecycleAgentId !== compiled.policy.orchestratorId
  ) {
    throw new WorkGraphReporterError(
      "configured orchestrator does not match the effective compiled policy",
    );
  }
  return {
    issue,
    task,
    comments,
    rootTask,
    rootTaskIssue,
    rootIssue,
    admission,
    ...compiled,
  };
}

function lifecycleArtifacts(context, input, config, requireCurrent = true) {
  const dispatches = markedComments(
    context.comments,
    TASK_DISPATCH_MARKER,
    parseTaskDispatch,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_DISPATCH_MARKER),
  );
  if (
    dispatches.length === 0 ||
    dispatches.some(
      ({ payload }) =>
        !dispatchMatchesTask(payload, context.task) ||
        payload.lease.executorId !== context.policy.workerId,
    ) ||
    new Set(dispatches.map(({ payload }) => payload.dispatchId)).size !==
      dispatches.length ||
    new Set(dispatches.map(({ payload }) => payload.lease.leaseId)).size !==
      dispatches.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, or duplicate Dispatch",
    );
  }
  dispatches.sort((left, right) =>
    commentOrder(left.comment, right.comment),
  );
  const selectedDispatches = dispatches.filter(
    ({ payload }) =>
      payload.dispatchId === input.dispatchId &&
      payload.lease.leaseId === input.leaseId,
  );
  if (
    selectedDispatches.length !== 1 ||
    (requireCurrent &&
      selectedDispatches[0] !== dispatches.at(-1))
  ) {
    throw new WorkGraphReporterError(
      "Dispatch and Lease are stale or not the current selected attempt",
    );
  }
  const selectedEntry = selectedDispatches[0];
  const currentDispatch = selectedEntry.payload;

  const results = markedComments(
    context.comments,
    TASK_RESULT_MARKER,
    parseTaskResult,
  ).map((entry) =>
    validateProtocolComment(entry, config.resultId, TASK_RESULT_MARKER),
  );
  if (
    results.some(
      ({ payload }) =>
        payload.rootIssueId !== context.task.rootIssueId ||
        payload.workflowRunId !== context.task.workflowRunId ||
        payload.taskId !== context.task.taskId ||
        payload.resultId !==
          deriveWorkGraphTaskResultId(
            payload.taskId,
            payload.dispatchId,
            payload.leaseId,
          ) ||
        !dispatches.some(
          ({ payload: dispatch }) =>
            dispatch.dispatchId === payload.dispatchId &&
            dispatch.lease.leaseId === payload.leaseId,
        ),
    ) ||
    new Set(results.map(({ payload }) => payload.resultId)).size !==
      results.length ||
    new Set(
      results.map(
        ({ payload }) =>
          `${payload.taskId}\0${payload.dispatchId}\0${payload.leaseId}`,
      ),
    ).size !== results.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, duplicate, or conflicting Result",
    );
  }
  const currentResults = results.filter(
    ({ payload }) =>
      payload.dispatchId === currentDispatch.dispatchId &&
      payload.leaseId === currentDispatch.lease.leaseId,
  );
  if (
    currentResults.length !== 1 ||
    currentResults[0].payload.resultId !== input.resultId
  ) {
    throw new WorkGraphReporterError(
      "Result is missing, stale, duplicate, or not bound to the current attempt",
    );
  }
  const result = currentResults[0];
  const attempt = result.payload.attempt;
  if (attempt > context.policy.maxReworkAttempts + 1) {
    throw new WorkGraphReporterError(
      "current Result attempt exceeds the effective compiled rework policy",
    );
  }
  if (input.attempt !== attempt) {
    throw new WorkGraphReporterError(
      "attempt does not match the authoritative current Result attempt",
    );
  }
  const resultDigest = resultValueDigest(result.payload);

  const evaluations = markedComments(
    context.comments,
    TASK_EVALUATION_MARKER,
    parseTaskEvaluation,
  ).map((entry) =>
    validateProtocolComment(
      entry,
      config.evaluationId,
      TASK_EVALUATION_MARKER,
    ),
  );
  const evaluationResults = new Map(
    results.map((entry) => [entry.payload.resultId, entry]),
  );
  if (
    evaluations.some(({ payload }) => {
      const referenced = evaluationResults.get(payload.resultId);
      return (
        payload.rootIssueId !== context.task.rootIssueId ||
        payload.workflowRunId !== context.task.workflowRunId ||
        payload.taskId !== context.task.taskId ||
        payload.evaluatorId !== context.policy.evaluatorId ||
        !referenced ||
        payload.attempt !== referenced?.payload.attempt ||
        payload.resultDigest !== resultValueDigest(referenced.payload)
      );
    }) ||
    new Set(evaluations.map(({ payload }) => payload.evaluationId)).size !==
      evaluations.length ||
    new Set(evaluations.map(({ payload }) => payload.resultId)).size !==
      evaluations.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, duplicate, or conflicting Evaluation",
    );
  }
  const currentEvaluation =
    evaluations.find(({ payload }) => payload.resultId === input.resultId) ??
    null;

  const routes = markedComments(
    context.comments,
    TASK_ROUTE_MARKER,
    parseTaskRoute,
  ).map((entry) =>
    validateProtocolComment(entry, config.routeId, TASK_ROUTE_MARKER),
  );
  const evaluationById = new Map(
    evaluations.map((entry) => [entry.payload.evaluationId, entry.payload]),
  );
  if (
    routes.some(({ payload }) => {
      const evaluation = evaluationById.get(payload.evaluationId);
      const referenced = evaluation
        ? evaluationResults.get(evaluation.resultId)
        : null;
      if (
        !evaluation ||
        !referenced ||
        payload.rootIssueId !== context.task.rootIssueId ||
        payload.workflowRunId !== context.task.workflowRunId ||
        payload.taskId !== context.task.taskId ||
        payload.resultId !== evaluation.resultId ||
        payload.evaluationVerdict !== evaluation.verdict ||
        payload.attempt !== evaluation.attempt ||
        payload.orchestratorId !== context.policy.orchestratorId
      ) {
        return true;
      }
      try {
        validateTaskRouteAgainstDefinition(payload, COMPILED_WORKFLOW, {
          sourceStepId: context.sourceStepId,
          taskDefinitionId: context.task.taskDefinitionId,
        });
      } catch {
        return true;
      }
      const plan = authorizedRoutePlan(
        context,
        referenced.payload,
        evaluation.verdict,
        evaluation.attempt,
      );
      if (!plan.actions.includes(payload.action)) return true;
      if (
        payload.action === "advance" &&
        !plan.transitions.some((choice) =>
          isDeepStrictEqual(choice, {
            transitionKind: payload.transitionKind,
            ...("outcome" in payload ? { outcome: payload.outcome } : {}),
            targetStepId: payload.targetStepId,
            targetStepKind: payload.targetStepKind,
            ...("targetTaskDefinitionId" in payload
              ? {
                  targetTaskDefinitionId:
                    payload.targetTaskDefinitionId,
                }
              : {}),
          }),
        )
      ) {
        return true;
      }
      return false;
    }) ||
    new Set(routes.map(({ payload }) => payload.routeId)).size !== routes.length ||
    new Set(routes.map(({ payload }) => payload.evaluationId)).size !==
      routes.length
  ) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, duplicate, or conflicting Route",
    );
  }
  const currentRoute = currentEvaluation
    ? (routes.find(
        ({ payload }) =>
          payload.evaluationId === currentEvaluation.payload.evaluationId,
      ) ?? null)
    : null;
  return {
    currentDispatch,
    attempt,
    result,
    resultDigest,
    reworkCount: attempt - 1,
    currentEvaluation,
    currentRoute,
  };
}

async function readLifecycleContext(
  input,
  github,
  config,
  extraKeys = [],
  requireOpen = true,
  requireCurrent = true,
) {
  const locator = validateLifecycleContextInput(input, extraKeys);
  const context = await loadLifecycleAncestry(
    locator,
    input,
    github,
    config,
    requireOpen,
  );
  return {
    locator,
    context,
    artifacts: lifecycleArtifacts(context, input, config, requireCurrent),
  };
}

function transitionChoices(context, result) {
  if (!context.isStepRoot) return [];
  const transition = context.source.transition;
  if (transition.type === "next") {
    return [routeTarget("next", null, transition.targetStepId)];
  }
  const outcome = result.output?.outcome;
  if (
    typeof outcome !== "string" ||
    !(outcome in transition.targets)
  ) {
    return [];
  }
  return [
    routeTarget("outcome", outcome, transition.targets[outcome]),
  ];
}

function routeTarget(transitionKind, outcome, targetStepId) {
  const target = COMPILED_WORKFLOW.steps[targetStepId];
  const choice = {
    transitionKind,
    targetStepId,
    targetStepKind: target.type,
  };
  if (outcome !== null) choice.outcome = outcome;
  if (target.type === "task") {
    choice.targetTaskDefinitionId = target.taskDefinition.taskDefinitionId;
  }
  return choice;
}

function authorizedRoutePlan(context, result, verdict, attempt) {
  const transitions =
    verdict === "accepted" ? transitionChoices(context, result) : [];
  const actions = [];
  if (verdict === "accepted") {
    if (transitions.length > 0) actions.push("advance");
    if (
      !context.isStepRoot ||
      transitions.some(
        ({ targetStepId }) =>
          COMPILED_WORKFLOW.steps[targetStepId]?.type === "terminal" &&
          COMPILED_WORKFLOW.steps[targetStepId].outcome === "completed",
      )
    ) {
      actions.push("complete");
    }
  } else if (attempt - 1 < context.policy.maxReworkAttempts) {
    actions.push("rework");
  }
  if (RUNTIME_ROUTE_POLICY.error) actions.push("error");
  if (RUNTIME_ROUTE_POLICY.ignore) actions.push("ignore");
  return { actions, transitions };
}

function lifecycleSnapshot(context, artifacts, config) {
  const common = {
    rootIssueId: context.task.rootIssueId,
    workflowRunId: context.task.workflowRunId,
    taskId: context.task.taskId,
    taskDefinitionId: context.task.taskDefinitionId,
    sourceStepId: context.sourceStepId,
    dispatchId: artifacts.currentDispatch.dispatchId,
    leaseId: artifacts.currentDispatch.lease.leaseId,
    assignmentId: artifacts.currentDispatch.lease.assignmentId,
    result: artifacts.result.payload,
    resultDigest: artifacts.resultDigest,
    attempt: artifacts.attempt,
    reworkCount: artifacts.reworkCount,
    maxReworkAttempts: context.policy.maxReworkAttempts,
  };
  if (config.role === "evaluator") {
    return {
      ...common,
      evaluatorId: context.policy.evaluatorId,
      authorizedVerdicts: ["accepted", "rejected"],
      existingEvaluation: artifacts.currentEvaluation?.payload ?? null,
    };
  }
  if (!artifacts.currentEvaluation) {
    throw new WorkGraphReporterError(
      "the current Result has no canonical Evaluation",
    );
  }
  const verdict = artifacts.currentEvaluation.payload.verdict;
  const plan = authorizedRoutePlan(
    context,
    artifacts.result.payload,
    verdict,
    artifacts.attempt,
  );
  return {
    ...common,
    evaluation: artifacts.currentEvaluation.payload,
    orchestratorId: context.policy.orchestratorId,
    authorizedActions: plan.actions,
    authorizedTransitions: plan.transitions,
    existingRoute: artifacts.currentRoute?.payload ?? null,
  };
}

async function getTaskSnapshot(input, github, config) {
  const { context, artifacts } = await readLifecycleContext(
    input,
    github,
    config,
  );
  return lifecycleSnapshot(context, artifacts, config);
}

export function deriveWorkGraphArtifactClaimId(
  artifactKind,
  taskId,
  subjectId,
) {
  if (!["evaluation", "route"].includes(artifactKind)) {
    throw new WorkGraphReporterError(
      "artifactKind must be evaluation or route",
    );
  }
  opaque(taskId, "artifact claim taskId");
  opaque(subjectId, "artifact claim subjectId");
  return `workgraph-v1:claim:sha256:${framedSha256([
    artifactKind,
    taskId,
    subjectId,
  ])}`;
}

const lifecycleClaims = new Map();

async function reconcileLifecycleComment({
  readAny,
  readOpen,
  existing,
  body,
  github,
  issueNumber: number,
  actorId,
  id,
  kind,
  artifactKind,
  taskId,
  subjectId,
}) {
  const claimId = deriveWorkGraphArtifactClaimId(
    artifactKind,
    taskId,
    subjectId,
  );
  const pending = lifecycleClaims.get(claimId);
  if (pending) {
    if (pending.body !== body) {
      throw new WorkGraphReporterError(
        `artifact claim is already held for a conflicting ${kind}`,
      );
    }
    const claimed = await pending.promise;
    return { ...claimed, reconciled: true };
  }
  const promise = (async () => {
    for (const read of [readAny, readAny, readOpen]) {
      const state = await read();
      const found = existing(state);
      if (!found) continue;
      if (found.comment.body !== body) {
        throw new WorkGraphReporterError(
          `task has a conflicting canonical ${kind}`,
        );
      }
      return {
        commentNodeId: found.comment.node_id,
        [`${id}Id`]: found.payload[`${id}Id`],
        reconciled: true,
        claimId,
      };
    }
    const posted = verifiedComment(
      await github.postComment(number, body),
      body,
      actorId,
      kind,
    );
    const after = await readAny();
    const reconciled = existing(after);
    if (
      !reconciled ||
      reconciled.comment.id !== posted.id ||
      reconciled.comment.node_id !== posted.node_id
    ) {
      throw new WorkGraphReporterError(`${kind} creation did not reconcile`);
    }
    return {
      commentNodeId: posted.node_id,
      [`${id}Id`]: reconciled.payload[`${id}Id`],
      reconciled: false,
      claimId,
    };
  })();
  lifecycleClaims.set(claimId, { body, promise });
  try {
    return await promise;
  } finally {
    if (lifecycleClaims.get(claimId)?.promise === promise) {
      lifecycleClaims.delete(claimId);
    }
  }
}

async function submitTaskEvaluation(input, github, config) {
  const extra = ["evaluationId", "verdict", "summary", "feedback"];
  const readAny = () =>
    readLifecycleContext(input, github, config, extra, false, false);
  const readOpen = () =>
    readLifecycleContext(input, github, config, extra, true);
  const initial = await readAny();
  if (
    initial.artifacts.currentEvaluation &&
    initial.artifacts.currentEvaluation.payload.evaluationId !==
      input.evaluationId
  ) {
    throw new WorkGraphReporterError(
      "the current Result already has a conflicting Evaluation or Route",
    );
  }
  const evaluation = {
    evaluationId: opaque(input.evaluationId, "arguments.evaluationId"),
    rootIssueId: input.rootIssueId,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    resultId: input.resultId,
    resultDigest: initial.artifacts.resultDigest,
    evaluatorId: initial.context.policy.evaluatorId,
    attempt: initial.artifacts.attempt,
    verdict: input.verdict,
    summary: input.summary,
    feedback: input.feedback,
  };
  const body = formatTaskEvaluation(evaluation);
  const outcome = await reconcileLifecycleComment({
    readAny,
    readOpen,
    existing: ({ artifacts }) => artifacts.currentEvaluation,
    body,
    github,
    issueNumber: initial.locator.issueNumber,
    actorId: config.evaluationId,
    id: "evaluation",
    kind: "Evaluation",
    artifactKind: "evaluation",
    taskId: evaluation.taskId,
    subjectId: evaluation.resultId,
  });
  return { ...outcome, resultDigest: initial.artifacts.resultDigest };
}

function routeFromInput(input, context, evaluation) {
  const route = {
    routeId: opaque(input.routeId, "arguments.routeId"),
    rootIssueId: input.rootIssueId,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    resultId: input.resultId,
    evaluationId: input.evaluationId,
    evaluationVerdict: evaluation.verdict,
    orchestratorId: context.policy.orchestratorId,
    action: input.action,
  };
  for (const key of [
    "transitionKind",
    "targetStepId",
    "targetStepKind",
    "outcome",
    "targetTaskDefinitionId",
  ]) {
    if (key in input) route[key] = input[key];
  }
  route.attempt = input.attempt;
  return route;
}

async function submitTaskRoute(input, github, config) {
  if (!object(input) || typeof input.action !== "string") {
    throw new WorkGraphReporterError("arguments.action is required");
  }
  const transitionKeys =
    input.action === "advance"
      ? [
          "transitionKind",
          "targetStepId",
          "targetStepKind",
          ...("outcome" in input ? ["outcome"] : []),
          ...("targetTaskDefinitionId" in input
            ? ["targetTaskDefinitionId"]
            : []),
        ]
      : [];
  const extra = ["evaluationId", "routeId", "action", ...transitionKeys];
  const readAny = () =>
    readLifecycleContext(input, github, config, extra, false, false);
  const readOpen = () =>
    readLifecycleContext(input, github, config, extra, true);
  const initial = await readAny();
  const evaluation = initial.artifacts.currentEvaluation?.payload;
  if (!evaluation || evaluation.evaluationId !== input.evaluationId) {
    throw new WorkGraphReporterError(
      "Evaluation is stale or not the current Result Evaluation",
    );
  }
  if (
    initial.artifacts.currentRoute &&
    initial.artifacts.currentRoute.payload.routeId !== input.routeId
  ) {
    throw new WorkGraphReporterError(
      "the current Evaluation already has a conflicting Route",
    );
  }
  const route = routeFromInput(input, initial.context, evaluation);
  validateTaskRouteAgainstDefinition(route, COMPILED_WORKFLOW, {
    sourceStepId: initial.context.sourceStepId,
    taskDefinitionId: initial.context.task.taskDefinitionId,
  });
  const snapshot = lifecycleSnapshot(
    initial.context,
    initial.artifacts,
    config,
  );
  if (!snapshot.authorizedActions.includes(route.action)) {
    throw new WorkGraphReporterError(
      "Route action is not authorized for the current verdict and attempt",
    );
  }
  if (
    route.action === "advance" &&
    !snapshot.authorizedTransitions.some((choice) =>
      isDeepStrictEqual(choice, {
        transitionKind: route.transitionKind,
        ...("outcome" in route ? { outcome: route.outcome } : {}),
        targetStepId: route.targetStepId,
        targetStepKind: route.targetStepKind,
        ...("targetTaskDefinitionId" in route
          ? { targetTaskDefinitionId: route.targetTaskDefinitionId }
          : {}),
      }),
    )
  ) {
    throw new WorkGraphReporterError(
      "Route transition is not one of the bounded compiled choices",
    );
  }
  const body = formatTaskRoute(route);
  const outcome = await reconcileLifecycleComment({
    readAny,
    readOpen,
    existing: ({ artifacts }) => artifacts.currentRoute,
    body,
    github,
    issueNumber: initial.locator.issueNumber,
    actorId: config.routeId,
    id: "route",
    kind: "Route",
    artifactKind: "route",
    taskId: route.taskId,
    subjectId: route.evaluationId,
  });
  return {
    ...outcome,
    rework:
      route.action === "rework"
        ? {
            taskId: input.taskId,
            assignmentId: initial.artifacts.currentDispatch.lease.assignmentId,
            attempt: route.attempt + 1,
            feedback: evaluation.feedback,
          }
        : null,
  };
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
  const output = canonicalJsonValue(input.output);
  const initialContext = await loadTaskContext(
    locator,
    input.taskId,
    github,
    config,
    true,
  );
  const selected = resultContext(
    initialContext,
    input,
    config,
    null,
  );
  if (selected.existing) {
    if (
      selected.existingResult.outcome !== input.outcome ||
      !isDeepStrictEqual(selected.existingResult.output, output)
    ) {
      throw new WorkGraphReporterError(
        "task has a conflicting canonical Result",
      );
    }
    return {
      commentNodeId: selected.existing.node_id,
      resultId: selected.existingResult.resultId,
      resultDigest: resultValueDigest(selected.existingResult),
      reconciled: true,
    };
  }
  const claimId = randomUUID();
  const attempt = await validateActiveLease(
    selected.dispatch,
    claimId,
    config,
  );
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      input.taskId,
      input.dispatchId,
      input.leaseId,
    ),
    rootIssueId: initialContext.task.rootIssueId,
    workflowRunId: initialContext.task.workflowRunId,
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    leaseId: input.leaseId,
    attempt,
    outcome: input.outcome,
    output,
  };
  const body = formatTaskResult(result);

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

  const before = await read();
  if (before.existing) {
    return {
      commentNodeId: before.existing.node_id,
      resultId: result.resultId,
      resultDigest: resultValueDigest(result),
      reconciled: true,
    };
  }
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
    resultDigest: resultValueDigest(result),
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

const lifecycleContextProperties = {
  taskLocator: locatorSchema,
  rootIssueId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  workflowRunId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  taskId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  dispatchId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  leaseId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  resultId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  attempt: { type: "integer", minimum: 1, maximum: MAX_ATTEMPT },
};

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
  {
    name: "get_task_snapshot",
    description:
      "Read the exact current Dispatch, Result, policy, and bounded evaluator or orchestrator choices for one open WorkGraphTask.",
    inputSchema: schema(lifecycleContextProperties),
  },
  {
    name: "submit_task_evaluation",
    description:
      "Create or reconcile one canonical WorkGraphTaskEvaluate/v1 for the exact current Result.",
    inputSchema: schema({
      ...lifecycleContextProperties,
      evaluationId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
      verdict: { type: "string", enum: ["accepted", "rejected"] },
      summary: { type: "string", minLength: 1, maxLength: 4096 },
      feedback: { type: "string", maxLength: 16384 },
    }),
  },
  {
    name: "submit_task_route",
    description:
      "Create or reconcile one canonical WorkGraphTaskRoute/v1 from the current Evaluation and a bounded compiled choice.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...lifecycleContextProperties,
        evaluationId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_ID_BYTES,
        },
        routeId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
        action: {
          type: "string",
          enum: ["advance", "rework", "complete", "error", "ignore"],
        },
        transitionKind: { type: "string", enum: ["next", "outcome"] },
        outcome: { type: "string", minLength: 1, maxLength: 64 },
        targetStepId: { type: "string", minLength: 1, maxLength: 64 },
        targetStepKind: {
          type: "string",
          enum: ["task", "wait", "terminal"],
        },
        targetTaskDefinitionId: {
          type: "string",
          minLength: 1,
          maxLength: 64,
        },
      },
      required: [
        ...Object.keys(lifecycleContextProperties),
        "evaluationId",
        "routeId",
        "action",
      ],
    },
  },
];

export async function callTool(name, args) {
  const config = configuration(name);
  const github = new GitHub(config);
  if (name === "get_root_issue") return getRootIssue(args, github, config);
  if (name === "get_task_snapshot") {
    return getTaskSnapshot(args, github, config);
  }
  if (name === "submit_task_evaluation") {
    return submitTaskEvaluation(args, github, config);
  }
  if (name === "submit_task_route") {
    return submitTaskRoute(args, github, config);
  }
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
