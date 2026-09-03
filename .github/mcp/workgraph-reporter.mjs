#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { isDeepStrictEqual, TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  TASK_ASSIGNMENT_MARKER,
  TASK_DISPATCH_MARKER,
  TASK_ERROR_MARKER,
  TASK_EVALUATION_MARKER,
  TASK_FORK_MARKER,
  TASK_JOIN_MARKER,
  TASK_RESULT_MARKER,
  TASK_ROUTE_MARKER,
  WORKGRAPH_ID_NAMESPACE,
  canonicalTaskResultEnvelopeJson,
  deriveWorkGraphProtocolId,
  deriveWorkGraphTaskEvaluationId,
  deriveWorkGraphTaskResultId,
  deriveWorkGraphTaskRouteId,
  deriveWorkGraphTaskErrorId,
  formatTaskDispatch,
  formatTaskError,
  formatTaskEvaluation,
  formatTaskResult,
  formatTaskRoute,
  normalizeCompiledWorkflowDefinition,
  parseTaskAssignment,
  parseRuntimeTask,
  parseTaskDispatch,
  parseTaskError,
  parseTaskEvaluation,
  parseTaskFork,
  parseTaskJoin,
  parseTaskResult,
  parseTaskRoute,
  resolveCompiledFlowScopes,
  taskResultDigest,
  validateTaskRouteAgainstDefinition,
} from "./workgraph-v1-definition.mjs";

export {
  TASK_ERROR_MARKER,
  canonicalTaskResultEnvelopeJson,
  deriveWorkGraphTaskEvaluationId,
  deriveWorkGraphTaskResultId,
  deriveWorkGraphTaskRouteId,
  deriveWorkGraphTaskErrorId,
  formatTaskDispatch,
  formatTaskError,
  formatTaskResult,
  parseTaskDispatch,
  parseTaskError,
  parseTaskResult,
  taskResultDigest,
};

const API = "https://api.github.com";
const OWNER = "drasi-project";
const REPO = "drasi-workgraph-demo";
const REPOSITORY_URL = `${API}/repos/${OWNER}/${REPO}`;
const TASK_TYPE_NAME = "WorkGraphTask";
const WORKFLOW_DEFINITION_ID = "issue-lifecycle";
const WORKFLOW_DEFINITION_VERSION = "v1";
const WORKFLOW_DEFINITION_DIGEST = `sha256:${"a".repeat(64)}`;
const ROOT_TASK_DEFINITION_ID = deriveWorkGraphProtocolId("task-definition", [
  "root-v1",
]);
const VALIDATOR_TASK_DEFINITION_ID = deriveWorkGraphProtocolId(
  "task-definition",
  ["validate-v1"],
);
const LEASE_VALIDATION_PATH = "/github/workgraph-v1/lease/validate";
const MAX_ID_BYTES = 256;
const MAX_LEASE_ATTEMPT = 64;
const MAX_LIFECYCLE_ATTEMPT = 17;
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
  "taskKey",
  "operation",
];
// Reserved runtime inputs that bind a task to the routed scope its owning
// container launched. They are written as a set or not at all.
const SCOPE_INPUT_KEYS = [
  "workgraphScopeEntryStepId",
  "workgraphScopeEntryTaskId",
  "workgraphScopeParentTaskId",
];
const PREDECESSOR_INPUT_KEY = "workgraphPredecessorTaskId";
const MAX_SCOPE_MEMBER_TRACE = 32;
const MAX_TASK_ANCESTRY_HOPS = 16;
const COMPILED_WORKFLOWS = new Map();
const COMPILED_FLOW_SCOPES = new Map();
for (const workflowDefinitionId of [
  "fork-join-lifecycle",
  "issue-lifecycle",
  "mixed-control-flow",
  "scoped-control-flow",
]) {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `../workgraph/fixtures/v1/${workflowDefinitionId}.expected.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const workflow = normalizeCompiledWorkflowDefinition(
    fixture.workgraphDefinition,
  );
  if (
    fixture.definitionDigest !== workflow.digest ||
    workflow.workflowDefinitionId !== workflowDefinitionId ||
    workflow.version !== "v1" ||
    COMPILED_WORKFLOWS.has(workflowDefinitionId)
  ) {
    throw new Error("pinned compiled WorkGraph fixture catalog is inconsistent");
  }
  COMPILED_WORKFLOWS.set(workflowDefinitionId, workflow);
  COMPILED_FLOW_SCOPES.set(
    workflowDefinitionId,
    resolveCompiledFlowScopes(workflow),
  );
}

function compiledWorkflowForTask(task) {
  const workflow = COMPILED_WORKFLOWS.get(task.workflowDefinitionId);
  return workflow &&
    task.workflowDefinitionVersion === workflow.version &&
    task.workflowDefinitionDigest === workflow.digest
    ? workflow
    : null;
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

function canonicalTaskId(value, label) {
  return protocolId(value, "task", label);
}

function protocolId(value, type, label) {
  const prefix = `${WORKGRAPH_ID_NAMESPACE}:${type}:sha256:`;
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.length !== prefix.length + 64 ||
    !/^[0-9a-f]{64}$/.test(value.slice(prefix.length))
  ) {
    throw new WorkGraphReporterError(
      `${label} must be ${prefix}<64 lowercase hex>`,
    );
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
  return deriveWorkGraphProtocolId("admission", [rootIssueId, deliveryId]);
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
    ["workflowDefinitionId", workflowDefinitionId],
    ["workflowDefinitionVersion", workflowDefinitionVersion],
    ["workflowDefinitionDigest", workflowDefinitionDigest],
  ]) {
    opaque(value, label);
  }
  protocolId(admissionId, "admission", "admissionId");
  digest(workflowDefinitionDigest, "workflowDefinitionDigest");
  return deriveWorkGraphProtocolId("workflow-run", [
    repositoryNodeId,
    rootIssueId,
    admissionId,
    workflowDefinitionId,
    workflowDefinitionVersion,
    workflowDefinitionDigest,
  ]);
}

export function deriveWorkGraphRootTaskId(workflowRunId, rootTaskDefinitionId) {
  protocolId(workflowRunId, "workflow-run", "workflowRunId");
  protocolId(
    rootTaskDefinitionId,
    "task-definition",
    "rootTaskDefinitionId",
  );
  return deriveWorkGraphProtocolId("task", [
    workflowRunId,
    rootTaskDefinitionId,
  ]);
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
    assignmentId: envUserId(
      "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
    ),
    resultId: envUserId("COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID"),
    api: apiBaseUrl(),
  };
  if (toolName === "submit_task_result") {
    return {
      ...config,
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
  const expectedMetadata =
    task.taskDefinitionId === ROOT_TASK_DEFINITION_ID
      ? { taskKey: "root", operation: "coordinate-issue" }
      : { taskKey: "validate", operation: "validate-issue" };
  validateTaskMetadata(task, expectedMetadata, label);
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
  if (!Array.isArray(issue?.labels)) return false;
  const names = issue.labels
    .filter((label) => object(label) && typeof label.name === "string")
    .map((label) => label.name);
  if (names.some((name) => ["workgraph:ignore", "workgraph:error"].includes(name))) {
    return false;
  }
  return names.some(
    (name) =>
      name === "workgraph" ||
      /^workgraph:[A-Za-z0-9._-]{1,64}$/.test(name),
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

function compiledStepId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value) ||
    value.endsWith("-")
  ) {
    throw new WorkGraphReporterError(`${label} must be a lowercase step ID`);
  }
  return value;
}

// The reserved scope binding a task carries, or `null` for an ordinary trunk
// or fixed-child task. The three scope inputs are all-or-none. A pinned
// definition can never author them: normalization rejects a compiled workflow
// whose scope or successor tasks declare a reserved key as a static input.
function scopeInputs(task, label) {
  const inputs = task.resolvedInputs ?? {};
  const present = SCOPE_INPUT_KEYS.filter((key) => key in inputs);
  if (present.length === 0) return null;
  if (present.length !== SCOPE_INPUT_KEYS.length) {
    throw new WorkGraphReporterError(
      `${label} reserved scope inputs must all be present or all absent`,
    );
  }
  const scope = {
    entryStepId: compiledStepId(
      inputs.workgraphScopeEntryStepId,
      `${label} workgraphScopeEntryStepId`,
    ),
    entryTaskId: canonicalTaskId(
      inputs.workgraphScopeEntryTaskId,
      `${label} workgraphScopeEntryTaskId`,
    ),
    parentTaskId: canonicalTaskId(
      inputs.workgraphScopeParentTaskId,
      `${label} workgraphScopeParentTaskId`,
    ),
    predecessorTaskId:
      PREDECESSOR_INPUT_KEY in inputs
        ? canonicalTaskId(
            inputs[PREDECESSOR_INPUT_KEY],
            `${label} ${PREDECESSOR_INPUT_KEY}`,
          )
        : null,
  };
  if (scope.entryTaskId === scope.parentTaskId) {
    throw new WorkGraphReporterError(
      `${label} scope entry and owning container must differ`,
    );
  }
  return scope;
}

// The three reserved scope strings, ignoring the routed predecessor, which
// only a routed step root carries.
function sameFlowScope(left, right) {
  if (left === null || right === null) return left === right;
  return (
    left.entryStepId === right.entryStepId &&
    left.entryTaskId === right.entryTaskId &&
    left.parentTaskId === right.parentTaskId
  );
}

function compiledTransitionTargets(transition) {
  return transition.type === "next"
    ? [transition.targetStepId]
    : Object.values(transition.targets);
}

function sameWorkflowPins(left, right) {
  return (
    left.rootIssueId === right.rootIssueId &&
    left.workflowRunId === right.workflowRunId &&
    left.workflowDefinitionId === right.workflowDefinitionId &&
    left.workflowDefinitionVersion === right.workflowDefinitionVersion &&
    left.workflowDefinitionDigest === right.workflowDefinitionDigest
  );
}

// The task definition IDs a definition forks through its `flowEntries`, in
// canonical declaration order.
function flowEntryDefinitionIds(workflow, taskDefinition) {
  return (taskDefinition.flowEntries ?? []).map((entryStepId) => {
    const step = workflow.steps[entryStepId];
    if (!step || step.type !== "task") {
      throw new WorkGraphReporterError(
        "declared flow entry does not resolve to a compiled task step",
      );
    }
    return step.taskDefinition.taskDefinitionId;
  });
}

function scopeMemberIndex(children, config) {
  const members = new Map();
  for (const child of children) {
    if (
      child?.type?.name !== TASK_TYPE_NAME ||
      child?.type?.node_id !== config.taskTypeId ||
      child?.user?.id !== config.launcherId
    ) {
      continue;
    }
    let candidate;
    try {
      candidate = taskIssue(
        child,
        { issueNumber: child.number, issueNodeId: child.node_id },
        config,
        "Scope member candidate",
      );
    } catch {
      continue;
    }
    members.set(candidate.taskId, { issue: child, task: candidate });
  }
  return members;
}

// Validates one scoped task against the routed scope its reserved inputs
// claim, and returns the owning container so ancestry can continue upward.
// The entry root is gated by the owner's Fork; every other member is gated by
// its predecessor's Route and traces back to the entry without a cycle.
async function validateFlowScopeAncestry(
  task,
  compiled,
  scope,
  parentLink,
  github,
  config,
  requireOpen,
) {
  const workflow = compiled.workflow;
  const flow = COMPILED_FLOW_SCOPES.get(workflow.workflowDefinitionId);
  const definitionScope = flow?.scopes.get(scope.entryStepId);
  if (!definitionScope) {
    throw new WorkGraphReporterError(
      "task scope entry step is not a compiled flow entry",
    );
  }
  if (!compiled.isStepRoot || !definitionScope.stepIds.has(compiled.sourceStepId)) {
    throw new WorkGraphReporterError(
      "scoped task step does not belong to its declared flow scope",
    );
  }
  for (const target of compiledTransitionTargets(compiled.source.transition)) {
    if (!definitionScope.stepIds.has(target)) {
      throw new WorkGraphReporterError(
        "scoped task transitions outside its declared flow scope",
      );
    }
  }

  const ownerIssue = await github.issue(parentLink.number);
  linkedIssue(
    ownerIssue,
    parentLink.number,
    parentLink.node_id,
    "scoped task owning container parent",
  );
  if (requireOpen && ownerIssue.state !== "open") {
    throw new WorkGraphReporterError(
      "lifecycle reporting requires an open scope owning container",
    );
  }
  const ownerTask = taskIssue(
    ownerIssue,
    { issueNumber: ownerIssue.number, issueNodeId: ownerIssue.node_id },
    config,
    "Scope owning container",
  );
  const ownerCompiled = validateLifecycleTask(
    ownerTask,
    "Scope owning container",
    workflow,
  );
  if (
    ownerTask.taskId !== scope.parentTaskId ||
    ownerTask.taskDefinitionId !== definitionScope.ownerTaskDefinitionId ||
    !sameWorkflowPins(ownerTask, task)
  ) {
    throw new WorkGraphReporterError(
      "scoped task native parent is not its declared scope owning container",
    );
  }

  const [ownerComments, ownerChildren] = await Promise.all([
    github.comments(ownerIssue.number),
    github.subIssues(ownerIssue.number),
  ]);
  const forks = markedComments(
    ownerComments,
    TASK_FORK_MARKER,
    parseTaskFork,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_FORK_MARKER),
  );
  if (forks.length !== 1 || !dispatchMatchesTask(forks[0].payload, ownerTask)) {
    throw new WorkGraphReporterError(
      "scope owning container requires exactly one matching Fork",
    );
  }
  const fork = forks[0].payload;
  const entryDefinitionId = workflow.steps[scope.entryStepId].taskDefinition
    .taskDefinitionId;
  const forkedEntry = fork.children.find(
    (child) =>
      child.taskDefinitionId === entryDefinitionId &&
      child.taskId === scope.entryTaskId,
  );
  if (!forkedEntry) {
    throw new WorkGraphReporterError(
      "scope owning container Fork does not name the declared flow entry task",
    );
  }
  const members = scopeMemberIndex(ownerChildren, config);

  let current = { task, compiled, scope };
  const visited = new Set([task.taskId]);
  for (let hop = 0; hop <= MAX_SCOPE_MEMBER_TRACE; hop += 1) {
    if (current.task.taskId === scope.entryTaskId) {
      if (current.scope.predecessorTaskId !== null) {
        throw new WorkGraphReporterError(
          "flow entry task must not declare a routed predecessor",
        );
      }
      if (
        current.compiled.sourceStepId !== scope.entryStepId ||
        current.task.taskDefinitionId !== entryDefinitionId
      ) {
        throw new WorkGraphReporterError(
          "flow entry task does not realize its declared entry step",
        );
      }
      return { task: ownerTask, compiled: ownerCompiled, issue: ownerIssue };
    }
    if (
      fork.children.some((child) => child.taskId === current.task.taskId)
    ) {
      throw new WorkGraphReporterError(
        "routed scope member must not be a forked child of its owning container",
      );
    }
    const predecessorTaskId = current.scope.predecessorTaskId;
    if (predecessorTaskId === null) {
      throw new WorkGraphReporterError(
        `routed scope member requires ${PREDECESSOR_INPUT_KEY}`,
      );
    }
    if (visited.has(predecessorTaskId)) {
      throw new WorkGraphReporterError(
        "scoped task predecessor chain is cyclic",
      );
    }
    visited.add(predecessorTaskId);
    const predecessor = members.get(predecessorTaskId);
    if (!predecessor) {
      throw new WorkGraphReporterError(
        "scoped task predecessor is not a task of the same owning container",
      );
    }
    if (requireOpen && predecessor.issue.state !== "open") {
      throw new WorkGraphReporterError(
        "lifecycle reporting requires an open scoped predecessor chain",
      );
    }
    const predecessorCompiled = validateLifecycleTask(
      predecessor.task,
      "Scope predecessor",
      workflow,
    );
    const predecessorScope = scopeInputs(
      predecessor.task,
      "Scope predecessor",
    );
    if (
      !predecessorScope ||
      predecessorScope.entryStepId !== scope.entryStepId ||
      predecessorScope.entryTaskId !== scope.entryTaskId ||
      predecessorScope.parentTaskId !== scope.parentTaskId ||
      !sameWorkflowPins(predecessor.task, task)
    ) {
      throw new WorkGraphReporterError(
        "scoped task predecessor belongs to a different flow scope",
      );
    }
    if (
      !predecessorCompiled.isStepRoot ||
      !definitionScope.stepIds.has(predecessorCompiled.sourceStepId)
    ) {
      throw new WorkGraphReporterError(
        "scoped task predecessor step does not belong to the same flow scope",
      );
    }
    if (
      current.task.taskId !==
      deriveWorkGraphProtocolId("task", [
        task.workflowRunId,
        predecessorTaskId,
        current.task.taskDefinitionId,
      ])
    ) {
      throw new WorkGraphReporterError(
        "routed scope member identity does not derive from its predecessor",
      );
    }
    const routes = markedComments(
      await github.comments(predecessor.issue.number),
      TASK_ROUTE_MARKER,
      parseTaskRoute,
    ).map((entry) =>
      validateProtocolComment(entry, config.routeId, TASK_ROUTE_MARKER),
    );
    const routed = routes.filter(
      ({ payload }) =>
        payload.taskId === predecessor.task.taskId &&
        payload.action === "advance" &&
        payload.targetStepId === current.compiled.sourceStepId &&
        payload.targetStepKind === "task" &&
        payload.targetTaskDefinitionId === current.task.taskDefinitionId,
    );
    if (routed.length !== 1) {
      throw new WorkGraphReporterError(
        "scoped task predecessor has no single Route advancing to it",
      );
    }
    current = {
      task: predecessor.task,
      compiled: predecessorCompiled,
      scope: predecessorScope,
    };
  }
  throw new WorkGraphReporterError(
    "scoped task predecessor chain does not reach its flow entry",
  );
}

// Walks a task's native ancestry up to its ordinary Root Issue. A scoped task
// climbs to its owning container first; an ordinary nested child climbs its
// compiled parent chain; a step root's parent is the Root Issue itself.
async function resolveAncestryRootIssue(
  task,
  compiled,
  parentLink,
  github,
  config,
  { requireOpen = false, strict = false } = {},
) {
  let currentTask = task;
  let currentCompiled = compiled;
  let currentLink = parentLink;
  for (let hop = 0; hop <= MAX_TASK_ANCESTRY_HOPS; hop += 1) {
    const scope = scopeInputs(currentTask, "Task");
    // Only a scoped step root is validated against its routed scope. A nested
    // fixed child inherits the same scope strings but has no step of its own,
    // so it first follows its compiled parent chain to that step root.
    if (scope && currentCompiled.isStepRoot) {
      const owner = await validateFlowScopeAncestry(
        currentTask,
        currentCompiled,
        scope,
        currentLink,
        github,
        config,
        requireOpen,
      );
      currentTask = owner.task;
      currentCompiled = owner.compiled;
      currentLink = await github.parent(owner.issue.number);
      continue;
    }
    if (currentCompiled.isStepRoot) {
      const rootIssueCandidate = await github.issue(currentLink.number);
      linkedIssue(
        rootIssueCandidate,
        currentLink.number,
        currentLink.node_id,
        "top-level task Root Issue parent",
      );
      return rootIssueCandidate;
    }
    if (scope !== null && scope.predecessorTaskId !== null) {
      throw new WorkGraphReporterError(
        `nested child task must not declare ${PREDECESSOR_INPUT_KEY}`,
      );
    }
    const ancestorIssue = await github.issue(currentLink.number);
    linkedIssue(
      ancestorIssue,
      currentLink.number,
      currentLink.node_id,
      "recursive task ancestor",
    );
    if (strict && ancestorIssue.type?.name !== TASK_TYPE_NAME) {
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
      ancestor.taskDefinitionId !== currentCompiled.parentTaskDefinitionId ||
      ancestor.rootIssueId !== task.rootIssueId ||
      ancestor.workflowRunId !== task.workflowRunId ||
      (strict &&
        (ancestor.workflowDefinitionId !== task.workflowDefinitionId ||
          ancestor.workflowDefinitionVersion !==
            task.workflowDefinitionVersion ||
          ancestor.workflowDefinitionDigest !== task.workflowDefinitionDigest))
    ) {
      throw new WorkGraphReporterError(
        "recursive task ancestry does not match its compiled parent chain",
      );
    }
    // A nested child inherits its parent's routed scope verbatim, so the three
    // reserved scope strings must agree before the step root validates them.
    const ancestorScope = scopeInputs(ancestor, "Recursive task ancestor");
    if (!sameFlowScope(scope, ancestorScope)) {
      throw new WorkGraphReporterError(
        "nested child task does not inherit its parent's routed scope",
      );
    }
    currentTask = ancestor;
    currentCompiled = ancestorCompiled;
    currentLink = await github.parent(ancestorIssue.number);
  }
  return null;
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
  if (task.taskId !== taskId) {
    throw new WorkGraphReporterError("taskId does not match WorkGraphTask/v1");
  }
  linkedIssue(
    parentLink,
    locator.parentIssueNumber,
    locator.parentIssueNodeId,
    "task native parent",
  );

  const workflow = compiledWorkflowForTask(task);
  const generated = workflow !== null;
  if (generated) {
    const compiled = validateLifecycleTask(task, "Task", workflow);
    const rootIssueCandidate = await resolveAncestryRootIssue(
      task,
      compiled,
      parentLink,
      github,
      config,
    );
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
    const initialTasks = [];
    for (const child of await github.subIssues(rootIssue.number)) {
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
          workflow.root.taskDefinitionId &&
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
    validateTaskMetadata(rootTask, workflow.root, "Root Task");
    const admission = validateRootAdmission(
      rootTask,
      rootIssue,
      locator.repositoryNodeId,
      {
        taskDefinitionId: workflow.root.taskDefinitionId,
        staticInputs: workflow.root.staticInputs,
        validateContract: false,
      },
    );
    if (includeComments) {
      validateTaskActionPrefix(
        task,
        compiled.taskDefinition,
        comments,
        config,
        workflow,
      );
    }
    return {
      task,
      compiled,
      rootTask,
      rootTaskIssue,
      rootIssue,
      admission,
      issue,
      comments,
    };
  }

  validateTaskContract(task, "Task");
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
  if (includeComments) {
    validateTaskActionPrefix(
      task,
      {
        children:
          task.taskDefinitionId === ROOT_TASK_DEFINITION_ID
            ? [{ taskDefinitionId: VALIDATOR_TASK_DEFINITION_ID }]
            : [],
      },
      comments,
      config,
    );
  }
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

function validateTaskActionPrefix(
  task,
  taskDefinition,
  comments,
  config,
  workflow = null,
) {
  const assignments = markedComments(
    comments,
    TASK_ASSIGNMENT_MARKER,
    parseTaskAssignment,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_ASSIGNMENT_MARKER),
  );
  const forks = markedComments(
    comments,
    TASK_FORK_MARKER,
    parseTaskFork,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_FORK_MARKER),
  );
  const joins = markedComments(
    comments,
    TASK_JOIN_MARKER,
    parseTaskJoin,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_JOIN_MARKER),
  );
  const dispatches = markedComments(
    comments,
    TASK_DISPATCH_MARKER,
    parseTaskDispatch,
  ).map((entry) =>
    validateProtocolComment(entry, config.assignmentId, TASK_DISPATCH_MARKER),
  );
  for (const { payload } of [...assignments, ...forks, ...joins]) {
    if (!dispatchMatchesTask(payload, task)) {
      throw new WorkGraphReporterError(
        "task has a Fork, Join, or Assignment for a different task identity",
      );
    }
  }
  if (dispatches.some(({ payload }) => !dispatchMatchesTask(payload, task))) {
    throw new WorkGraphReporterError(
      "task has a malformed, foreign, or duplicate Dispatch",
    );
  }
  if (assignments.length > 1 || forks.length > 1 || joins.length > 1) {
    throw new WorkGraphReporterError(
      "task has duplicate Fork, Join, or Assignment actions",
    );
  }
  if (assignments.length !== 1) {
    throw new WorkGraphReporterError(
      "task requires exactly one Assignment action",
    );
  }
  if (dispatches.length === 0) {
    throw new WorkGraphReporterError(
      "task requires a Dispatch following its Assignment",
    );
  }
  const assignment = assignments[0];
  if (
    dispatches.some(
      ({ payload, comment }) =>
        payload.lease.assignmentId !== assignment.payload.assignmentId ||
        commentOrder(assignment.comment, comment) >= 0,
    )
  ) {
    throw new WorkGraphReporterError(
      "Dispatch must follow and reference the task Assignment",
    );
  }

  // A container forks its fixed children plus one entry task per declared
  // flow entry; both kinds are named by the same Fork and joined by the same
  // Join before the container's own lifecycle continues.
  const declaredEntryDefinitionIds = workflow
    ? flowEntryDefinitionIds(workflow, taskDefinition)
    : [];
  if (
    taskDefinition.children.length === 0 &&
    declaredEntryDefinitionIds.length === 0
  ) {
    if (
      forks.length !== 0 ||
      joins.length !== 0 ||
      assignment.payload.joinId !== null
    ) {
      throw new WorkGraphReporterError(
        "leaf task cannot contain Fork or Join actions",
      );
    }
    return;
  }
  if (
    forks.length !== 1 ||
    joins.length !== 1
  ) {
    throw new WorkGraphReporterError(
      "parent task requires exactly one Fork, Join, and Assignment action",
    );
  }
  const fork = forks[0].payload;
  const join = joins[0].payload;
  if (
    commentOrder(forks[0].comment, joins[0].comment) >= 0 ||
    commentOrder(joins[0].comment, assignment.comment) >= 0
  ) {
    throw new WorkGraphReporterError(
      "parent actions must be ordered Fork, Join, then Assignment",
    );
  }
  const declared = [
    ...taskDefinition.children.map((child) => child.taskDefinitionId),
    ...declaredEntryDefinitionIds,
  ].sort();
  if (
    !isDeepStrictEqual(
      fork.children.map((child) => child.taskDefinitionId),
      declared,
    ) ||
    !isDeepStrictEqual(
      join.children.map((child) => ({
        taskDefinitionId: child.taskDefinitionId,
        taskId: child.taskId,
      })),
      fork.children,
    ) ||
    join.forkId !== fork.forkId ||
    assignment.payload.joinId !== join.joinId
  ) {
    throw new WorkGraphReporterError(
      "parent Fork, Join, Assignment, and declared children do not form one action chain",
    );
  }
}

function resultContext(context, input, config, expectedBody) {
  const dispatches = markedComments(
    context.comments,
    TASK_DISPATCH_MARKER,
    parseTaskDispatch,
  );
  const expectedExecutor = context.compiled
    ? context.compiled.policy.workerId
    : context.task.taskDefinitionId === ROOT_TASK_DEFINITION_ID
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
        !sameTaskIdentity(payload.task, context.task) ||
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
    (!context.compiled && context.rootTaskIssue.state !== "open")
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
    snapshot.attempt > MAX_LEASE_ATTEMPT
  ) {
    throw new WorkGraphReporterError(
      `Source Lease attempt must be an integer from 1 through ${MAX_LEASE_ATTEMPT}`,
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

function lifecycleTaskIdentity(task) {
  return Object.fromEntries(TASK_IDENTITY_KEYS.map((key) => [key, task[key]]));
}

function dispatchMatchesTask(dispatch, task) {
  return (
    dispatch.rootIssueId === task.rootIssueId &&
    dispatch.workflowRunId === task.workflowRunId &&
    dispatch.taskId === task.taskId &&
    sameTaskIdentity(dispatch.task, task)
  );
}

function compiledSource(workflow, taskDefinitionId) {
  const matches = Object.entries(workflow.steps).filter(
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
  let taskDefinition = null;
  const findParent = (task, parentId = null) => {
    if (task.taskDefinitionId === taskDefinitionId) {
      parentTaskDefinitionId = parentId;
      taskDefinition = task;
      return true;
    }
    return task.children.some((child) =>
      findParent(child, task.taskDefinitionId),
    );
  };
  findParent(source.taskDefinition);
  return {
    workflow,
    sourceStepId,
    source,
    policy: source.executionPolicies[taskDefinitionId],
    isStepRoot: source.taskDefinition.taskDefinitionId === taskDefinitionId,
    parentTaskDefinitionId,
    taskDefinition,
  };
}

function validateTaskMetadata(task, definition, label) {
  if (
    task.taskKey !== definition.taskKey ||
    task.operation !== definition.operation
  ) {
    throw new WorkGraphReporterError(
      `${label} taskKey or operation does not match the pinned task definition`,
    );
  }
}

function validateLifecycleTask(
  task,
  label,
  workflow = compiledWorkflowForTask(task),
) {
  if (!workflow) {
    throw new WorkGraphReporterError(
      `${label} does not belong to the pinned compiled workflow`,
    );
  }
  const context = compiledSource(workflow, task.taskDefinitionId);
  validateTaskMetadata(task, context.taskDefinition, label);
  return context;
}

function validateLifecycleContextInput(input, extraKeys = []) {
  exact(input, [...LIFECYCLE_CONTEXT_KEYS, ...extraKeys], "arguments");
  const locator = validateTaskLocator(input.taskLocator);
  for (const key of [
    "rootIssueId",
  ]) {
    opaque(input[key], `arguments.${key}`);
  }
  protocolId(input.workflowRunId, "workflow-run", "arguments.workflowRunId");
  canonicalTaskId(input.taskId, "arguments.taskId");
  protocolId(input.dispatchId, "dispatch", "arguments.dispatchId");
  protocolId(input.leaseId, "lease", "arguments.leaseId");
  protocolId(input.resultId, "result", "arguments.resultId");
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > MAX_LIFECYCLE_ATTEMPT
  ) {
    throw new WorkGraphReporterError(
      `arguments.attempt must be an integer from 1 through ${MAX_LIFECYCLE_ATTEMPT}`,
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

  let rootIssueCandidate = await resolveAncestryRootIssue(
    task,
    compiled,
    parentLink,
    github,
    config,
    { requireOpen, strict: true },
  );
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
        compiled.workflow.root.taskDefinitionId &&
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
    rootTask.taskDefinitionId !== compiled.workflow.root.taskDefinitionId ||
    rootTask.rootIssueId !== input.rootIssueId ||
    rootTask.workflowRunId !== input.workflowRunId
  ) {
    throw new WorkGraphReporterError("Initial Task direct identities do not match");
  }
  validateTaskMetadata(rootTask, compiled.workflow.root, "Root Task");
  const admission = validateRootAdmission(
    rootTask,
    rootIssue,
    locator.repositoryNodeId,
    {
      taskDefinitionId: compiled.workflow.root.taskDefinitionId,
      staticInputs: compiled.workflow.root.staticInputs,
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
  validateTaskActionPrefix(
    task,
    compiled.taskDefinition,
    comments,
    config,
    compiled.workflow,
  );
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
        !sameTaskIdentity(payload.task, context.task) ||
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
  const resultDigest = taskResultDigest(result.payload);

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
        !sameTaskIdentity(payload.task, context.task) ||
        payload.evaluatorId !== context.policy.evaluatorId ||
        !referenced ||
        payload.attempt !== referenced?.payload.attempt ||
        payload.resultDigest !== taskResultDigest(referenced.payload) ||
        payload.evaluationId !==
          deriveWorkGraphTaskEvaluationId(
            payload.taskId,
            payload.resultId,
            payload.resultDigest,
          )
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
        !sameTaskIdentity(payload.task, context.task) ||
        payload.resultId !== evaluation.resultId ||
        payload.routeId !==
          deriveWorkGraphTaskRouteId(payload.taskId, payload.evaluationId) ||
        payload.evaluationVerdict !== evaluation.verdict ||
        payload.attempt !== evaluation.attempt ||
        payload.orchestratorId !== context.policy.orchestratorId
      ) {
        return true;
      }
      try {
        validateTaskRouteAgainstDefinition(payload, context.workflow, {
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

async function hydrateLifecycleSubmissionInput(
  input,
  github,
  config,
  extraKeys,
) {
  const fullKeys = [...LIFECYCLE_CONTEXT_KEYS, ...extraKeys].sort();
  if (
    object(input) &&
    isDeepStrictEqual(Object.keys(input).sort(), fullKeys)
  ) {
    validateLifecycleContextInput(input, extraKeys);
    return input;
  }

  exact(
    input,
    ["taskLocator", "taskId", "resultId", ...extraKeys],
    "arguments",
  );
  const locator = validateTaskLocator(input.taskLocator);
  canonicalTaskId(input.taskId, "arguments.taskId");
  protocolId(input.resultId, "result", "arguments.resultId");
  const [issue, comments] = await Promise.all([
    github.issue(locator.issueNumber),
    github.comments(locator.issueNumber),
  ]);
  const task = taskIssue(issue, locator, config, "Task");
  if (task.taskId !== input.taskId) {
    throw new WorkGraphReporterError("taskId does not match WorkGraphTask/v1");
  }
  const results = markedComments(
    comments,
    TASK_RESULT_MARKER,
    parseTaskResult,
  ).filter(({ payload }) => payload?.resultId === input.resultId);
  if (results.length !== 1) {
    throw new WorkGraphReporterError(
      "resultId does not identify exactly one canonical Result",
    );
  }
  const result = results[0].payload;
  return {
    taskLocator: input.taskLocator,
    rootIssueId: task.rootIssueId,
    workflowRunId: task.workflowRunId,
    taskId: task.taskId,
    dispatchId: result.dispatchId,
    leaseId: result.leaseId,
    resultId: result.resultId,
    attempt: result.attempt,
    ...Object.fromEntries(extraKeys.map((key) => [key, input[key]])),
  };
}

function transitionChoices(context, result) {
  if (!context.isStepRoot) return [];
  const transition = context.source.transition;
  if (transition.type === "next") {
    return [
      routeTarget(context.workflow, "next", null, transition.targetStepId),
    ];
  }
  const outcome = result.output?.outcome;
  if (
    typeof outcome !== "string" ||
    !(outcome in transition.targets)
  ) {
    return [];
  }
  return [
    routeTarget(
      context.workflow,
      "outcome",
      outcome,
      transition.targets[outcome],
    ),
  ];
}

function routeTarget(workflow, transitionKind, outcome, targetStepId) {
  const target = workflow.steps[targetStepId];
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
          context.workflow.steps[targetStepId]?.type === "terminal" &&
          context.workflow.steps[targetStepId].outcome === "completed",
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
      evaluationId: deriveWorkGraphTaskEvaluationId(
        context.task.taskId,
        artifacts.result.payload.resultId,
        artifacts.resultDigest,
      ),
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
    routeId: deriveWorkGraphTaskRouteId(
      context.task.taskId,
      artifacts.currentEvaluation.payload.evaluationId,
    ),
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
  canonicalTaskId(taskId, "artifact claim taskId");
  protocolId(
    subjectId,
    artifactKind === "evaluation" ? "result" : "evaluation",
    "artifact claim subjectId",
  );
  return deriveWorkGraphProtocolId("artifact-claim", [
    artifactKind,
    taskId,
    subjectId,
  ]);
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
  input = await hydrateLifecycleSubmissionInput(input, github, config, extra);
  const readAny = () =>
    readLifecycleContext(input, github, config, extra, false, false);
  const readOpen = () =>
    readLifecycleContext(input, github, config, extra, true);
  const initial = await readAny();
  const expectedEvaluationId = deriveWorkGraphTaskEvaluationId(
    input.taskId,
    input.resultId,
    initial.artifacts.resultDigest,
  );
  if (input.evaluationId !== expectedEvaluationId) {
    throw new WorkGraphReporterError(
      "evaluationId does not match the canonical current Result identity",
    );
  }
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
    evaluationId: protocolId(
      input.evaluationId,
      "evaluation",
      "arguments.evaluationId",
    ),
    rootIssueId: input.rootIssueId,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    task: lifecycleTaskIdentity(initial.context.task),
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
  const routeId = protocolId(input.routeId, "route", "arguments.routeId");
  if (
    routeId !== deriveWorkGraphTaskRouteId(input.taskId, input.evaluationId)
  ) {
    throw new WorkGraphReporterError(
      "routeId does not match the canonical current Evaluation identity",
    );
  }
  const route = {
    routeId,
    rootIssueId: input.rootIssueId,
    workflowRunId: input.workflowRunId,
    taskId: input.taskId,
    task: lifecycleTaskIdentity(context.task),
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
  input = await hydrateLifecycleSubmissionInput(input, github, config, extra);
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
  validateTaskRouteAgainstDefinition(route, initial.context.workflow, {
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
  canonicalTaskId(input.taskId, "arguments.taskId");
  const context = await loadTaskContext(
    locator,
    input.taskId,
    github,
    config,
    true,
  );
  if (
    !context.compiled &&
    context.task.taskDefinitionId !== VALIDATOR_TASK_DEFINITION_ID
  ) {
    throw new WorkGraphReporterError(
      "get_root_issue requires the validator child task",
    );
  }
  if (
    context.issue.state !== "open" ||
    (!context.compiled && context.rootTaskIssue.state !== "open")
  ) {
    throw new WorkGraphReporterError(
      context.compiled
        ? "get_root_issue requires an open worker task"
        : "get_root_issue requires open validator and Root Task Issues",
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
  canonicalTaskId(input.taskId, "arguments.taskId");
  protocolId(input.dispatchId, "dispatch", "arguments.dispatchId");
  protocolId(input.leaseId, "lease", "arguments.leaseId");
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
      resultDigest: taskResultDigest(selected.existingResult),
      reconciled: true,
    };
  }
  const claimId = deriveWorkGraphProtocolId("lease-claim", [
    input.taskId,
    input.dispatchId,
    input.leaseId,
    randomUUID(),
  ]);
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
    task: lifecycleTaskIdentity(initialContext.task),
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
      resultDigest: taskResultDigest(result),
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
    resultDigest: taskResultDigest(result),
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

const protocolIdSchema = (type) => ({
  type: "string",
  pattern: `^${WORKGRAPH_ID_NAMESPACE}:${type}:sha256:[0-9a-f]{64}$`,
});
const taskIdSchema = protocolIdSchema("task");

const lifecycleContextProperties = {
  taskLocator: locatorSchema,
  rootIssueId: { type: "string", minLength: 1, maxLength: MAX_ID_BYTES },
  workflowRunId: protocolIdSchema("workflow-run"),
  taskId: taskIdSchema,
  dispatchId: protocolIdSchema("dispatch"),
  leaseId: protocolIdSchema("lease"),
  resultId: protocolIdSchema("result"),
  attempt: {
    type: "integer",
    minimum: 1,
    maximum: MAX_LIFECYCLE_ATTEMPT,
  },
};

const lifecycleSubmissionProperties = {
  taskLocator: locatorSchema,
  taskId: taskIdSchema,
  resultId: protocolIdSchema("result"),
};

export const tools = [
  {
    name: "get_root_issue",
    description:
      "Return the admitted ordinary Root Issue after verifying its Root Task ancestry and immutable content digest.",
    inputSchema: schema({
      taskLocator: locatorSchema,
      taskId: taskIdSchema,
    }),
  },
  {
    name: "submit_task_result",
    description:
      "Create or reconcile one canonical WorkGraphTaskResult/v1 after validating the exact active Dispatch Lease.",
    inputSchema: schema({
      taskLocator: locatorSchema,
      taskId: taskIdSchema,
      dispatchId: protocolIdSchema("dispatch"),
      leaseId: protocolIdSchema("lease"),
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
      "Create or reconcile one canonical WorkGraphTaskEvaluation/v1 for the exact current Result using the evaluationId returned by get_task_snapshot.",
    inputSchema: schema({
      ...lifecycleSubmissionProperties,
      evaluationId: protocolIdSchema("evaluation"),
      verdict: { type: "string", enum: ["accepted", "rejected"] },
      summary: { type: "string", minLength: 1, maxLength: 4096 },
      feedback: { type: "string", maxLength: 16384 },
    }),
  },
  {
    name: "submit_task_route",
    description:
      "Create or reconcile one canonical WorkGraphTaskRoute/v1 from the current Evaluation and a bounded compiled choice using the routeId returned by get_task_snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...lifecycleSubmissionProperties,
        evaluationId: protocolIdSchema("evaluation"),
        routeId: protocolIdSchema("route"),
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
        ...Object.keys(lifecycleSubmissionProperties),
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
