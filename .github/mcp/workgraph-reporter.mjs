#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder, TextEncoder } from "node:util";
import process from "node:process";
import readline from "node:readline";

const API = "https://api.github.com";
const OWNER = "drasi-project";
const REPO = "drasi-workgraph-demo";
const REPOSITORY_URL = `${API}/repos/${OWNER}/${REPO}`;
const TASK_TYPE_NAME = "WorkGraphTask";
const TASK_MARKER = "WorkGraphTask/v1";
const ASSIGNMENT_FAMILY = "WorkGraphTaskAssignment/";
const ASSIGNMENT_V1_MARKER = "WorkGraphTaskAssignment/v1";
const ASSIGNMENT_V2_MARKER = "WorkGraphTaskAssignment/v2";
const LEASE_MARKER = "WorkGraphTaskLease/v1";
const LEASE_EXPIRATION_MARKER = "WorkGraphTaskLeaseExpiration/v1";
const RESULT_FAMILY = "WorkGraphTaskResult/";
const RESULT_V1_MARKER = "WorkGraphTaskResult/v1";
const RESULT_V2_MARKER = "WorkGraphTaskResult/v2";
const ACCEPTANCE_MARKER = "WorkGraphTaskResultAcceptance/v1";
const INFO_MARKER = "WorkGraphInfoRequest/v1";
const FEEDBACK_MARKER = "WorkGraphTaskFeedback/v1";
const STATUS_LABELS = [
  "status:new",
  "status:awaiting-validation",
  "status:awaiting-need-info",
  "status:awaiting-triage",
];
const TASK_TYPES = ["validate-issue", "request-info"];
const OUTCOMES = ["succeeded", "failed", "blocked"];
const CRITERIA = [
  "The Issue has a non-empty title",
  "The Issue body is present",
];
const AGENT_BY_TASK = {
  "validate-issue": "issue-validator",
  "request-info": "issue-info-requester",
};
const MAX_TEXT_BYTES = 4096;
const MAX_ID = 256;
const MAX_TITLE = 256;
const WORKER_CONFIG_PATH = ".github/workgraph/workers.yaml";
const WORKER_CONFIG_REF = "main";
const REFS = [
  "taskIssueNumber",
  "taskIssueNodeId",
  "parentIssueNumber",
  "parentIssueNodeId",
];

class WorkGraphError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, keys, label) {
  if (!object(value)) throw new WorkGraphError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new WorkGraphError(
      `${label} properties must be exactly ${wanted.join(", ")}`,
    );
  }
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkGraphError(`${label} must be a non-empty string`);
  }
}

function identifier(value, label) {
  nonempty(value, label);
  if (value.length > MAX_ID || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkGraphError(`${label} must be a bounded GitHub node ID`);
  }
}

function issueNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkGraphError(`${label} must be a positive integer`);
  }
}

function plain(value, label) {
  nonempty(value, label);
  if (new TextEncoder().encode(value).length > MAX_TEXT_BYTES) {
    throw new WorkGraphError(`${label} must not exceed ${MAX_TEXT_BYTES} bytes`);
  }
  if (
    value.includes("\r") ||
    value.includes("```") ||
    [
      TASK_MARKER,
      ASSIGNMENT_FAMILY,
      LEASE_MARKER,
      LEASE_EXPIRATION_MARKER,
      RESULT_FAMILY,
      ACCEPTANCE_MARKER,
      INFO_MARKER,
      FEEDBACK_MARKER,
    ].some((marker) => value.includes(marker))
  ) {
    throw new WorkGraphError(`${label} must be ordinary LF plain text`);
  }
}

function refs(input, extra = []) {
  exact(input, [...REFS, ...extra], "arguments");
  issueNumber(input.taskIssueNumber, "arguments.taskIssueNumber");
  issueNumber(input.parentIssueNumber, "arguments.parentIssueNumber");
  identifier(input.taskIssueNodeId, "arguments.taskIssueNodeId");
  identifier(input.parentIssueNodeId, "arguments.parentIssueNodeId");
  if (
    input.taskIssueNumber === input.parentIssueNumber ||
    input.taskIssueNodeId === input.parentIssueNodeId
  ) {
    throw new WorkGraphError("task and parent identifiers must differ");
  }
}

function fenced(marker, language, payload) {
  return `${marker}\n\n\`\`\`${language}\n${payload}\n\`\`\`\n`;
}

function canonicalJson(marker, payload) {
  let canonical = payload;
  if (marker === RESULT_V1_MARKER) {
    canonical = {
      taskType: payload.taskType,
      outcome: payload.outcome,
      summary: payload.summary,
      result:
        payload.taskType === "validate-issue"
          ? {
              criteria: payload.result.criteria.map((entry) => ({
                criterion: entry.criterion,
                passed: entry.passed,
                evidence: entry.evidence,
              })),
            }
          : {
              requestCommentNodeId: payload.result.requestCommentNodeId,
            },
    };
  } else if (marker === RESULT_V2_MARKER) {
    canonical = {
      taskType: payload.taskType,
      leaseId: payload.leaseId,
      outcome: payload.outcome,
      summary: payload.summary,
      result:
        payload.taskType === "validate-issue"
          ? {
              criteria: payload.result.criteria.map((entry) => ({
                criterion: entry.criterion,
                passed: entry.passed,
                evidence: entry.evidence,
              })),
            }
          : {
              requestCommentNodeId: payload.result.requestCommentNodeId,
            },
    };
  } else if (marker === ACCEPTANCE_MARKER) {
    canonical = {
      resultCommentNodeId: payload.resultCommentNodeId,
      resultBodyDigest: payload.resultBodyDigest,
      summary: payload.summary,
    };
  } else if (marker === FEEDBACK_MARKER) {
    canonical = {
      resultCommentNodeId: payload.resultCommentNodeId,
      resultBodyDigest: payload.resultBodyDigest,
      feedback: payload.feedback,
    };
  }
  return fenced(marker, "json", JSON.stringify(canonical, null, 2));
}

export function formatTask(task) {
  validateTask(task);
  const key =
    task.taskType === "validate-issue"
      ? "validationProfile"
      : "validationResultCommentNodeId";
  return fenced(
    TASK_MARKER,
    "yaml",
    `taskType: ${task.taskType}\ninputs:\n  ${key}: ${task.inputs[key]}`,
  );
}

function validateTask(task) {
  exact(task, ["taskType", "inputs"], "task");
  if (!TASK_TYPES.includes(task.taskType)) {
    throw new WorkGraphError("task.taskType must be validate-issue or request-info");
  }
  if (task.taskType === "validate-issue") {
    exact(task.inputs, ["validationProfile"], "task.inputs");
    if (task.inputs.validationProfile !== "new-issue-default") {
      throw new WorkGraphError(
        "task.inputs.validationProfile must be new-issue-default",
      );
    }
  } else {
    exact(task.inputs, ["validationResultCommentNodeId"], "task.inputs");
    identifier(
      task.inputs.validationResultCommentNodeId,
      "task.inputs.validationResultCommentNodeId",
    );
  }
}

export function parseTask(body) {
  if (typeof body !== "string" || body.includes("\r")) {
    throw new WorkGraphError("WorkGraphTask body is not canonical");
  }
  const match = body.match(
    /^WorkGraphTask\/v1\n\n```yaml\ntaskType: (validate-issue|request-info)\ninputs:\n  (validationProfile|validationResultCommentNodeId): ([A-Za-z0-9_-]+)\n```\n$/,
  );
  if (!match) throw new WorkGraphError("WorkGraphTask body is not canonical");
  const task = { taskType: match[1], inputs: { [match[2]]: match[3] } };
  validateTask(task);
  if (body !== formatTask(task)) {
    throw new WorkGraphError("WorkGraphTask body is not canonical");
  }
  return task;
}

export function formatAssignment(agentProfile, workerId) {
  if (!Object.values(AGENT_BY_TASK).includes(agentProfile)) {
    throw new WorkGraphError("agentProfile is not supported");
  }
  opaque(workerId, "workerId");
  return canonicalJson(ASSIGNMENT_V2_MARKER, { agentProfile, workerId });
}

export function formatHistoricalAssignment(agentProfile) {
  validateAssignmentV1({ agentProfile });
  return canonicalJson(ASSIGNMENT_V1_MARKER, { agentProfile });
}

function parseCanonicalJson(body, marker, validator) {
  if (typeof body !== "string" || body.includes("\r")) return null;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(`^${escaped}\\n\\n\\\`\\\`\\\`json\\n([\\s\\S]+)\\n\\\`\\\`\\\`\\n$`),
  );
  if (!match) return null;
  let payload;
  try {
    payload = JSON.parse(match[1]);
    validator(payload);
  } catch {
    return null;
  }
  return body === canonicalJson(marker, payload) ? payload : null;
}

function validateAssignmentV1(value) {
  exact(value, ["agentProfile"], "Assignment");
  if (!Object.values(AGENT_BY_TASK).includes(value.agentProfile)) {
    throw new WorkGraphError("Assignment.agentProfile is not supported");
  }
}

function validateAssignmentV2(value) {
  exact(value, ["agentProfile", "workerId"], "Assignment");
  validateAssignmentV1({ agentProfile: value.agentProfile });
  opaque(value.workerId, "Assignment.workerId");
}

function validateResult(value, version = 2) {
  exact(
    value,
    version === 2
      ? ["taskType", "leaseId", "outcome", "summary", "result"]
      : ["taskType", "outcome", "summary", "result"],
    "Result",
  );
  if (version === 2) opaque(value.leaseId, "Result.leaseId");
  if (!TASK_TYPES.includes(value.taskType)) {
    throw new WorkGraphError("Result.taskType is not supported");
  }
  if (!OUTCOMES.includes(value.outcome)) {
    throw new WorkGraphError("Result.outcome is not supported");
  }
  plain(value.summary, "Result.summary");
  if (value.taskType === "validate-issue") {
    exact(value.result, ["criteria"], "Result.result");
    if (!Array.isArray(value.result.criteria) || value.result.criteria.length !== 2) {
      throw new WorkGraphError("validation Result must contain exactly two criteria");
    }
    value.result.criteria.forEach((entry, index) => {
      exact(entry, ["criterion", "passed", "evidence"], `criterion[${index}]`);
      if (entry.criterion !== CRITERIA[index]) {
        throw new WorkGraphError("validation criteria must match the repository profile");
      }
      if (typeof entry.passed !== "boolean") {
        throw new WorkGraphError(`criterion[${index}].passed must be boolean`);
      }
      plain(entry.evidence, `criterion[${index}].evidence`);
    });
  } else {
    exact(value.result, ["requestCommentNodeId"], "Result.result");
    identifier(
      value.result.requestCommentNodeId,
      "Result.result.requestCommentNodeId",
    );
  }
}

export function formatTaskResult(result) {
  validateResult(result, 2);
  return canonicalJson(RESULT_V2_MARKER, result);
}

export function formatHistoricalTaskResult(result) {
  validateResult(result, 1);
  return canonicalJson(RESULT_V1_MARKER, result);
}

function validateLease(value) {
  exact(
    value,
    [
      "leaseId",
      "assignmentCommentNodeId",
      "workerId",
      "slotId",
      "acquiredAt",
      "expiresAt",
    ],
    "Lease",
  );
  for (const key of ["leaseId", "assignmentCommentNodeId", "workerId", "slotId"]) {
    opaque(value[key], `Lease.${key}`);
  }
  timestamp(value.acquiredAt, "Lease.acquiredAt");
  timestamp(value.expiresAt, "Lease.expiresAt");
  if (Date.parse(value.acquiredAt) >= Date.parse(value.expiresAt)) {
    throw new WorkGraphError("Lease.acquiredAt must be before Lease.expiresAt");
  }
}

function validateLeaseExpiration(value) {
  exact(
    value,
    ["leaseCommentNodeId", "leaseId", "expiredAt", "reason"],
    "LeaseExpiration",
  );
  opaque(value.leaseCommentNodeId, "LeaseExpiration.leaseCommentNodeId");
  opaque(value.leaseId, "LeaseExpiration.leaseId");
  timestamp(value.expiredAt, "LeaseExpiration.expiredAt");
  nonempty(value.reason, "LeaseExpiration.reason");
  if (value.reason.length > 512) {
    throw new WorkGraphError("LeaseExpiration.reason must not exceed 512 characters");
  }
}

export function formatLease(value) {
  validateLease(value);
  return canonicalJson(LEASE_MARKER, value);
}

export function formatLeaseExpiration(value) {
  validateLeaseExpiration(value);
  return canonicalJson(LEASE_EXPIRATION_MARKER, value);
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new WorkGraphError(`${label} must be canonical UTC YYYY-MM-DDTHH:MM:SSZ`);
  }
}

function opaque(value, label) {
  nonempty(value, label);
  if (
    value.length > MAX_ID ||
    [...value].some((character) => /\s/.test(character) || /[\x00-\x1f\x7f]/.test(character))
  ) {
    throw new WorkGraphError(`${label} must be a bounded opaque ID`);
  }
}

function parseAssignment(body) {
  const v2 = parseCanonicalJson(body, ASSIGNMENT_V2_MARKER, validateAssignmentV2);
  if (v2) return { version: 2, payload: v2 };
  const v1 = parseCanonicalJson(body, ASSIGNMENT_V1_MARKER, validateAssignmentV1);
  return v1 ? { version: 1, payload: v1 } : null;
}

function parseResult(body) {
  const v2 = parseCanonicalJson(body, RESULT_V2_MARKER, (value) =>
    validateResult(value, 2),
  );
  if (v2) return { version: 2, payload: v2 };
  const v1 = parseCanonicalJson(body, RESULT_V1_MARKER, (value) =>
    validateResult(value, 1),
  );
  return v1 ? { version: 1, payload: v1 } : null;
}

function validateQueueWorker(value, index) {
  exact(value, ["workerId", "agentProfile", "queueDepth"], `compatibleWorkers[${index}]`);
  opaque(value.workerId, `compatibleWorkers[${index}].workerId`);
  if (!Object.values(AGENT_BY_TASK).includes(value.agentProfile)) {
    throw new WorkGraphError(`compatibleWorkers[${index}].agentProfile is unsupported`);
  }
  if (!Number.isSafeInteger(value.queueDepth) || value.queueDepth < 0) {
    throw new WorkGraphError(`compatibleWorkers[${index}].queueDepth must be non-negative`);
  }
}

export function selectWorker(compatibleWorkers, agentProfile) {
  if (!Array.isArray(compatibleWorkers) || compatibleWorkers.length === 0) {
    throw new WorkGraphError("compatibleWorkers must be a non-empty array");
  }
  const seen = new Set();
  const compatible = compatibleWorkers.filter((worker, index) => {
    validateQueueWorker(worker, index);
    if (seen.has(worker.workerId)) {
      throw new WorkGraphError("compatibleWorkers workerId values must be unique");
    }
    seen.add(worker.workerId);
    return worker.agentProfile === agentProfile;
  });
  if (compatible.length === 0) {
    throw new WorkGraphError("compatibleWorkers has no worker for agentProfile");
  }
  compatible.sort(
    (left, right) =>
      left.queueDepth - right.queueDepth ||
      (left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0),
  );
  return compatible[0];
}

function durationSeconds(value, label) {
  const match =
    typeof value === "string"
      ? value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
      : null;
  if (!match || match.slice(1).every((part) => part === undefined)) {
    throw new WorkGraphError(`${label} must be a whole-unit ISO-8601 duration`);
  }
  const seconds =
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new WorkGraphError(`${label} must be between one second and 24 hours`);
  }
  return seconds;
}

export function parseWorkersYaml(body) {
  if (
    typeof body !== "string" ||
    new TextEncoder().encode(body).length > 256 * 1024 ||
    body.includes("\r")
  ) {
    throw new WorkGraphError("worker config must be bounded LF UTF-8 text");
  }
  const root = body.match(/^version: 1\nworkers:\n([\s\S]+)$/);
  if (!root) {
    throw new WorkGraphError("worker config must have version 1 and a workers list");
  }
  const entryPattern =
    /  - workerId: ([A-Za-z0-9._-]{1,64})\n    agentProfile: ([A-Za-z0-9_-]+)\n    slots: (\d+)\n    leaseDuration: ([A-Z0-9]+)\n/g;
  const workers = [];
  let consumed = "";
  for (const match of root[1].matchAll(entryPattern)) {
    consumed += match[0];
    const worker = {
      workerId: match[1],
      agentProfile: match[2],
      slots: Number(match[3]),
      leaseDuration: match[4],
    };
    if (!Object.values(AGENT_BY_TASK).includes(worker.agentProfile)) {
      throw new WorkGraphError("worker config agentProfile is unsupported");
    }
    if (!Number.isSafeInteger(worker.slots) || worker.slots < 1 || worker.slots > 16) {
      throw new WorkGraphError("worker config slots must be between 1 and 16");
    }
    durationSeconds(worker.leaseDuration, "worker config leaseDuration");
    workers.push(worker);
  }
  if (consumed !== root[1] || workers.length === 0 || workers.length > 64) {
    throw new WorkGraphError("worker config contains unsupported or malformed fields");
  }
  if (new Set(workers.map((worker) => worker.workerId)).size !== workers.length) {
    throw new WorkGraphError("worker config workerId values must be unique");
  }
  return workers;
}

function validateAcceptance(value) {
  exact(
    value,
    ["resultCommentNodeId", "resultBodyDigest", "summary"],
    "Acceptance",
  );
  identifier(value.resultCommentNodeId, "Acceptance.resultCommentNodeId");
  if (
    typeof value.resultBodyDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.resultBodyDigest)
  ) {
    throw new WorkGraphError("Acceptance.resultBodyDigest must be sha256:<64 lowercase hex>");
  }
  plain(value.summary, "Acceptance.summary");
}

export function formatAcceptance(value) {
  validateAcceptance(value);
  return canonicalJson(ACCEPTANCE_MARKER, value);
}

function validateFeedback(value) {
  exact(
    value,
    ["resultCommentNodeId", "resultBodyDigest", "feedback"],
    "Feedback",
  );
  identifier(value.resultCommentNodeId, "Feedback.resultCommentNodeId");
  if (
    typeof value.resultBodyDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.resultBodyDigest)
  ) {
    throw new WorkGraphError("Feedback.resultBodyDigest must be sha256:<64 lowercase hex>");
  }
  plain(value.feedback, "Feedback.feedback");
}

export function resultDigest(body) {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function digestString(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new WorkGraphError(`${label} must be sha256:<64 lowercase hex>`);
  }
  return value;
}

function structured(body, marker) {
  return typeof body === "string" && body.includes(marker);
}

function envId(name) {
  const value = Number(process.env[name] ?? "");
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkGraphError(`${name} must be a positive integer`);
  }
  return value;
}

function config() {
  const token = process.env.COPILOT_MCP_WORKGRAPH_TOKEN ?? "";
  const taskTypeId =
    process.env.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID ?? "";
  if (!token) throw new WorkGraphError("COPILOT_MCP_WORKGRAPH_TOKEN is required");
  identifier(taskTypeId, "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID");
  let api = API;
  if (
    process.env.NODE_ENV === "test" &&
    process.env.WORKGRAPH_TEST_GITHUB_API_URL
  ) {
    const url = new URL(process.env.WORKGRAPH_TEST_GITHUB_API_URL);
    if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
      throw new WorkGraphError("test API URL must be loopback HTTP");
    }
    api = url.toString().replace(/\/$/, "");
  }
  return {
    token,
    taskTypeId,
    launcherId: envId("COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID"),
    assignmentId: envId("COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID"),
    resultId: envId("COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID"),
    acceptanceId: envId("COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID"),
    orchestratorId: envId("COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID"),
    infoId: envId("COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID"),
    redispatchId: envId("COPILOT_MCP_WORKGRAPH_REDISPATCH_REPORTER_USER_ID"),
    dispatcherId: envId("COPILOT_MCP_WORKGRAPH_DISPATCHER_USER_ID"),
    leaseReporterId: envId("COPILOT_MCP_WORKGRAPH_LEASE_REPORTER_USER_ID"),
    api,
  };
}

class GitHub {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async request(method, route, payload, { allowNotFound = false } = {}) {
    let response;
    try {
      response = await fetch(`${this.cfg.api}${route}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.cfg.token}`,
          "Content-Type": "application/json",
          "User-Agent": "drasi-workgraph-reporter",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new WorkGraphError(`GitHub request failed: ${error.message}`);
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new WorkGraphError("GitHub response was not JSON");
      }
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new WorkGraphError(
        `GitHub request failed with HTTP ${response.status}: ${body?.message ?? text}`,
      );
    }
    return body;
  }

  identity() {
    return this.request("GET", "/user");
  }
  issue(number) {
    return this.request("GET", `/repos/${OWNER}/${REPO}/issues/${number}`);
  }
  parent(number) {
    return this.request("GET", `/repos/${OWNER}/${REPO}/issues/${number}/parent`);
  }
  optionalParent(number) {
    return this.request(
      "GET",
      `/repos/${OWNER}/${REPO}/issues/${number}/parent`,
      undefined,
      { allowNotFound: true },
    );
  }
  comment(id) {
    return this.request("GET", `/repos/${OWNER}/${REPO}/issues/comments/${id}`);
  }
  workerConfig() {
    return this.request(
      "GET",
      `/repos/${OWNER}/${REPO}/contents/${WORKER_CONFIG_PATH}?ref=${WORKER_CONFIG_REF}`,
    );
  }
  async paginate(route) {
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = route.includes("?") ? "&" : "?";
      const batch = await this.request(
        "GET",
        `${route}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new WorkGraphError("paginated GitHub response must be an array");
      }

      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new WorkGraphError("GitHub pagination exceeded 100 pages");
  }
  comments(number) {
    return this.paginate(`/repos/${OWNER}/${REPO}/issues/${number}/comments`);
  }
  subIssues(number) {
    return this.paginate(
      `/repos/${OWNER}/${REPO}/issues/${number}/sub_issues`,
    );
  }
  openIssues() {
    return this.paginate(`/repos/${OWNER}/${REPO}/issues?state=open`);
  }
  postComment(number, body) {
    return this.request(
      "POST",
      `/repos/${OWNER}/${REPO}/issues/${number}/comments`,
      { body },
    );
  }
  patchComment(id, body) {
    return this.request(
      "PATCH",
      `/repos/${OWNER}/${REPO}/issues/comments/${id}`,
      { body },
    );
  }
  createIssue(title, body) {
    return this.request("POST", `/repos/${OWNER}/${REPO}/issues`, {
      title,
      body,
      type: TASK_TYPE_NAME,
    });
  }
  attachSubIssue(parentNumber, childId) {
    return this.request(
      "POST",
      `/repos/${OWNER}/${REPO}/issues/${parentNumber}/sub_issues`,
      { sub_issue_id: childId },
    );
  }
  replaceLabels(number, labels) {
    return this.request(
      "PUT",
      `/repos/${OWNER}/${REPO}/issues/${number}/labels`,
      { labels },
    );
  }
}

async function authoritativeWorkers(github) {
  const response = await github.workerConfig();
  if (
    !object(response) ||
    response.path !== WORKER_CONFIG_PATH ||
    response.encoding !== "base64" ||
    typeof response.content !== "string" ||
    typeof response.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(response.sha)
  ) {
    throw new WorkGraphError("authoritative worker config response is invalid");
  }
  let bytes;
  const encoded = response.content.replace(/\n/g, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new WorkGraphError("authoritative worker config is not valid base64");
  }
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    throw new WorkGraphError("authoritative worker config is not valid base64");
  }
  let body;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkGraphError("authoritative worker config is not valid UTF-8");
  }
  return parseWorkersYaml(body);
}

function verifyIdentity(identity, expected, label) {
  if (!object(identity) || identity.id !== expected || !identity.login) {
    throw new WorkGraphError(`token identity does not match configured ${label}`);
  }
}

function validateParent(parent, input) {
  if (
    !object(parent) ||
    parent.pull_request ||
    parent.number !== input.parentIssueNumber ||
    parent.node_id !== input.parentIssueNodeId ||
    parent.state !== "open"
  ) {
    throw new WorkGraphError("native parent is not the requested open Issue");
  }
  if (parent.repository_url !== REPOSITORY_URL) {
    throw new WorkGraphError("native parent is outside the fixed repository");
  }
}

function validateTaskIssue(task, input, cfg, { open = false } = {}) {
  if (
    !object(task) ||
    task.pull_request ||
    task.number !== input.taskIssueNumber ||
    task.node_id !== input.taskIssueNodeId ||
    task.repository_url !== REPOSITORY_URL
  ) {
    throw new WorkGraphError("task is not the requested fixed-repository Issue");
  }
  if (
    task.type?.name !== TASK_TYPE_NAME ||
    task.type?.node_id !== cfg.taskTypeId
  ) {
    throw new WorkGraphError("task does not have the configured exact WorkGraphTask type name and ID");
  }
  if (task.user?.id !== cfg.launcherId) {
    throw new WorkGraphError("task creator is not the configured launcher identity");
  }
  if (open && task.state !== "open") {
    throw new WorkGraphError("task must be open");
  }
  return parseTask(task.body);
}

async function context(github, input, cfg, options) {
  const [identity, task, parent] = await Promise.all([
    github.identity(),
    github.issue(input.taskIssueNumber),
    github.parent(input.taskIssueNumber),
  ]);
  verifyIdentity(identity, options.actorId, options.actorLabel);
  const taskPayload = validateTaskIssue(task, input, cfg, { open: options.open });
  validateParent(parent, input);
  return { identity, task, parent, taskPayload };
}

function candidates(comments, marker, parser) {
  const marked = comments.filter((comment) => structured(comment.body, marker));
  return {
    marked,
    parsed: marked.map((comment) => ({
      comment,
      payload: parser(comment.body),
    })),
  };
}

function oneAssignment(
  comments,
  taskPayload,
  cfg,
  { requireV2 = false, workerId = null, assignmentCommentNodeId = null } = {},
) {
  const found = candidates(comments, ASSIGNMENT_FAMILY, parseAssignment);
  if (
    found.marked.length !== 1 ||
    !found.parsed[0]?.payload ||
    found.parsed[0].comment.user?.id !== cfg.assignmentId
  ) {
    throw new WorkGraphError("task must have one canonical Assignment by the configured Assignment reporter");
  }
  const entry = {
    comment: found.parsed[0].comment,
    version: found.parsed[0].payload.version,
    payload: found.parsed[0].payload.payload,
  };
  if (entry.payload.agentProfile !== AGENT_BY_TASK[taskPayload.taskType]) {
    throw new WorkGraphError("Assignment agentProfile does not match taskType");
  }
  if (
    requireV2 &&
    (entry.version !== 2 ||
      entry.payload.workerId !== workerId ||
      entry.comment.node_id !== assignmentCommentNodeId)
  ) {
    throw new WorkGraphError(
      "active work requires the exact Assignment/v2 worker and comment ID",
    );
  }
  return entry;
}

function oneResult(comments, taskPayload, cfg) {
  const found = candidates(comments, RESULT_FAMILY, parseResult);
  if (
    found.marked.length !== 1 ||
    !found.parsed[0]?.payload ||
    found.parsed[0].comment.user?.id !== cfg.resultId
  ) {
    throw new WorkGraphError("task must have one canonical Result by the configured Result reporter");
  }
  const entry = {
    comment: found.parsed[0].comment,
    version: found.parsed[0].payload.version,
    payload: found.parsed[0].payload.payload,
  };
  if (entry.payload.taskType !== taskPayload.taskType) {
    throw new WorkGraphError("Result taskType does not match the task");
  }
  return entry;
}

function acceptanceFor(comments, resultEntry, cfg) {
  const found = candidates(comments, ACCEPTANCE_MARKER, (body) =>
    parseCanonicalJson(body, ACCEPTANCE_MARKER, validateAcceptance),
  );
  if (found.parsed.length !== 1 || !found.parsed[0].payload) {
    throw new WorkGraphError("task must have one canonical Result Acceptance");
  }
  const entry = found.parsed[0];
  if (entry.comment.user?.id !== cfg.acceptanceId) {
    throw new WorkGraphError("Acceptance author is not configured");
  }
  const digest = resultDigest(resultEntry.comment.body);
  if (
    entry.payload.resultCommentNodeId !== resultEntry.comment.node_id ||
    entry.payload.resultBodyDigest !== digest
  ) {
    throw new WorkGraphError("Acceptance does not target the exact current Result and digest");
  }
  return entry;
}

function verifiedCommentWrite(comment, expectedBody, actorId, label) {
  if (
    !object(comment) ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    typeof comment.node_id !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(comment.node_id) ||
    comment.user?.id !== actorId ||
    comment.body !== expectedBody
  ) {
    throw new WorkGraphError(`${label} write response did not reconcile`);
  }
  return comment;
}

function verifyResultSnapshot(comment, expected, cfg) {
  if (
    !object(comment) ||
    comment.id !== expected.id ||
    comment.node_id !== expected.node_id ||
    comment.user?.id !== cfg.resultId ||
    comment.body !== expected.body
  ) {
    throw new WorkGraphError("current Result changed during reconciliation");
  }
}

async function submitAssignment(input, github, cfg) {
  refs(input, ["agentProfile", "workerId", "compatibleWorkers"]);
  if (!Object.values(AGENT_BY_TASK).includes(input.agentProfile)) {
    throw new WorkGraphError("arguments.agentProfile is unsupported");
  }
  opaque(input.workerId, "arguments.workerId");
  const selected = selectWorker(input.compatibleWorkers, input.agentProfile);
  if (selected.workerId !== input.workerId) {
    throw new WorkGraphError(
      "workerId must be the lowest queue depth, then lexicographically lowest workerId",
    );
  }
  const ctx = await context(github, input, cfg, {
    actorId: cfg.assignmentId,
    actorLabel: "Assignment reporter",
    open: true,
  });
  if (input.agentProfile !== AGENT_BY_TASK[ctx.taskPayload.taskType]) {
    throw new WorkGraphError("agentProfile does not match taskType");
  }
  const workers = await authoritativeWorkers(github);
  const configured = workers.find((worker) => worker.workerId === input.workerId);
  if (!configured || configured.agentProfile !== input.agentProfile) {
    throw new WorkGraphError(
      "selected worker is absent from authoritative config or incompatible",
    );
  }
  const comments = await github.comments(input.taskIssueNumber);
  const found = candidates(comments, ASSIGNMENT_FAMILY, parseAssignment);
  const body = formatAssignment(input.agentProfile, input.workerId);
  if (found.marked.length > 0) {
    if (
      found.marked.length === 1 &&
      found.parsed[0].payload?.version === 2 &&
      found.parsed[0].payload.payload.agentProfile === input.agentProfile &&
      found.parsed[0].payload.payload.workerId === input.workerId &&
      found.parsed[0].comment.user?.id === cfg.assignmentId &&
      found.parsed[0].comment.body === body
    ) {
      return {
        commentNodeId: found.parsed[0].comment.node_id,
        reconciled: true,
      };
    }
    throw new WorkGraphError("task already has a malformed, foreign, or conflicting Assignment");
  }
  const beforeCtx = await context(github, input, cfg, {
    actorId: cfg.assignmentId,
    actorLabel: "Assignment reporter",
    open: true,
  });
  if (beforeCtx.taskPayload.taskType !== ctx.taskPayload.taskType) {
    throw new WorkGraphError("task changed immediately before Assignment");
  }
  const beforeWorkers = await authoritativeWorkers(github);
  const beforeWorker = beforeWorkers.find(
    (worker) => worker.workerId === input.workerId,
  );
  if (!beforeWorker || beforeWorker.agentProfile !== input.agentProfile) {
    throw new WorkGraphError("worker config changed immediately before Assignment");
  }
  const beforeComments = await github.comments(input.taskIssueNumber);
  if (candidates(beforeComments, ASSIGNMENT_FAMILY, parseAssignment).marked.length > 0) {
    throw new WorkGraphError("Assignment appeared immediately before creation");
  }
  const comment = verifiedCommentWrite(
    await github.postComment(input.taskIssueNumber, body),
    body,
    cfg.assignmentId,
    "Assignment",
  );
  const afterComments = await github.comments(input.taskIssueNumber);
  const afterAssignment = oneAssignment(afterComments, ctx.taskPayload, cfg, {
    requireV2: true,
    workerId: input.workerId,
    assignmentCommentNodeId: comment.node_id,
  });
  if (afterAssignment.comment.body !== body) {
    throw new WorkGraphError(
      "Assignment race left the task inconsistent; manual remediation is required",
    );
  }
  return { commentNodeId: comment.node_id, reconciled: false };
}

function validateRequestedResult(result, taskPayload, leaseId) {
  validateResult(result, 2);
  if (result.taskType !== taskPayload.taskType) {
    throw new WorkGraphError("Result taskType does not match taskType");
  }
  if (result.leaseId !== leaseId) {
    throw new WorkGraphError("Result.leaseId must match the active dispatch Lease");
  }
}

async function verifyInfoResult(result, parentComments, taskPayload, cfg) {
  const comment = parentComments.find(
    (item) => item.node_id === result.result.requestCommentNodeId,
  );
  if (
    !comment ||
    comment.user?.id !== cfg.infoId ||
    !structured(comment.body, INFO_MARKER) ||
    !comment.body.includes(taskPayload.inputs.validationResultCommentNodeId)
  ) {
    throw new WorkGraphError("request-info Result does not identify the canonical parent info comment");
  }
}

const LEASE_ARGUMENTS = [
  "assignmentCommentNodeId",
  "leaseCommentNodeId",
  "leaseId",
  "workerId",
  "slotId",
  "acquiredAt",
  "expiresAt",
];
const FEEDBACK_ARGUMENTS = [
  "feedbackCommentNodeId",
  "feedbackUpdatedAt",
  "resultCommentNodeId",
  "resultBodyDigest",
];

function nowMilliseconds() {
  if (process.env.NODE_ENV === "test" && process.env.WORKGRAPH_TEST_NOW) {
    timestamp(process.env.WORKGRAPH_TEST_NOW, "WORKGRAPH_TEST_NOW");
    return Date.parse(process.env.WORKGRAPH_TEST_NOW);
  }
  return Date.now();
}

function parseLeaseComments(comments, cfg) {
  const found = candidates(comments, "WorkGraphTaskLease/", (body) =>
    parseCanonicalJson(body, LEASE_MARKER, validateLease),
  );
  if (found.marked.some((_, index) => !found.parsed[index].payload)) {
    throw new WorkGraphError("task has a malformed or unsupported Lease");
  }
  return found.parsed.map((entry) => {
    if (entry.comment.user?.id !== cfg.dispatcherId) {
      throw new WorkGraphError("Lease author is not the configured dispatcher");
    }
    return entry;
  });
}

function parseExpirationComments(comments, cfg) {
  const found = candidates(comments, "WorkGraphTaskLeaseExpiration/", (body) =>
    parseCanonicalJson(body, LEASE_EXPIRATION_MARKER, validateLeaseExpiration),
  );
  if (found.marked.some((_, index) => !found.parsed[index].payload)) {
    throw new WorkGraphError("task has a malformed or unsupported LeaseExpiration");
  }
  return found.parsed.map((entry) => {
    if (entry.comment.user?.id !== cfg.leaseReporterId) {
      throw new WorkGraphError("LeaseExpiration author is not configured");
    }
    return entry;
  });
}

async function validateLeaseDispatch(
  comments,
  input,
  taskPayload,
  github,
  cfg,
  { allowExactResultBody = null } = {},
) {
  const assignment = oneAssignment(comments, taskPayload, cfg, {
    requireV2: true,
    workerId: input.workerId,
    assignmentCommentNodeId: input.assignmentCommentNodeId,
  });
  const workers = await authoritativeWorkers(github);
  const worker = workers.find((candidate) => candidate.workerId === input.workerId);
  if (!worker || worker.agentProfile !== assignment.payload.agentProfile) {
    throw new WorkGraphError(
      "Lease worker is absent from authoritative config or profile-incompatible",
    );
  }
  const slotMatch = input.slotId.match(/^(.+)\/([1-9]\d*)$/);
  if (
    !slotMatch ||
    slotMatch[1] !== input.workerId ||
    Number(slotMatch[2]) > worker.slots
  ) {
    throw new WorkGraphError("Lease slotId is not an enabled slot for the worker");
  }
  const leases = parseLeaseComments(comments, cfg);
  const matchingId = leases.filter((entry) => entry.payload.leaseId === input.leaseId);
  if (matchingId.length !== 1) {
    throw new WorkGraphError(
      matchingId.length === 0
        ? "active Lease is absent"
        : "duplicate Lease acquisitions conflict for leaseId",
    );
  }
  const lease = matchingId[0];
  const expected = {
    leaseId: input.leaseId,
    assignmentCommentNodeId: input.assignmentCommentNodeId,
    workerId: input.workerId,
    slotId: input.slotId,
    acquiredAt: input.acquiredAt,
    expiresAt: input.expiresAt,
  };
  validateLease(expected);
  if (
    lease.comment.node_id !== input.leaseCommentNodeId ||
    !isDeepStrictEqual(lease.payload, expected)
  ) {
    throw new WorkGraphError("dispatch does not match the exact Lease comment and fields");
  }
  const newerLease = leases.find(
    (entry) =>
      entry.comment.node_id !== lease.comment.node_id &&
      (Date.parse(entry.payload.acquiredAt) > Date.parse(lease.payload.acquiredAt) ||
        (entry.payload.acquiredAt === lease.payload.acquiredAt &&
          entry.comment.node_id > lease.comment.node_id)),
  );
  if (newerLease) {
    throw new WorkGraphError("Lease is superseded by a newer conflicting Lease");
  }
  const expirations = parseExpirationComments(comments, cfg);
  if (
    expirations.some(
      (entry) =>
        entry.payload.leaseId === input.leaseId &&
        entry.payload.leaseCommentNodeId === input.leaseCommentNodeId,
    )
  ) {
    throw new WorkGraphError("Lease has already ended by expiration");
  }
  const results = candidates(comments, RESULT_FAMILY, parseResult);
  if (results.marked.some((_, index) => !results.parsed[index].payload)) {
    throw new WorkGraphError("task has a malformed or unsupported Result");
  }
  const endingResults = results.parsed.filter(
    (entry) =>
      entry.payload.version === 2 &&
      entry.payload.payload.leaseId === input.leaseId,
  );
  if (
    endingResults.length > 0 &&
    !(
      endingResults.length === 1 &&
      allowExactResultBody !== null &&
      endingResults[0].comment.body === allowExactResultBody
    )
  ) {
    throw new WorkGraphError("Lease has already ended by Result");
  }
  if (nowMilliseconds() >= Date.parse(input.expiresAt)) {
    throw new WorkGraphError("Lease is expired; stale late Result rejected");
  }
  return { assignment, lease, worker };
}

function validateFeedbackRevision(input, comments, current, cfg) {
  const feedbackCandidates = candidates(comments, FEEDBACK_MARKER, (body) =>
    parseCanonicalJson(body, FEEDBACK_MARKER, validateFeedback),
  );
  if (
    feedbackCandidates.marked.length !== 1 ||
    !feedbackCandidates.parsed[0].payload ||
    feedbackCandidates.parsed[0].comment.user?.id !== cfg.redispatchId
  ) {
    throw new WorkGraphError("feedback revision requires one canonical configured-author feedback");
  }
  const feedback = feedbackCandidates.parsed[0];
  timestamp(input.feedbackUpdatedAt, "arguments.feedbackUpdatedAt");
  if (
    feedback.comment.node_id !== input.feedbackCommentNodeId ||
    feedback.comment.updated_at !== input.feedbackUpdatedAt ||
    feedback.payload.resultCommentNodeId !== input.resultCommentNodeId ||
    feedback.payload.resultBodyDigest !== input.resultBodyDigest ||
    current.comment.node_id !== input.resultCommentNodeId ||
    resultDigest(current.comment.body) !== input.resultBodyDigest
  ) {
    throw new WorkGraphError("feedback dispatch does not bind the exact current Result revision");
  }
  if (Date.parse(input.acquiredAt) < Date.parse(input.feedbackUpdatedAt)) {
    throw new WorkGraphError("feedback worker Lease predates the feedback request");
  }
  const oldSemantic = { ...current.payload };
  delete oldSemantic.leaseId;
  const newSemantic = { ...input.workResult };
  delete newSemantic.leaseId;
  if (isDeepStrictEqual(oldSemantic, newSemantic)) {
    throw new WorkGraphError("feedback must materially revise the existing Result");
  }
  if (
    current.payload.taskType === "request-info" &&
    current.payload.result.requestCommentNodeId !==
      input.workResult.result.requestCommentNodeId
  ) {
    throw new WorkGraphError("feedback cannot replace the reporter-owned parent info request");
  }
  return feedback;
}

async function submitResult(input, github, cfg) {
  const hasFeedback = FEEDBACK_ARGUMENTS.some((key) =>
    Object.prototype.hasOwnProperty.call(input, key),
  );
  refs(input, [
    "workResult",
    ...LEASE_ARGUMENTS,
    ...(hasFeedback ? FEEDBACK_ARGUMENTS : []),
  ]);
  if (
    hasFeedback &&
    !FEEDBACK_ARGUMENTS.every((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    )
  ) {
    throw new WorkGraphError("feedback dispatch fields must be supplied together");
  }
  for (const key of [
    "assignmentCommentNodeId",
    "leaseCommentNodeId",
    "leaseId",
    "workerId",
    "slotId",
  ]) {
    opaque(input[key], `arguments.${key}`);
  }
  timestamp(input.acquiredAt, "arguments.acquiredAt");
  timestamp(input.expiresAt, "arguments.expiresAt");
  const ctx = await context(github, input, cfg, {
    actorId: cfg.resultId,
    actorLabel: "Result reporter",
    open: true,
  });
  validateRequestedResult(input.workResult, ctx.taskPayload, input.leaseId);
  const [comments, parentComments] = await Promise.all([
    github.comments(input.taskIssueNumber),
    ctx.taskPayload.taskType === "request-info"
      ? github.comments(input.parentIssueNumber)
      : Promise.resolve([]),
  ]);
  const body = formatTaskResult(input.workResult);
  const resultCandidates = candidates(comments, RESULT_FAMILY, parseResult);
  if (resultCandidates.marked.some((_, index) => !resultCandidates.parsed[index].payload)) {
    throw new WorkGraphError("task has a malformed, foreign, or conflicting Result");
  }
  const existing =
    resultCandidates.marked.length === 0
      ? null
      : oneResult(comments, ctx.taskPayload, cfg);
  if (existing?.comment.body === body) {
    await validateLeaseDispatch(comments, input, ctx.taskPayload, github, cfg, {
      allowExactResultBody: body,
    });
    return {
      commentNodeId: existing.comment.node_id,
      resultBodyDigest: resultDigest(body),
      revised: false,
      reconciled: true,
    };
  }
  await validateLeaseDispatch(comments, input, ctx.taskPayload, github, cfg);
  if (ctx.taskPayload.taskType === "request-info") {
    await verifyInfoResult(input.workResult, parentComments, ctx.taskPayload, cfg);
  }
  if (existing === null) {
    if (hasFeedback) {
      throw new WorkGraphError("feedback revision requires an existing Result");
    }
    const beforeComments = await github.comments(input.taskIssueNumber);
    await validateLeaseDispatch(beforeComments, input, ctx.taskPayload, github, cfg);
    if (candidates(beforeComments, RESULT_FAMILY, parseResult).marked.length !== 0) {
      throw new WorkGraphError("Result appeared immediately before creation");
    }
    const comment = verifiedCommentWrite(
      await github.postComment(input.taskIssueNumber, body),
      body,
      cfg.resultId,
      "Result",
    );
    const afterComments = await github.comments(input.taskIssueNumber);
    const afterResult = oneResult(afterComments, ctx.taskPayload, cfg);
    if (afterResult.comment.node_id !== comment.node_id || afterResult.comment.body !== body) {
      throw new WorkGraphError("Result creation did not reconcile");
    }
    await validateLeaseDispatch(afterComments, input, ctx.taskPayload, github, cfg, {
      allowExactResultBody: body,
    });
    return {
      commentNodeId: comment.node_id,
      resultBodyDigest: resultDigest(body),
      revised: false,
      reconciled: false,
    };
  }
  if (!hasFeedback) {
    throw new WorkGraphError("existing Result may be revised only after feedback and a new Lease");
  }
  const current = existing.comment;
  validateFeedbackRevision(input, comments, existing, cfg);
  if (comments.some((comment) => structured(comment.body, ACCEPTANCE_MARKER))) {
    throw new WorkGraphError("an accepted Result cannot be revised");
  }
  if (!Number.isSafeInteger(current.id) || current.id <= 0) {
    throw new WorkGraphError("current Result lacks a REST comment ID for revision");
  }
  const beforeComments = await github.comments(input.taskIssueNumber);
  const beforeEntry = oneResult(beforeComments, ctx.taskPayload, cfg);
  verifyResultSnapshot(beforeEntry.comment, current, cfg);
  await validateLeaseDispatch(beforeComments, input, ctx.taskPayload, github, cfg);
  validateFeedbackRevision(input, beforeComments, beforeEntry, cfg);
  if (
    beforeComments.some((comment) =>
      structured(comment.body, ACCEPTANCE_MARKER),
    )
  ) {
    throw new WorkGraphError("an accepted Result cannot be revised");
  }
  verifyResultSnapshot(await github.comment(current.id), current, cfg);
  const revised = verifiedCommentWrite(
    await github.patchComment(current.id, body),
    body,
    cfg.resultId,
    "Result revision",
  );
  if (revised.node_id !== current.node_id || revised.id !== current.id) {
    throw new WorkGraphError("revised Result changed comment identity");
  }
  const afterComments = await github.comments(input.taskIssueNumber);
  if (
    afterComments.some((comment) =>
      structured(comment.body, ACCEPTANCE_MARKER),
    )
  ) {
    throw new WorkGraphError(
      "Result/Acceptance race left the task inconsistent; manual remediation is required",
    );
  }
  const afterResult = oneResult(afterComments, ctx.taskPayload, cfg).comment;
  verifyResultSnapshot(afterResult, revised, cfg);
  await validateLeaseDispatch(afterComments, input, ctx.taskPayload, github, cfg, {
    allowExactResultBody: body,
  });
  return {
    commentNodeId: revised.node_id,
    resultBodyDigest: resultDigest(body),
    revised: true,
    reconciled: false,
  };
}

async function submitAcceptance(input, github, cfg) {
  refs(input, [
    "resultCommentNodeId",
    "resultBodyDigest",
    "summary",
  ]);
  validateAcceptance({
    resultCommentNodeId: input.resultCommentNodeId,
    resultBodyDigest: input.resultBodyDigest,
    summary: input.summary,
  });
  const ctx = await context(github, input, cfg, {
    actorId: cfg.acceptanceId,
    actorLabel: "Acceptance reporter",
    open: true,
  });
  const comments = await github.comments(input.taskIssueNumber);
  oneAssignment(comments, ctx.taskPayload, cfg);
  const current = oneResult(comments, ctx.taskPayload, cfg);
  const digest = resultDigest(current.comment.body);
  if (
    current.comment.node_id !== input.resultCommentNodeId ||
    digest !== input.resultBodyDigest
  ) {
    throw new WorkGraphError("Acceptance request targets a stale Result ID or digest");
  }
  const payload = {
    resultCommentNodeId: input.resultCommentNodeId,
    resultBodyDigest: input.resultBodyDigest,
    summary: input.summary,
  };
  const body = formatAcceptance(payload);
  const found = candidates(comments, ACCEPTANCE_MARKER, (candidate) =>
    parseCanonicalJson(candidate, ACCEPTANCE_MARKER, validateAcceptance),
  );
  if (found.marked.length > 0) {
    if (
      found.parsed.length === 1 &&
      found.parsed[0].comment.user?.id === cfg.acceptanceId &&
      found.parsed[0].comment.body === body
    ) {
      if (!Number.isSafeInteger(current.comment.id) || current.comment.id <= 0) {
        throw new WorkGraphError("current Result lacks a REST comment ID");
      }
      verifyResultSnapshot(
        await github.comment(current.comment.id),
        current.comment,
        cfg,
      );
      acceptanceFor(comments, current, cfg);
      return {
        commentNodeId: found.parsed[0].comment.node_id,
        reconciled: true,
      };
    }
    throw new WorkGraphError("task already has a stale, malformed, foreign, or conflicting Acceptance");
  }
  const beforeComments = await github.comments(input.taskIssueNumber);
  oneAssignment(beforeComments, ctx.taskPayload, cfg);
  const beforeResult = oneResult(beforeComments, ctx.taskPayload, cfg);
  const beforeDigest = resultDigest(beforeResult.comment.body);
  if (
    beforeResult.comment.node_id !== input.resultCommentNodeId ||
    beforeDigest !== input.resultBodyDigest
  ) {
    throw new WorkGraphError("Acceptance request targets a stale Result ID or digest");
  }
  if (!Number.isSafeInteger(beforeResult.comment.id) || beforeResult.comment.id <= 0) {
    throw new WorkGraphError("current Result lacks a REST comment ID");
  }
  verifyResultSnapshot(
    await github.comment(beforeResult.comment.id),
    beforeResult.comment,
    cfg,
  );
  const beforeAcceptances = candidates(
    beforeComments,
    ACCEPTANCE_MARKER,
    (candidate) =>
      parseCanonicalJson(candidate, ACCEPTANCE_MARKER, validateAcceptance),
  );
  if (beforeAcceptances.marked.length > 0) {
    throw new WorkGraphError(
      "task already has a stale, malformed, foreign, or conflicting Acceptance",
    );
  }
  const comment = verifiedCommentWrite(
    await github.postComment(input.taskIssueNumber, body),
    body,
    cfg.acceptanceId,
    "Acceptance",
  );
  const afterComments = await github.comments(input.taskIssueNumber);
  const afterResult = oneResult(afterComments, ctx.taskPayload, cfg);
  if (
    afterResult.comment.node_id !== input.resultCommentNodeId ||
    resultDigest(afterResult.comment.body) !== input.resultBodyDigest
  ) {
    throw new WorkGraphError(
      "Result/Acceptance race left the task inconsistent; manual remediation is required",
    );
  }
  acceptanceFor(afterComments, afterResult, cfg);
  return { commentNodeId: comment.node_id, reconciled: false };
}

function infoBody(login, validationResultCommentNodeId, missing) {
  const bullets = missing.map((criterion) => `- ${criterion}`).join("\n");
  return (
    `@${login}, please provide the missing issue information:\n\n${bullets}\n\n` +
    `<!-- ${INFO_MARKER} validationResultCommentNodeId=${validationResultCommentNodeId} -->\n`
  );
}

async function postInfo(input, github, cfg) {
  refs(input, [
    "validationTaskIssueNumber",
    "validationTaskIssueNodeId",
    "validationResultCommentNodeId",
    ...LEASE_ARGUMENTS,
  ]);
  issueNumber(input.validationTaskIssueNumber, "arguments.validationTaskIssueNumber");
  identifier(input.validationTaskIssueNodeId, "arguments.validationTaskIssueNodeId");
  identifier(input.validationResultCommentNodeId, "arguments.validationResultCommentNodeId");
  const ctx = await context(github, input, cfg, {
    actorId: cfg.infoId,
    actorLabel: "Info reporter",
    open: true,
  });
  if (
    ctx.taskPayload.taskType !== "request-info" ||
    ctx.taskPayload.inputs.validationResultCommentNodeId !==
      input.validationResultCommentNodeId
  ) {
    throw new WorkGraphError("request-info task does not reference the requested validation Result");
  }
  const requestChildren = await authoritativeChildren(
    github,
    input.parentIssueNumber,
    cfg,
  );
  requireCurrentChild(requestChildren, input, "request-info");
  const requestComments = await github.comments(input.taskIssueNumber);
  await validateLeaseDispatch(
    requestComments,
    input,
    ctx.taskPayload,
    github,
    cfg,
  );
  const validationInput = {
    ...input,
    taskIssueNumber: input.validationTaskIssueNumber,
    taskIssueNodeId: input.validationTaskIssueNodeId,
  };
  const validationTask = await github.issue(input.validationTaskIssueNumber);
  const validationPayload = validateTaskIssue(validationTask, validationInput, cfg);
  if (validationPayload.taskType !== "validate-issue") {
    throw new WorkGraphError("referenced Result is not on a validate-issue task");
  }
  const validationParent = await github.parent(input.validationTaskIssueNumber);
  validateParent(validationParent, validationInput);
  const validationComments = await github.comments(input.validationTaskIssueNumber);
  oneAssignment(validationComments, validationPayload, cfg);
  const result = oneResult(validationComments, validationPayload, cfg);
  if (result.comment.node_id !== input.validationResultCommentNodeId) {
    throw new WorkGraphError("validation Result comment ID is not current");
  }
  acceptanceFor(validationComments, result, cfg);
  const missing = result.payload.result.criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => criterion.criterion);
  if (missing.length === 0) {
    throw new WorkGraphError("validation Result has no missing criteria");
  }
  if (
    typeof ctx.parent.user?.login !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(ctx.parent.user.login)
  ) {
    throw new WorkGraphError("parent submitter login is unavailable");
  }
  const body = infoBody(
    ctx.parent.user?.login,
    input.validationResultCommentNodeId,
    missing,
  );
  const parentComments = await github.comments(input.parentIssueNumber);
  const infoToken =
    `${INFO_MARKER} validationResultCommentNodeId=` +
    input.validationResultCommentNodeId;
  const marked = parentComments.filter(
    (comment) =>
      structured(comment.body, INFO_MARKER) &&
      comment.body.includes(infoToken),
  );
  if (marked.length > 0) {
    if (
      marked.length === 1 &&
      marked[0].user?.id === cfg.infoId &&
      marked[0].body === body
    ) {
      return {
        requestCommentNodeId: marked[0].node_id,
        reconciled: true,
      };
    }
    throw new WorkGraphError("parent already has a malformed, foreign, or conflicting info request");
  }
  const beforeRequestComments = await github.comments(input.taskIssueNumber);
  await validateLeaseDispatch(
    beforeRequestComments,
    input,
    ctx.taskPayload,
    github,
    cfg,
  );
  const beforeParentComments = await github.comments(input.parentIssueNumber);
  if (
    beforeParentComments.some(
      (comment) =>
        structured(comment.body, INFO_MARKER) &&
        comment.body.includes(infoToken),
    )
  ) {
    throw new WorkGraphError("parent info request appeared immediately before creation");
  }
  const comment = verifiedCommentWrite(
    await github.postComment(input.parentIssueNumber, body),
    body,
    cfg.infoId,
    "parent info request",
  );
  if (
    typeof comment.created_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(comment.created_at)
  ) {
    throw new WorkGraphError("parent info request response lacks a canonical timestamp");
  }
  return {
    requestCommentNodeId: comment.node_id,
    reconciled: false,
  };
}

function statusOf(issue) {
  const statuses = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((name) => STATUS_LABELS.includes(name));
  if (statuses.length !== 1) {
    throw new WorkGraphError("parent must have exactly one WorkGraph status label");
  }
  return statuses[0];
}

async function replaceStatus(github, input, expectedStatus, status) {
  const parent = await github.issue(input.parentIssueNumber);
  validateParent(parent, input);
  if (statusOf(parent) !== expectedStatus) {
    throw new WorkGraphError("parent status changed immediately before mutation");
  }
  const labels = (parent.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((name) => name && !STATUS_LABELS.includes(name));
  labels.push(status);
  const updated = await github.replaceLabels(parent.number, labels);
  const updatedNames = Array.isArray(updated)
    ? updated
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(Boolean)
        .sort()
    : [];
  if (
    !Array.isArray(updated) ||
    !isDeepStrictEqual(updatedNames, [...labels].sort()) ||
    updatedNames.filter((name) => STATUS_LABELS.includes(name)).join("") !==
      status
  ) {
    throw new WorkGraphError("status replacement response did not reconcile");
  }
}

async function authoritativeChildren(github, parentNumber, cfg) {
  const summaries = await github.subIssues(parentNumber);
  if (!Array.isArray(summaries)) {
    throw new WorkGraphError("sub-issues response must be an array");
  }
  const children = [];
  for (const summary of summaries) {
    if (
      !object(summary) ||
      !Number.isSafeInteger(summary.number) ||
      summary.number <= 0 ||
      summary.repository_url !== REPOSITORY_URL ||
      typeof summary.node_id !== "string" ||
      !summary.node_id
    ) {
      throw new WorkGraphError(
        "parent has a child outside the fixed repository or with invalid identity",
      );
    }
    const issue = await github.issue(summary.number);
    if (
      issue.number !== summary.number ||
      issue.node_id !== summary.node_id ||
      issue.repository_url !== REPOSITORY_URL
    ) {
      throw new WorkGraphError("child summary does not match the fixed-repository Issue");
    }
    if (issue.type?.name !== TASK_TYPE_NAME || issue.type?.node_id !== cfg.taskTypeId) {
      throw new WorkGraphError("parent has a child that is not the configured WorkGraphTask type");
    }
    if (issue.user?.id !== cfg.launcherId) {
      throw new WorkGraphError("child task has the wrong creator");
    }
    children.push(issue);
  }
  return children;
}

function requireNoOpenChildren(children, allowedNodeId = null) {
  if (
    children.some(
      (child) => child.state === "open" && child.node_id !== allowedNodeId,
    )
  ) {
    throw new WorkGraphError(
      "parent has an unexpected open child/sibling WorkGraphTask",
    );
  }
}

function requireCurrentChild(children, input, taskType) {
  const typed = children
    .map((child) => ({ child, payload: parseTask(child.body) }))
    .filter((entry) => entry.payload.taskType === taskType);
  if (typed.length === 0) {
    throw new WorkGraphError(`parent has no ${taskType} task`);
  }
  const latestNumber = Math.max(...typed.map((entry) => entry.child.number));
  const latest = typed.filter((entry) => entry.child.number === latestNumber);
  if (latest.length !== 1) {
    throw new WorkGraphError(`parent does not have one unique latest ${taskType} task`);
  }
  if (
    latest[0].child.number !== input.taskIssueNumber ||
    latest[0].child.node_id !== input.taskIssueNodeId
  ) {
    throw new WorkGraphError(`supplied task is not the current latest ${taskType} task`);
  }
  return latest[0];
}

function transitionTitle(parentNumber, transition, correlationNodeId = null) {
  let title;
  if (transition === "start-validation") {
    title = `WorkGraph: validate-issue parent #${parentNumber} start-validation`;
  } else if (transition === "advance-validation") {
    identifier(correlationNodeId, "transition validation Result correlation");
    title =
      `WorkGraph: request-info parent #${parentNumber} ` +
      `validation-result ${correlationNodeId}`;
  } else {
    identifier(correlationNodeId, "transition human reply correlation");
    title =
      `WorkGraph: validate-issue parent #${parentNumber} ` +
      `human-reply ${correlationNodeId}`;
  }
  if (title.length > MAX_TITLE) {
    throw new WorkGraphError("canonical transition title exceeds GitHub's limit");
  }
  return title;
}

function matchesTransitionTask(issue, title, body, cfg) {
  return (
    object(issue) &&
    !issue.pull_request &&
    issue.title === title &&
    issue.body === body &&
    issue.state === "open" &&
    issue.type?.name === TASK_TYPE_NAME &&
    issue.type?.node_id === cfg.taskTypeId &&
    issue.user?.id === cfg.launcherId
  );
}

async function findUnattachedTransitionTask(
  github,
  parentNumber,
  title,
  body,
  cfg,
) {
  const listed = await github.openIssues();
  const possible = listed.filter(
    (issue) =>
      object(issue) &&
      !issue.pull_request &&
      issue.title === title &&
      issue.body === body &&
      issue.state === "open" &&
      issue.user?.id === cfg.launcherId,
  );
  const unattached = [];
  for (const summary of possible) {
    const issue = await github.issue(summary.number);
    if (!matchesTransitionTask(issue, title, body, cfg)) continue;
    const nativeParent = await github.optionalParent(issue.number);
    if (nativeParent === null) {
      unattached.push(issue);
    } else if (nativeParent.number === parentNumber) {
      throw new WorkGraphError(
        "matching task parent relation is inconsistent with authoritative children",
      );
    } else {
      throw new WorkGraphError(
        "matching canonical transition task is attached to another parent",
      );
    }
  }
  if (unattached.length > 1) {
    throw new WorkGraphError(
      "multiple unattached Issues match the canonical transition correlation",
    );
  }
  return unattached[0] ?? null;
}

async function ensureTransitionTask(
  github,
  parent,
  children,
  task,
  transition,
  correlationNodeId,
  cfg,
  { create = true } = {},
) {
  const body = formatTask(task);
  const title = transitionTitle(parent.number, transition, correlationNodeId);
  const matching = children.filter((child) =>
    matchesTransitionTask(child, title, body, cfg),
  );
  if (matching.length > 1) {
    throw new WorkGraphError("multiple attached tasks match the transition correlation");
  }
  requireNoOpenChildren(children, matching[0]?.node_id ?? null);
  if (matching.length === 1) return matching[0];
  if (!create) {
    throw new WorkGraphError(
      "completed transition lacks its canonical correlated child task",
    );
  }
  let candidate = await findUnattachedTransitionTask(
    github,
    parent.number,
    title,
    body,
    cfg,
  );
  if (!candidate) {
    candidate = await github.createIssue(title, body);
    if (!matchesTransitionTask(candidate, title, body, cfg)) {
      throw new WorkGraphError(
        "created task did not reconcile to the canonical transition correlation",
      );
    }
  }
  await github.attachSubIssue(parent.number, candidate.id);
  const attached = await authoritativeChildren(github, parent.number, cfg);
  const reconciled = attached.filter((child) =>
    matchesTransitionTask(child, title, body, cfg),
  );
  if (reconciled.length !== 1) {
    throw new WorkGraphError("task attachment did not reconcile");
  }
  requireNoOpenChildren(attached, reconciled[0].node_id);
  return reconciled[0];
}

async function transitionIssue(input, github, cfg) {
  exact(input, [
    "parentIssueNumber",
    "parentIssueNodeId",
    "expectedStatus",
    "transition",
    ...(input.transition === "advance-validation"
      ? ["taskIssueNumber", "taskIssueNodeId", "resultCommentNodeId"]
      : input.transition === "resume-after-human-reply"
        ? [
            "taskIssueNumber",
            "taskIssueNodeId",
            "requestCommentNodeId",
            "humanReplyCommentNodeId",
          ]
        : []),
  ], "arguments");
  issueNumber(input.parentIssueNumber, "arguments.parentIssueNumber");
  identifier(input.parentIssueNodeId, "arguments.parentIssueNodeId");
  if (
    !["start-validation", "advance-validation", "resume-after-human-reply"].includes(
      input.transition,
    )
  ) {
    throw new WorkGraphError("arguments.transition is unsupported");
  }
  const expectedByTransition = {
    "start-validation": "status:new",
    "advance-validation": "status:awaiting-validation",
    "resume-after-human-reply": "status:awaiting-need-info",
  };
  if (input.expectedStatus !== expectedByTransition[input.transition]) {
    throw new WorkGraphError("supplied expectedStatus does not match transition");
  }
  const [identity, parent] = await Promise.all([
    github.identity(),
    github.issue(input.parentIssueNumber),
  ]);
  verifyIdentity(identity, cfg.orchestratorId, "orchestrator");
  validateParent(parent, input);
  const initialStatus = statusOf(parent);
  const children = await authoritativeChildren(github, parent.number, cfg);

  if (input.transition === "start-validation") {
    if (
      initialStatus !== input.expectedStatus &&
      initialStatus !== "status:awaiting-validation"
    ) {
      throw new WorkGraphError("stale supplied parent status");
    }
    const task = await ensureTransitionTask(
      github,
      parent,
      children,
      {
        taskType: "validate-issue",
        inputs: { validationProfile: "new-issue-default" },
      },
      input.transition,
      null,
      cfg,
      { create: initialStatus === input.expectedStatus },
    );
    if (initialStatus === input.expectedStatus) {
      await replaceStatus(
        github,
        input,
        input.expectedStatus,
        "status:awaiting-validation",
      );
    }
    return { taskIssueNumber: task.number, taskIssueNodeId: task.node_id, status: "status:awaiting-validation" };
  }

  issueNumber(input.taskIssueNumber, "arguments.taskIssueNumber");
  identifier(input.taskIssueNodeId, "arguments.taskIssueNodeId");

  if (input.transition === "advance-validation") {
    identifier(input.resultCommentNodeId, "arguments.resultCommentNodeId");
    const { child, payload } = requireCurrentChild(
      children,
      input,
      "validate-issue",
    );
    if (child.state !== "closed") {
      throw new WorkGraphError("accepted validation task must be closed by the external runtime");
    }
    const comments = await github.comments(child.number);
    oneAssignment(comments, payload, cfg);
    const result = oneResult(comments, payload, cfg);
    if (result.comment.node_id !== input.resultCommentNodeId) {
      throw new WorkGraphError("supplied Result is not the current validation Result");
    }
    acceptanceFor(comments, result, cfg);
    if (result.payload.result.criteria.every((criterion) => criterion.passed)) {
      requireNoOpenChildren(children);
      if (
        initialStatus !== input.expectedStatus &&
        initialStatus !== "status:awaiting-triage"
      ) {
        throw new WorkGraphError("stale supplied parent status");
      }
      if (initialStatus === input.expectedStatus) {
        await replaceStatus(
          github,
          input,
          input.expectedStatus,
          "status:awaiting-triage",
        );
      }
      return { status: "status:awaiting-triage" };
    }
    if (
      initialStatus !== input.expectedStatus &&
      initialStatus !== "status:awaiting-need-info"
    ) {
      throw new WorkGraphError("stale supplied parent status");
    }
    const task = await ensureTransitionTask(
      github,
      parent,
      children,
      {
        taskType: "request-info",
        inputs: {
          validationResultCommentNodeId: result.comment.node_id,
        },
      },
      input.transition,
      result.comment.node_id,
      cfg,
      { create: initialStatus === input.expectedStatus },
    );
    if (initialStatus === input.expectedStatus) {
      await replaceStatus(
        github,
        input,
        input.expectedStatus,
        "status:awaiting-need-info",
      );
    }
    return {
      taskIssueNumber: task.number,
      taskIssueNodeId: task.node_id,
      status: "status:awaiting-need-info",
    };
  }

  identifier(input.requestCommentNodeId, "arguments.requestCommentNodeId");
  identifier(input.humanReplyCommentNodeId, "arguments.humanReplyCommentNodeId");
  const { child, payload } = requireCurrentChild(
    children,
    input,
    "request-info",
  );
  if (child.state !== "closed") {
    throw new WorkGraphError("request-info task must be closed by the external runtime");
  }
  const comments = await github.comments(child.number);
  oneAssignment(comments, payload, cfg);
  const result = oneResult(comments, payload, cfg);
  acceptanceFor(comments, result, cfg);
  if (
    result.payload.result.requestCommentNodeId !== input.requestCommentNodeId
  ) {
    throw new WorkGraphError("supplied parent info comment is not the accepted Result target");
  }
  const parentComments = await github.comments(parent.number);
  const info = parentComments.find(
    (comment) => comment.node_id === input.requestCommentNodeId,
  );
  const reply = parentComments.find(
    (comment) => comment.node_id === input.humanReplyCommentNodeId,
  );
  const botIds = new Set([
    cfg.launcherId,
    cfg.assignmentId,
    cfg.resultId,
    cfg.acceptanceId,
    cfg.orchestratorId,
    cfg.infoId,
    cfg.redispatchId,
  ]);
  if (
    !info ||
    info.user?.id !== cfg.infoId ||
    !reply ||
    reply.user?.type !== "User" ||
    botIds.has(reply.user?.id) ||
    Date.parse(reply.created_at) <= Date.parse(info.created_at)
  ) {
    throw new WorkGraphError("supplied comment is not a qualifying human reply after the info request");
  }
  if (
    initialStatus !== input.expectedStatus &&
    initialStatus !== "status:awaiting-validation"
  ) {
    throw new WorkGraphError("stale supplied parent status");
  }
  const task = await ensureTransitionTask(
    github,
    parent,
    children,
    {
      taskType: "validate-issue",
      inputs: { validationProfile: "new-issue-default" },
    },
    input.transition,
    input.humanReplyCommentNodeId,
    cfg,
    { create: initialStatus === input.expectedStatus },
  );
  if (initialStatus === input.expectedStatus) {
    await replaceStatus(
      github,
      input,
      input.expectedStatus,
      "status:awaiting-validation",
    );
  }
  return { taskIssueNumber: task.number, taskIssueNodeId: task.node_id, status: "status:awaiting-validation" };
}

function feedbackBody(resultCommentNodeId, resultBodyDigest, feedback) {
  const payload = { resultCommentNodeId, resultBodyDigest, feedback };
  validateFeedback(payload);
  return canonicalJson(FEEDBACK_MARKER, payload);
}

async function getResultSnapshot(input, github, cfg) {
  refs(input);
  const ctx = await context(github, input, cfg, {
    actorId: cfg.acceptanceId,
    actorLabel: "acceptance reporter",
    open: true,
  });
  const comments = await github.comments(input.taskIssueNumber);
  oneAssignment(comments, ctx.taskPayload, cfg);
  const result = oneResult(comments, ctx.taskPayload, cfg);
  return {
    resultCommentNodeId: result.comment.node_id,
    resultBodyDigest: resultDigest(result.comment.body),
    workResult: result.payload,
  };
}

async function feedbackAndRedispatch(input, github, cfg) {
  refs(input, ["resultCommentNodeId", "resultBodyDigest", "feedback"]);
  identifier(input.resultCommentNodeId, "arguments.resultCommentNodeId");
  digestString(input.resultBodyDigest, "arguments.resultBodyDigest");
  plain(input.feedback, "arguments.feedback");
  const ctx = await context(github, input, cfg, {
    actorId: cfg.redispatchId,
    actorLabel: "redispatch reporter",
    open: true,
  });
  const comments = await github.comments(input.taskIssueNumber);
  const assignment = oneAssignment(comments, ctx.taskPayload, cfg);
  if (assignment.version !== 2) {
    throw new WorkGraphError("feedback queueing requires Assignment/v2");
  }
  const result = oneResult(comments, ctx.taskPayload, cfg);
  if (result.comment.node_id !== input.resultCommentNodeId) {
    throw new WorkGraphError("feedback does not target the current Result");
  }
  if (comments.some((comment) => structured(comment.body, ACCEPTANCE_MARKER))) {
    throw new WorkGraphError("feedback cannot redispatch an accepted Result");
  }
  const currentDigest = resultDigest(result.comment.body);
  if (currentDigest !== input.resultBodyDigest) {
    throw new WorkGraphError("feedback targets a stale Result digest");
  }
  const body = feedbackBody(
    input.resultCommentNodeId,
    currentDigest,
    input.feedback,
  );
  const existing = candidates(comments, FEEDBACK_MARKER, (candidate) =>
    parseCanonicalJson(candidate, FEEDBACK_MARKER, validateFeedback),
  );
  let comment;
  let reconciled = false;
  let revised = false;
  if (existing.marked.length > 0) {
    if (
      existing.parsed.length !== 1 ||
      !existing.parsed[0].payload ||
      existing.parsed[0].comment.user?.id !== cfg.redispatchId ||
      existing.parsed[0].payload.resultCommentNodeId !==
        input.resultCommentNodeId
    ) {
      throw new WorkGraphError("task has conflicting or foreign feedback");
    }
    comment = existing.parsed[0].comment;
    if (comment.body === body) {
      reconciled = true;
    } else {
      if (!Number.isSafeInteger(comment.id) || comment.id <= 0) {
        throw new WorkGraphError("current feedback lacks a REST comment ID");
      }
      const patched = verifiedCommentWrite(
        await github.patchComment(comment.id, body),
        body,
        cfg.redispatchId,
        "feedback revision",
      );
      if (patched.id !== comment.id || patched.node_id !== comment.node_id) {
        throw new WorkGraphError("revised feedback changed comment identity");
      }
      comment = patched;
      revised = true;
    }
  } else {
    comment = verifiedCommentWrite(
      await github.postComment(input.taskIssueNumber, body),
      body,
      cfg.redispatchId,
      "feedback",
    );
  }
  return {
    feedbackCommentNodeId: comment.node_id,
    resultBodyDigest: currentDigest,
    reconciled,
    revised,
    redispatch: {
      status: "queued-for-lease",
      agentProfile: assignment.payload.agentProfile,
      workerId: assignment.payload.workerId,
      taskIssueNumber: input.taskIssueNumber,
    },
  };
}

const referenceProperties = {
  taskIssueNumber: { type: "integer", minimum: 1 },
  taskIssueNodeId: { type: "string", minLength: 1, maxLength: MAX_ID },
  parentIssueNumber: { type: "integer", minimum: 1 },
  parentIssueNodeId: { type: "string", minLength: 1, maxLength: MAX_ID },
};

function schema(properties, required = Object.keys(properties)) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

const tools = [
  {
    name: "get_result_snapshot",
    description:
      "Return the verified current Result payload, comment node ID, and SHA-256 digest.",
    inputSchema: schema({
      ...referenceProperties,
    }),
  },
  {
    name: "submit_task_assignment",
    description: "Submit or reconcile one strict task Assignment.",
    inputSchema: schema({
      ...referenceProperties,
      agentProfile: { type: "string", enum: Object.values(AGENT_BY_TASK) },
      workerId: { type: "string" },
      compatibleWorkers: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            workerId: { type: "string" },
            agentProfile: { type: "string", enum: Object.values(AGENT_BY_TASK) },
            queueDepth: { type: "integer", minimum: 0 },
          },
          required: ["workerId", "agentProfile", "queueDepth"],
        },
      },
    }),
  },
  {
    name: "submit_task_result",
    description: "Create or revise the one strict Result comment; never close a task.",
    inputSchema: schema(
      {
        ...referenceProperties,
        workResult: { type: "object" },
        assignmentCommentNodeId: { type: "string" },
        leaseCommentNodeId: { type: "string" },
        leaseId: { type: "string" },
        workerId: { type: "string" },
        slotId: { type: "string" },
        acquiredAt: { type: "string" },
        expiresAt: { type: "string" },
        feedbackCommentNodeId: { type: "string" },
        feedbackUpdatedAt: { type: "string" },
        resultCommentNodeId: { type: "string" },
        resultBodyDigest: { type: "string" },
      },
      [
        ...Object.keys(referenceProperties),
        "workResult",
        ...LEASE_ARGUMENTS,
      ],
    ),
  },
  {
    name: "submit_result_acceptance",
    description: "Accept the exact current Result comment ID and SHA-256 digest.",
    inputSchema: schema({
      ...referenceProperties,
      resultCommentNodeId: { type: "string" },
      resultBodyDigest: { type: "string" },
      summary: { type: "string" },
    }),
  },
  {
    name: "transition_issue",
    description: "Expected-state parent status/task transition in one narrow operation.",
    inputSchema: schema(
      {
        parentIssueNumber: referenceProperties.parentIssueNumber,
        parentIssueNodeId: referenceProperties.parentIssueNodeId,
        expectedStatus: { type: "string", enum: STATUS_LABELS },
        transition: {
          type: "string",
          enum: [
            "start-validation",
            "advance-validation",
            "resume-after-human-reply",
          ],
        },
        taskIssueNumber: referenceProperties.taskIssueNumber,
        taskIssueNodeId: referenceProperties.taskIssueNodeId,
        resultCommentNodeId: { type: "string" },
        requestCommentNodeId: { type: "string" },
        humanReplyCommentNodeId: { type: "string" },
      },
      ["parentIssueNumber", "parentIssueNodeId", "expectedStatus", "transition"],
    ),
  },
  {
    name: "post_parent_info_request",
    description: "Post or reconcile one parent info request from a validation Result.",
    inputSchema: schema({
      ...referenceProperties,
      validationTaskIssueNumber: { type: "integer", minimum: 1 },
      validationTaskIssueNodeId: { type: "string" },
      validationResultCommentNodeId: { type: "string" },
      assignmentCommentNodeId: { type: "string" },
      leaseCommentNodeId: { type: "string" },
      leaseId: { type: "string" },
      workerId: { type: "string" },
      slotId: { type: "string" },
      acquiredAt: { type: "string" },
      expiresAt: { type: "string" },
    }),
  },
  {
    name: "feedback_and_redispatch",
    description: "Post idempotent Result feedback and return a bounded external redispatch request.",
    inputSchema: schema({
      ...referenceProperties,
      resultCommentNodeId: { type: "string" },
      resultBodyDigest: { type: "string" },
      feedback: { type: "string" },
    }),
  },
];

async function callTool(name, args) {
  const cfg = config();
  const github = new GitHub(cfg);
  if (name === "get_result_snapshot") return getResultSnapshot(args, github, cfg);
  if (name === "submit_task_assignment") return submitAssignment(args, github, cfg);
  if (name === "submit_task_result") return submitResult(args, github, cfg);
  if (name === "submit_result_acceptance") return submitAcceptance(args, github, cfg);
  if (name === "transition_issue") return transitionIssue(args, github, cfg);
  if (name === "post_parent_info_request") return postInfo(args, github, cfg);
  if (name === "feedback_and_redispatch") return feedbackAndRedispatch(args, github, cfg);
  throw new WorkGraphError(`unknown tool ${name}`);
}

async function rpc(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "drasi-workgraph-reporter", version: "3.0.0" },
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
      return {
        content: [{ type: "text", text: error.message }],
        isError: true,
      };
    }
  }
  throw new WorkGraphError(`unsupported method ${message.method}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id === undefined) {
        return;
      }
      const result = await rpc(request);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32603, message: error.message },
        })}\n`,
      );
    }
  });
}
