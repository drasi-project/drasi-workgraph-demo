#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder, TextEncoder } from "node:util";

const GITHUB_API_URL = "https://api.github.com";
const REPOSITORY_OWNER = "drasi-project";
const REPOSITORY_NAME = "drasi-workgraph-demo";
const TASK_TYPE_NAME = "WorkGraphTask";
const RESULT_MARKER = "WorkGraphTaskResult/v1";
const STRUCTURED_MARKERS = [
  RESULT_MARKER,
  "WorkGraphResult/v1",
  "WorkGraphAssignment/v1",
  "WorkGraphEvent/v1",
];
const TASK_TYPES = ["issue-validation", "issue-risk-profile"];
const OUTCOMES = ["succeeded", "failed", "blocked"];
const MAX_PROGRESS_BYTES = 4096;
const MAX_IDENTIFIER_LENGTH = 256;
const REPORTER_FILE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(REPORTER_FILE_PATH),
  "..",
  "..",
);
const ISSUE_VALIDATION_PROFILE_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  ".github",
  "workgraph",
  "profiles",
  "issue-validation",
);
const VALIDATION_PROFILE_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_VALIDATION_PROFILE_NAME_LENGTH = 64;
const MAX_VALIDATION_PROFILE_BYTES = 64 * 1024;
const ISSUE_REFERENCE_KEYS = [
  "taskIssueNumber",
  "taskIssueNodeId",
  "parentIssueNumber",
  "parentIssueNodeId",
];
const ASSIGNMENT_KEYS = [
  "assignmentId",
  "agentProfile",
  "priority",
  "taskType",
  "task",
];
const RESULT_KEYS = [
  "assignmentId",
  "taskType",
  "outcome",
  "summary",
  "result",
];
const PROFILE_BY_TASK_TYPE = {
  "issue-validation": "issue-validator",
  "issue-risk-profile": "issue-risk-profiler",
};

class ReporterError extends Error {}
class AmbiguousCreateError extends ReporterError {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isObject(value)) {
    throw new ReporterError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const extra = actual.filter((key) => !expected.includes(key));
    throw new ReporterError(
      `${label} has invalid properties; missing=${JSON.stringify(missing)}, ` +
        `extra=${JSON.stringify(extra)}`,
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReporterError(`${label} must be a non-empty string`);
  }
}

function requireBoundedIdentifier(value, label) {
  requireNonEmptyString(value, label);
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new ReporterError(
      `${label} must not exceed ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
}

function requirePlainText(value, label, maxBytes) {
  requireNonEmptyString(value, label);
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > maxBytes) {
    throw new ReporterError(
      `${label} must not exceed ${maxBytes} UTF-8 bytes`,
    );
  }
  if (
    value.includes("\r") ||
    value.includes("```") ||
    STRUCTURED_MARKERS.some((marker) => value.includes(marker)) ||
    /<\/?(?:details|summary)\b/i.test(value)
  ) {
    throw new ReporterError(
      `${label} must be ordinary LF text without carriage returns, ` +
        "structured markers, fences, or details/summary tags",
    );
  }
}

function requireNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ReporterError(`${label} must contain at least one item`);
  }
  value.forEach((entry, index) => {
    requireNonEmptyString(entry, `${label}[${index}]`);
  });
}

function requireValidationProfileName(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_VALIDATION_PROFILE_NAME_LENGTH ||
    !VALIDATION_PROFILE_NAME_PATTERN.test(value)
  ) {
    throw new ReporterError(
      "assignment.task.validationProfile must be 1-64 lowercase letters " +
        "or digits separated only by single hyphens",
    );
  }
}

export function resolveIssueValidationProfilePath(validationProfile) {
  requireValidationProfileName(validationProfile);
  const profilePath = path.resolve(
    ISSUE_VALIDATION_PROFILE_DIRECTORY,
    `${validationProfile}.md`,
  );
  if (path.dirname(profilePath) !== ISSUE_VALIDATION_PROFILE_DIRECTORY) {
    throw new ReporterError(
      "assignment.task.validationProfile does not resolve to the canonical " +
        "issue-validation profile directory",
    );
  }
  return profilePath;
}

export function parseIssueValidationProfile(
  source,
  label = "issue-validation profile",
) {
  if (typeof source !== "string" || source.length === 0) {
    throw new ReporterError(`${label} must be non-empty UTF-8 Markdown`);
  }
  if (source.includes("\0") || source.includes("\r")) {
    throw new ReporterError(
      `${label} must use LF text without NUL or carriage-return characters`,
    );
  }
  if (!source.endsWith("\n")) {
    throw new ReporterError(`${label} must end with one LF`);
  }

  const lines = source.slice(0, -1).split("\n");
  const criteriaHeadings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) =>
      /^[ \t]*#{1,6}[ \t]+criteria\b/i.test(line),
    );
  if (criteriaHeadings.length === 0) {
    throw new ReporterError(`${label} is missing the ## Criteria section`);
  }
  const exactCriteriaHeadings = criteriaHeadings.filter(
    ({ line }) => line === "## Criteria",
  );
  if (exactCriteriaHeadings.length > 1) {
    throw new ReporterError(
      `${label} must contain exactly one Criteria heading`,
    );
  }
  if (
    exactCriteriaHeadings.length !== 1 ||
    criteriaHeadings.length !== 1
  ) {
    throw new ReporterError(
      `${label} Criteria heading must be exactly "## Criteria"`,
    );
  }

  const heading = exactCriteriaHeadings[0];
  const sectionLines = lines.slice(heading.index + 1);
  if (sectionLines[0] !== "") {
    throw new ReporterError(
      `${label} must have one blank line after ## Criteria`,
    );
  }
  const itemLines = sectionLines.slice(1);
  if (itemLines.length === 0) {
    throw new ReporterError(`${label} Criteria section must not be empty`);
  }

  const criteria = [];
  const seen = new Set();
  itemLines.forEach((line, index) => {
    const match = line.match(/^([1-9][0-9]*)\. (\S(?:.*\S)?)$/);
    if (match === null) {
      throw new ReporterError(
        `${label} has unexpected Criteria content at item ${index + 1}`,
      );
    }
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number !== index + 1) {
      throw new ReporterError(
        `${label} Criteria items must be numbered consecutively from 1`,
      );
    }
    const criterion = match[2];
    if (seen.has(criterion)) {
      throw new ReporterError(
        `${label} contains duplicate criterion ${JSON.stringify(criterion)}`,
      );
    }
    seen.add(criterion);
    criteria.push(criterion);
  });
  return criteria;
}

export function loadIssueValidationProfile(validationProfile) {
  const profilePath = resolveIssueValidationProfilePath(validationProfile);
  let bytes;
  try {
    const metadata = lstatSync(profilePath);
    if (!metadata.isFile()) {
      throw new ReporterError(
        `issue-validation profile ${JSON.stringify(validationProfile)} ` +
          "must be a regular file",
      );
    }
    if (metadata.size > MAX_VALIDATION_PROFILE_BYTES) {
      throw new ReporterError(
        `issue-validation profile ${JSON.stringify(validationProfile)} ` +
          `must not exceed ${MAX_VALIDATION_PROFILE_BYTES} bytes`,
      );
    }
    bytes = readFileSync(profilePath);
  } catch (error) {
    if (error instanceof ReporterError) {
      throw error;
    }
    if (error?.code === "ENOENT") {
      throw new ReporterError(
        `issue-validation profile ${JSON.stringify(validationProfile)} ` +
          "does not exist",
      );
    }
    throw new ReporterError(
      `issue-validation profile ${JSON.stringify(validationProfile)} ` +
        "could not be read",
    );
  }

  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReporterError(
      `issue-validation profile ${JSON.stringify(validationProfile)} ` +
        "must be valid UTF-8",
    );
  }
  return parseIssueValidationProfile(
    source,
    `issue-validation profile ${JSON.stringify(validationProfile)}`,
  );
}

function validateAssignment(assignment) {
  requireExactKeys(assignment, ASSIGNMENT_KEYS, "assignment");
  requireNonEmptyString(assignment.assignmentId, "assignment.assignmentId");
  requireNonEmptyString(assignment.agentProfile, "assignment.agentProfile");
  if (!Number.isSafeInteger(assignment.priority) || assignment.priority < 0) {
    throw new ReporterError(
      "assignment.priority must be an integer greater than or equal to 0",
    );
  }
  if (!TASK_TYPES.includes(assignment.taskType)) {
    throw new ReporterError(
      "assignment.taskType must be issue-validation or issue-risk-profile",
    );
  }
  if (
    assignment.agentProfile !== PROFILE_BY_TASK_TYPE[assignment.taskType]
  ) {
    throw new ReporterError(
      "assignment.agentProfile does not match assignment.taskType",
    );
  }
  if (assignment.taskType === "issue-validation") {
    requireExactKeys(
      assignment.task,
      ["validationProfile"],
      "assignment.task",
    );
    requireValidationProfileName(assignment.task.validationProfile);
    return;
  }

  requireExactKeys(
    assignment.task,
    ["riskProfile", "dimensions"],
    "assignment.task",
  );
  requireNonEmptyString(
    assignment.task.riskProfile,
    "assignment.task.riskProfile",
  );
  requireNonEmptyStringArray(
    assignment.task.dimensions,
    "assignment.task.dimensions",
  );
}

function parseAssignmentBody(body) {
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new ReporterError(
      "WorkGraphTask body must be raw WorkGraphAssignment JSON",
    );
  }
  if (
    body.includes("\r") ||
    body.includes("```") ||
    STRUCTURED_MARKERS.some((marker) => body.includes(marker)) ||
    /<\/?(?:details|summary)\b/i.test(body)
  ) {
    throw new ReporterError(
      "WorkGraphTask body must contain only raw WorkGraphAssignment JSON",
    );
  }
  let assignment;
  try {
    assignment = JSON.parse(body);
  } catch {
    throw new ReporterError(
      "WorkGraphTask body is not valid WorkGraphAssignment JSON",
    );
  }
  validateAssignment(assignment);
  return assignment;
}

function validateWorkResult(workResult) {
  requireExactKeys(workResult, RESULT_KEYS, "workResult");
  requireNonEmptyString(workResult.assignmentId, "workResult.assignmentId");
  if (!TASK_TYPES.includes(workResult.taskType)) {
    throw new ReporterError(
      "workResult.taskType must be issue-validation or issue-risk-profile",
    );
  }
  if (!OUTCOMES.includes(workResult.outcome)) {
    throw new ReporterError(
      "workResult.outcome must be succeeded, failed, or blocked",
    );
  }
  requirePlainText(workResult.summary, "workResult.summary", 4096);

  if (workResult.taskType === "issue-validation") {
    requireExactKeys(workResult.result, ["criteria"], "workResult.result");
    if (
      !Array.isArray(workResult.result.criteria) ||
      workResult.result.criteria.length === 0
    ) {
      throw new ReporterError(
        "workResult.result.criteria must contain at least one item",
      );
    }
    const seenCriteria = new Set();
    workResult.result.criteria.forEach((criterion, index) => {
      const label = `workResult.result.criteria[${index}]`;
      requireExactKeys(
        criterion,
        ["criterion", "passed", "evidence"],
        label,
      );
      requireNonEmptyString(criterion.criterion, `${label}.criterion`);
      if (typeof criterion.passed !== "boolean") {
        throw new ReporterError(`${label}.passed must be a boolean`);
      }
      requireNonEmptyString(criterion.evidence, `${label}.evidence`);
      if (seenCriteria.has(criterion.criterion)) {
        throw new ReporterError(
          "workResult.result.criteria must not contain duplicate criteria",
        );
      }
      seenCriteria.add(criterion.criterion);
    });
    return;
  }

  requireExactKeys(workResult.result, ["dimensions"], "workResult.result");
  if (
    !Array.isArray(workResult.result.dimensions) ||
    workResult.result.dimensions.length === 0
  ) {
    throw new ReporterError(
      "workResult.result.dimensions must contain at least one item",
    );
  }
  workResult.result.dimensions.forEach((dimension, index) => {
    const label = `workResult.result.dimensions[${index}]`;
    requireExactKeys(
      dimension,
      ["dimension", "score", "rationale"],
      label,
    );
    requireNonEmptyString(dimension.dimension, `${label}.dimension`);
    if (
      !Number.isInteger(dimension.score) ||
      dimension.score < 0 ||
      dimension.score > 100
    ) {
      throw new ReporterError(
        `${label}.score must be an integer between 0 and 100`,
      );
    }
    requireNonEmptyString(dimension.rationale, `${label}.rationale`);
  });
}

function validateIssueReferences(input, expectedKeys) {
  requireExactKeys(input, expectedKeys, "arguments");
  for (const key of ["taskIssueNumber", "parentIssueNumber"]) {
    if (!Number.isSafeInteger(input[key]) || input[key] <= 0) {
      throw new ReporterError(`arguments.${key} must be a positive integer`);
    }
  }
  for (const key of ["taskIssueNodeId", "parentIssueNodeId"]) {
    requireBoundedIdentifier(input[key], `arguments.${key}`);
  }
  if (input.taskIssueNumber === input.parentIssueNumber) {
    throw new ReporterError("task and parent Issue numbers must differ");
  }
  if (input.taskIssueNodeId === input.parentIssueNodeId) {
    throw new ReporterError("task and parent Issue node IDs must differ");
  }
}

function validateProgressInput(input) {
  validateIssueReferences(input, [
    ...ISSUE_REFERENCE_KEYS,
    "assignmentId",
    "message",
  ]);
  requireBoundedIdentifier(
    input.assignmentId,
    "arguments.assignmentId",
  );
  requirePlainText(input.message, "arguments.message", MAX_PROGRESS_BYTES);
}

function validateResultInputShape(input) {
  validateIssueReferences(input, [...ISSUE_REFERENCE_KEYS, "workResult"]);
  validateWorkResult(input.workResult);
}

function reconcileAssignment(
  assignment,
  parentNodeId,
  assertedAssignmentId,
  workResult,
) {
  const expectedAssignmentId = `${assignment.taskType}:${parentNodeId}`;
  if (assignment.assignmentId !== expectedAssignmentId) {
    throw new ReporterError(
      "assignment.assignmentId must equal taskType:authoritativeParentNodeId",
    );
  }
  if (assertedAssignmentId !== assignment.assignmentId) {
    throw new ReporterError(
      "supplied assignmentId must match assignment.assignmentId",
    );
  }
  if (workResult !== undefined) {
    if (workResult.assignmentId !== assignment.assignmentId) {
      throw new ReporterError(
        "workResult.assignmentId must match assignment.assignmentId",
      );
    }
    if (workResult.taskType !== assignment.taskType) {
      throw new ReporterError(
        "workResult.taskType must match assignment.taskType",
      );
    }
  }

  const expectedNames =
    assignment.taskType === "issue-validation"
      ? loadIssueValidationProfile(assignment.task.validationProfile)
      : assignment.task.dimensions;
  if (workResult === undefined) {
    return;
  }
  const actualNames =
    workResult.taskType === "issue-validation"
      ? workResult.result.criteria.map((entry) => entry.criterion)
      : workResult.result.dimensions.map((entry) => entry.dimension);
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    const field =
      assignment.taskType === "issue-validation"
        ? "criteria"
        : "dimensions";
    const source =
      assignment.taskType === "issue-validation"
        ? `validation profile ${JSON.stringify(
            assignment.task.validationProfile,
          )}`
        : "Assignment";
    throw new ReporterError(
      `workResult ${field} must exactly match the ${source} ${field} in order`,
    );
  }
}

function canonicalWorkResult(workResult) {
  const result =
    workResult.taskType === "issue-validation"
      ? {
          criteria: workResult.result.criteria.map((entry) => ({
            criterion: entry.criterion,
            passed: entry.passed,
            evidence: entry.evidence,
          })),
        }
      : {
          dimensions: workResult.result.dimensions.map((entry) => ({
            dimension: entry.dimension,
            score: entry.score,
            rationale: entry.rationale,
          })),
        };
  return {
    assignmentId: workResult.assignmentId,
    taskType: workResult.taskType,
    outcome: workResult.outcome,
    summary: workResult.summary,
    result,
  };
}

export function formatTaskResult(workResult) {
  return (
    `${RESULT_MARKER}\n\n\`\`\`json\n` +
    `${JSON.stringify(canonicalWorkResult(workResult), null, 2)}\n\`\`\`\n`
  );
}

function looksLikeStructuredResult(body) {
  return (
    typeof body === "string" &&
    (STRUCTURED_MARKERS.some((marker) => body.includes(marker)) ||
      /<summary>\s*WorkGraph(?: Task)? Result\s*<\/summary>/i.test(body) ||
      (/```[ \t]*json\b/i.test(body) &&
        body.includes('"assignmentId"') &&
        body.includes('"taskType"') &&
        body.includes('"result"')))
  );
}

function inspectTaskResult(body) {
  if (!looksLikeStructuredResult(body)) {
    return null;
  }
  const match =
    typeof body === "string"
      ? body.match(
          /^WorkGraphTaskResult\/v1\n\n```json\n([\s\S]+)\n```\n$/,
        )
      : null;
  if (match === null) {
    return { canonical: false, payload: null };
  }
  let payload;
  try {
    payload = JSON.parse(match[1]);
    validateWorkResult(payload);
  } catch {
    return { canonical: false, payload: null };
  }
  return {
    canonical: body === formatTaskResult(payload),
    payload,
  };
}

function apiBaseUrl() {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.WORKGRAPH_TEST_GITHUB_API_URL
  ) {
    const testUrl = new URL(process.env.WORKGRAPH_TEST_GITHUB_API_URL);
    if (
      testUrl.protocol !== "http:" ||
      !["127.0.0.1", "::1", "localhost"].includes(testUrl.hostname)
    ) {
      throw new ReporterError(
        "WORKGRAPH_TEST_GITHUB_API_URL must be a loopback HTTP URL",
      );
    }
    return testUrl.toString().replace(/\/$/, "");
  }
  return GITHUB_API_URL;
}

function positiveIntegerEnvironment(name) {
  const value = Number(process.env[name] ?? "");
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReporterError(`${name} must be a positive integer`);
  }
  return value;
}

function loadConfig() {
  const token = process.env.WORKGRAPH_TOKEN ?? "";
  const taskIssueTypeId =
    process.env.WORKGRAPH_TASK_ISSUE_TYPE_ID ?? "";
  if (token.length === 0) {
    throw new ReporterError(
      "WORKGRAPH_TOKEN is not configured from the " +
        "COPILOT_MCP_WORKGRAPH_TOKEN Agents secret",
    );
  }
  if (
    taskIssueTypeId.length === 0 ||
    taskIssueTypeId.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new ReporterError(
      "WORKGRAPH_TASK_ISSUE_TYPE_ID must be the bounded exact " +
        "WorkGraphTask GraphQL Issue Type node ID",
    );
  }
  return {
    token,
    taskIssueTypeId,
    launcherUserId: positiveIntegerEnvironment(
      "WORKGRAPH_LAUNCHER_USER_ID",
    ),
    reporterUserId: positiveIntegerEnvironment(
      "WORKGRAPH_REPORTER_USER_ID",
    ),
    apiUrl: apiBaseUrl(),
  };
}

class GitHubClient {
  constructor(config) {
    this.config = config;
  }

  async request(method, requestPath, payload, { ambiguousWrite = false } = {}) {
    let response;
    try {
      response = await fetch(`${this.config.apiUrl}${requestPath}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "User-Agent": "drasi-workgraph-task-reporter",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown network error";
      if (ambiguousWrite) {
        throw new AmbiguousCreateError(
          `task comment creation is ambiguous: ${message}`,
        );
      }
      throw new ReporterError(`GitHub API request failed: ${message}`);
    }

    let text;
    try {
      text = await response.text();
    } catch {
      if (ambiguousWrite) {
        throw new AmbiguousCreateError(
          "task comment creation response is ambiguous",
        );
      }
      throw new ReporterError("GitHub API response could not be read");
    }
    if (!response.ok && ambiguousWrite && response.status >= 500) {
      throw new AmbiguousCreateError(
        `task comment creation returned HTTP ${response.status}`,
      );
    }

    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (ambiguousWrite) {
          throw new AmbiguousCreateError(
            "task comment creation response is ambiguous",
          );
        }
        throw new ReporterError("GitHub API response is not valid JSON");
      }
    }
    if (!response.ok) {
      const detail =
        isObject(body) && typeof body.message === "string"
          ? body.message
          : text;
      throw new ReporterError(
        `GitHub API request failed with HTTP ${response.status}: ${detail}`,
      );
    }
    return body;
  }

  async getIdentity() {
    return this.request("GET", "/user");
  }

  async getIssue(issueNumber) {
    return this.request(
      "GET",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/${issueNumber}`,
    );
  }

  async getParent(taskIssueNumber) {
    return this.request(
      "GET",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
        `${taskIssueNumber}/parent`,
    );
  }

  async listComments(taskIssueNumber) {
    const comments = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
          `${taskIssueNumber}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new ReporterError("GitHub comments response is not an array");
      }
      comments.push(...batch);
      if (batch.length < 100) {
        return comments;
      }
    }
    throw new ReporterError("task comment reconciliation exceeded 100 pages");
  }

  async createComment(taskIssueNumber, body, ambiguousWrite = false) {
    return this.request(
      "POST",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
        `${taskIssueNumber}/comments`,
      { body },
      { ambiguousWrite },
    );
  }
}

function validateIdentity(identity, config) {
  if (
    !isObject(identity) ||
    identity.id !== config.reporterUserId ||
    typeof identity.login !== "string"
  ) {
    throw new ReporterError(
      "GitHub token identity does not match " +
        `WORKGRAPH_REPORTER_USER_ID ${config.reporterUserId}`,
    );
  }
}

function validateTaskIssue(issue, input, config) {
  if (
    !isObject(issue) ||
    issue.pull_request !== undefined ||
    issue.number !== input.taskIssueNumber ||
    issue.node_id !== input.taskIssueNodeId
  ) {
    throw new ReporterError(
      "the fixed-repository task is not the requested non-PR Issue",
    );
  }
  if (
    issue.type?.name !== TASK_TYPE_NAME ||
    issue.type?.id !== config.taskIssueTypeId
  ) {
    throw new ReporterError(
      "task Issue does not have the configured exact WorkGraphTask type ID and name",
    );
  }
  if (issue.user?.id !== config.launcherUserId) {
    throw new ReporterError(
      "task Issue creator does not match WORKGRAPH_LAUNCHER_USER_ID",
    );
  }
  if (!["open", "closed"].includes(issue.state)) {
    throw new ReporterError("task Issue has an invalid state");
  }
}

function validateParentIssue(parent, input) {
  if (
    !isObject(parent) ||
    parent.pull_request !== undefined ||
    parent.number !== input.parentIssueNumber ||
    parent.node_id !== input.parentIssueNodeId
  ) {
    throw new ReporterError(
      "native parent relation does not match the requested non-PR parent Issue",
    );
  }
  if (
    parent.repository_url !== undefined &&
    parent.repository_url !==
      `${GITHUB_API_URL}/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}`
  ) {
    throw new ReporterError("native parent Issue is not in the fixed repository");
  }
}

function validateTaskContext(
  task,
  parent,
  input,
  config,
  assertedAssignmentId,
  workResult,
) {
  validateTaskIssue(task, input, config);
  validateParentIssue(parent, input);
  const assignment = parseAssignmentBody(task.body);
  reconcileAssignment(
    assignment,
    parent.node_id,
    assertedAssignmentId,
    workResult,
  );
  return assignment;
}

function findExistingResult(comments, workResult, identity) {
  const candidates = [];
  for (const comment of comments) {
    if (!isObject(comment)) {
      continue;
    }
    const inspected = inspectTaskResult(comment.body);
    if (inspected !== null) {
      candidates.push({ comment, inspected });
    }
  }
  if (candidates.length > 1) {
    throw new ReporterError(
      "multiple structured Result comment candidates exist on the task",
    );
  }
  if (candidates.length === 0) {
    return null;
  }

  const candidate = candidates[0];
  if (!candidate.inspected.canonical) {
    throw new ReporterError(
      "a malformed structured Result comment candidate exists on the task",
    );
  }
  if (candidate.comment.user?.id !== identity.id) {
    throw new ReporterError(
      "a canonical Result comment exists from a different author",
    );
  }
  const expected = canonicalWorkResult(workResult);
  if (
    !isDeepStrictEqual(candidate.inspected.payload, expected) ||
    candidate.comment.body !== formatTaskResult(workResult)
  ) {
    throw new ReporterError(
      "the authenticated Result comment conflicts with the requested result",
    );
  }
  return candidate.comment;
}

function requireCommentNodeId(comment, label) {
  if (
    !isObject(comment) ||
    typeof comment.node_id !== "string" ||
    comment.node_id.length === 0
  ) {
    throw new ReporterError(`${label} comment has no node ID`);
  }
  return comment.node_id;
}

class TaskReporter {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  async loadContext(input, workResult) {
    const identity = await this.client.getIdentity();
    validateIdentity(identity, this.config);
    const task = await this.client.getIssue(input.taskIssueNumber);
    const parent = await this.client.getParent(input.taskIssueNumber);
    const assignment = validateTaskContext(
      task,
      parent,
      input,
      this.config,
      workResult?.assignmentId ?? input.assignmentId,
      workResult,
    );
    return { identity, task, assignment };
  }

  async reportProgress(input) {
    const { task } = await this.loadContext(input);
    if (task.state !== "open") {
      throw new ReporterError("progress can be posted only to an open task Issue");
    }
    const comment = await this.client.createComment(
      input.taskIssueNumber,
      input.message,
    );
    return {
      taskIssueNodeId: input.taskIssueNodeId,
      commentNodeId: requireCommentNodeId(comment, "progress"),
    };
  }

  async submitResult(input) {
    const { identity, task, assignment } = await this.loadContext(
      input,
      input.workResult,
    );
    let comments = await this.client.listComments(input.taskIssueNumber);
    let comment = findExistingResult(
      comments,
      input.workResult,
      identity,
    );
    let reconciled = comment !== null;
    if (comment === null) {
      if (task.state !== "open") {
        throw new ReporterError(
          "a closed task Issue has no authenticated canonical Result",
        );
      }
      const body = formatTaskResult(input.workResult);
      try {
        comment = await this.client.createComment(
          input.taskIssueNumber,
          body,
          true,
        );
      } catch (error) {
        if (!(error instanceof AmbiguousCreateError)) {
          throw error;
        }
        comments = await this.client.listComments(input.taskIssueNumber);
        comment = findExistingResult(
          comments,
          input.workResult,
          identity,
        );
        if (comment === null) {
          throw new ReporterError(
            "Result creation was ambiguous and no authenticated canonical " +
              "Result was found",
          );
        }
        reconciled = true;
      }
      if (
        !isObject(comment) ||
        comment.user?.id !== identity.id ||
        comment.body !== body ||
        typeof comment.node_id !== "string" ||
        comment.node_id.length === 0
      ) {
        comments = await this.client.listComments(input.taskIssueNumber);
        comment = findExistingResult(
          comments,
          input.workResult,
          identity,
        );
        if (comment === null) {
          throw new ReporterError(
            "GitHub did not confirm the authenticated canonical Result",
          );
        }
        reconciled = true;
      }
    }

    return {
      taskIssueNodeId: input.taskIssueNodeId,
      parentIssueNodeId: input.parentIssueNodeId,
      assignmentId: assignment.assignmentId,
      taskType: assignment.taskType,
      commentNodeId: requireCommentNodeId(comment, "Result"),
      reconciled,
    };
  }
}

const NON_EMPTY_STRING = {
  type: "string",
  minLength: 1,
  pattern: "[\\s\\S]*\\S[\\s\\S]*",
};
const BOUNDED_IDENTIFIER = {
  ...NON_EMPTY_STRING,
  maxLength: MAX_IDENTIFIER_LENGTH,
};
const ISSUE_REFERENCE_PROPERTIES = {
  taskIssueNumber: { type: "integer", minimum: 1 },
  taskIssueNodeId: BOUNDED_IDENTIFIER,
  parentIssueNumber: { type: "integer", minimum: 1 },
  parentIssueNodeId: BOUNDED_IDENTIFIER,
};

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function workResultSchema(taskType) {
  const validation = taskType === "issue-validation";
  return strictObject({
    assignmentId: BOUNDED_IDENTIFIER,
    taskType: { const: taskType },
    outcome: { type: "string", enum: OUTCOMES },
    summary: NON_EMPTY_STRING,
    result: validation
      ? strictObject({
          criteria: {
            type: "array",
            minItems: 1,
            items: strictObject({
              criterion: NON_EMPTY_STRING,
              passed: { type: "boolean" },
              evidence: NON_EMPTY_STRING,
            }),
          },
        })
      : strictObject({
          dimensions: {
            type: "array",
            minItems: 1,
            items: strictObject({
              dimension: NON_EMPTY_STRING,
              score: { type: "integer", minimum: 0, maximum: 100 },
              rationale: NON_EMPTY_STRING,
            }),
          },
        }),
  });
}

const TOOLS = [
  {
    name: "report_progress",
    description:
      "Post bounded ordinary progress text to one validated WorkGraphTask.",
    inputSchema: strictObject({
      ...ISSUE_REFERENCE_PROPERTIES,
      assignmentId: BOUNDED_IDENTIFIER,
      message: {
        type: "string",
        minLength: 1,
        maxLength: MAX_PROGRESS_BYTES,
      },
    }),
  },
  {
    name: "submit_task_result",
    description:
      "Publish or reconcile one strict WorkGraphTaskResult/v1 comment on a " +
      "validated WorkGraphTask without closing any Issue.",
    inputSchema: strictObject({
      ...ISSUE_REFERENCE_PROPERTIES,
      workResult: {
        oneOf: TASK_TYPES.map((taskType) => workResultSchema(taskType)),
      },
    }),
  },
];

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(error) {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
  };
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion:
          message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "drasi-workgraph-task-reporter",
          version: "2.0.0",
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const tool = TOOLS.find(
        (candidate) => candidate.name === message.params?.name,
      );
      if (tool === undefined) {
        return toolError(new ReporterError("unknown tool"));
      }
      try {
        if (tool.name === "report_progress") {
          validateProgressInput(message.params.arguments);
        } else {
          validateResultInputShape(message.params.arguments);
        }
        const config = loadConfig();
        const reporter = new TaskReporter(
          config,
          new GitHubClient(config),
        );
        const result =
          tool.name === "report_progress"
            ? await reporter.reportProgress(message.params.arguments)
            : await reporter.submitResult(message.params.arguments);
        return toolResult(result);
      } catch (error) {
        return toolError(
          error instanceof ReporterError
            ? error
            : new ReporterError("WorkGraphTask reporter failed"),
        );
      }
    }
    default:
      throw new ReporterError(`unsupported MCP method: ${message.method}`);
  }
}

async function main() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let id = null;
    try {
      const message = JSON.parse(line);
      id = message.id ?? null;
      if (id === null) {
        continue;
      }
      const result = await handleRequest(message);
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message:
              error instanceof ReporterError
                ? error.message
                : "invalid request",
          },
        })}\n`,
      );
    }
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === REPORTER_FILE_PATH
) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
