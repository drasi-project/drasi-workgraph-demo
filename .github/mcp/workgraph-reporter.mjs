#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";

const GITHUB_API_URL = "https://api.github.com";
const REPOSITORY_OWNER = "drasi-project";
const REPOSITORY_NAME = "drasi-workgraph-demo";
const RESULT_MARKER = "WorkGraphResult/v1";
const RESULT_DETAILS_OPEN = "<details>";
const RESULT_SUMMARY = "<summary>WorkGraph Result</summary>";
const RESULT_DETAILS_CLOSE = "</details>";
const TASK_TYPES = ["issue-validation", "issue-risk-profile"];
const OUTCOMES = ["succeeded", "failed", "blocked"];
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
const INPUT_KEYS = ["issueNumber", "assignment", "workResult"];
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

class ReporterError extends Error {}
class AmbiguousCreateError extends ReporterError {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractAssignmentId(text) {
  const match = text.match(
    /"assignmentId"\s*:\s*("(?:\\.|[^"\\])*")/,
  );
  if (match === null) {
    return null;
  }
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
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

function requirePublishableSummary(value, label) {
  requireNonEmptyString(value, label);
  const lines = value.split("\n");
  if (
    value.includes("\r") ||
    lines.some(
      (line) =>
        line.startsWith("```") ||
        line.includes(RESULT_MARKER) ||
        /<\/?(?:details|summary)\b/i.test(line),
    )
  ) {
    throw new ReporterError(
      `${label} must be human-readable text without carriage returns, ` +
        "fence lines, Result markers, or details/summary tags",
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
  requireNonEmptyString(workResult.summary, "workResult.summary");

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

function validateInput(input) {
  requireExactKeys(input, INPUT_KEYS, "arguments");
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new ReporterError("arguments.issueNumber must be a positive integer");
  }
  validateAssignment(input.assignment);
  validateWorkResult(input.workResult);
  requirePublishableSummary(
    input.workResult.summary,
    "workResult.summary",
  );
  if (input.workResult.assignmentId !== input.assignment.assignmentId) {
    throw new ReporterError(
      "workResult.assignmentId must match assignment.assignmentId",
    );
  }
  if (input.workResult.taskType !== input.assignment.taskType) {
    throw new ReporterError(
      "workResult.taskType must match assignment.taskType",
    );
  }

  const expectedNames =
    input.assignment.taskType === "issue-validation"
      ? loadIssueValidationProfile(
          input.assignment.task.validationProfile,
        )
      : input.assignment.task.dimensions;
  const actualNames =
    input.workResult.taskType === "issue-validation"
      ? input.workResult.result.criteria.map((entry) => entry.criterion)
      : input.workResult.result.dimensions.map((entry) => entry.dimension);
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    const field =
      input.assignment.taskType === "issue-validation"
        ? "criteria"
        : "dimensions";
    const source =
      input.assignment.taskType === "issue-validation"
        ? `validation profile ${JSON.stringify(
            input.assignment.task.validationProfile,
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

function formatResultComment(workResult) {
  const canonical = canonicalWorkResult(workResult);
  return (
    `${RESULT_DETAILS_OPEN}\n${RESULT_SUMMARY}\n\n${RESULT_MARKER}\n\n` +
    `${canonical.summary}\n\n` +
    `\`\`\`json\n${JSON.stringify(canonical, null, 2)}\n\`\`\`\n` +
    `${RESULT_DETAILS_CLOSE}\n`
  );
}

function inspectResultComment(body) {
  if (typeof body !== "string") {
    return null;
  }
  const normalizedBody = body.replaceAll("\r\n", "\n");
  const firstActualNewline = normalizedBody.indexOf("\n");
  const firstLiteralNewline = normalizedBody.indexOf("\\n");
  const usesLiteralNewlines =
    (normalizedBody.startsWith("<details") ||
      normalizedBody.startsWith(RESULT_MARKER)) &&
    firstLiteralNewline >= 0 &&
    (firstActualNewline < 0 || firstLiteralNewline < firstActualNewline);
  const inspectedBody = usesLiteralNewlines
    ? normalizedBody.replaceAll("\\n", "\n")
    : normalizedBody;
  const lines = inspectedBody.split("\n");
  const looksLikeResult =
    lines.includes(RESULT_MARKER) ||
    (lines[0]?.startsWith("<details") && lines[1] === RESULT_SUMMARY);
  if (!looksLikeResult) {
    return null;
  }

  const fences = lines
    .map((line, index) => (line.startsWith("```") ? index : -1))
    .filter((index) => index >= 0);
  const open = fences.length >= 2 ? fences[0] : -1;
  const closeOffset = lines
    .slice(open + 1)
    .findIndex((line) => line === "```");
  const close = open >= 0 && closeOffset >= 0 ? open + 1 + closeOffset : -1;

  let payload = null;
  let assignmentId = null;
  let payloadIsValid = false;
  if (open >= 0 && close >= 0) {
    try {
      payload = JSON.parse(lines.slice(open + 1, close).join("\n"));
      if (isObject(payload) && typeof payload.assignmentId === "string") {
        assignmentId = payload.assignmentId;
      }
      validateWorkResult(payload);
      payloadIsValid = true;
    } catch {
      // Keep the parsed assignment ID so a malformed retry candidate cannot
      // silently cause a second Result comment.
    }
  }
  assignmentId ??= extractAssignmentId(normalizedBody);

  const humanSummary =
    open >= 7 && lines[open - 1] === ""
      ? lines.slice(5, open - 1).join("\n")
      : null;
  const envelopeIsCanonical =
    !usesLiteralNewlines &&
    lines[0] === RESULT_DETAILS_OPEN &&
    lines[1] === RESULT_SUMMARY &&
    lines[2] === "" &&
    lines[3] === RESULT_MARKER &&
    lines[4] === "" &&
    lines.filter((line) => line === RESULT_MARKER).length === 1 &&
    typeof humanSummary === "string" &&
    humanSummary.trim().length > 0 &&
    fences.length === 2 &&
    lines[open] === "```json" &&
    close === lines.length - 3 &&
    lines[close + 1] === RESULT_DETAILS_CLOSE &&
    lines[close + 2] === "";

  return {
    assignmentId,
    envelopeIsCanonical,
    humanSummary,
    payload,
    payloadIsValid,
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

function loadConfig() {
  const token = process.env.WORKGRAPH_TOKEN ?? "";
  const reporterUserId = Number(
    process.env.WORKGRAPH_REPORTER_USER_ID ?? "",
  );
  if (token.length === 0) {
    throw new ReporterError(
      "WORKGRAPH_TOKEN is not configured from the " +
        "COPILOT_MCP_WORKGRAPH_TOKEN Agents secret",
    );
  }
  if (!Number.isSafeInteger(reporterUserId) || reporterUserId <= 0) {
    throw new ReporterError(
      "WORKGRAPH_REPORTER_USER_ID must be a positive integer",
    );
  }
  return { token, reporterUserId, apiUrl: apiBaseUrl() };
}

class GitHubClient {
  constructor(config) {
    this.config = config;
  }

  async request(method, path, payload, { ambiguousWrite = false } = {}) {
    let response;
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          "User-Agent": "drasi-workgraph-result-reporter",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown network error";
      if (ambiguousWrite) {
        throw new AmbiguousCreateError(
          `result comment creation is ambiguous: ${message}`,
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
          "result comment creation response is ambiguous",
        );
      }
      throw new ReporterError("GitHub API response could not be read");
    }
    if (!response.ok && ambiguousWrite && response.status >= 500) {
      throw new AmbiguousCreateError(
        `result comment creation returned HTTP ${response.status}`,
      );
    }

    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (ambiguousWrite) {
          throw new AmbiguousCreateError(
            "result comment creation response is ambiguous",
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

  async listComments(issueNumber) {
    const comments = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
          `${issueNumber}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new ReporterError("GitHub comments response is not an array");
      }
      comments.push(...batch);
      if (batch.length < 100) {
        return comments;
      }
    }
    throw new ReporterError("result reconciliation exceeded 100 pages");
  }

  async createComment(issueNumber, body) {
    return this.request(
      "POST",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
        `${issueNumber}/comments`,
      { body },
      { ambiguousWrite: true },
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

function validateIssue(issue, issueNumber) {
  if (
    !isObject(issue) ||
    issue.pull_request !== undefined ||
    issue.number !== issueNumber ||
    typeof issue.node_id !== "string" ||
    issue.node_id.length === 0
  ) {
    throw new ReporterError(
      "the fixed-repository destination is not the requested Issue",
    );
  }
}

function findExistingResult(comments, workResult, identity) {
  const matches = [];
  for (const comment of comments) {
    if (!isObject(comment)) {
      continue;
    }
    const inspected = inspectResultComment(comment.body);
    if (inspected?.assignmentId === workResult.assignmentId) {
      matches.push({ comment, inspected });
    }
  }
  if (matches.length > 1) {
    const allSchemaValid = matches.every(
      ({ inspected }) => inspected.payloadIsValid,
    );
    throw new ReporterError(
      allSchemaValid
        ? "multiple schema-valid Result comments already exist for assignmentId"
        : "multiple Result comment candidates already exist for assignmentId",
    );
  }
  if (matches.length === 0) {
    return null;
  }

  const match = matches[0];
  if (!match.inspected.payloadIsValid) {
    throw new ReporterError(
      "a malformed Result payload already exists for assignmentId",
    );
  }
  if (!match.inspected.envelopeIsCanonical) {
    throw new ReporterError(
      "a malformed Result comment envelope already exists for assignmentId",
    );
  }
  if (match.comment.user?.id !== identity.id) {
    throw new ReporterError(
      "a schema-valid Result comment for assignmentId exists from a " +
        "different author",
    );
  }
  const expected = canonicalWorkResult(workResult);
  const expectedBody = formatResultComment(workResult);
  if (
    !isDeepStrictEqual(match.inspected.payload, expected) ||
    match.inspected.humanSummary !== expected.summary ||
    match.comment.body !== expectedBody
  ) {
    throw new ReporterError(
      "the authenticated Result comment for assignmentId conflicts with " +
        "the requested result",
    );
  }
  return match.comment;
}

function requireCommentNodeId(comment) {
  if (
    !isObject(comment) ||
    typeof comment.node_id !== "string" ||
    comment.node_id.length === 0
  ) {
    throw new ReporterError("Result comment has no node ID");
  }
  return comment.node_id;
}

class ResultReporter {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  async report(input) {
    const identity = await this.client.getIdentity();
    validateIdentity(identity, this.config);
    const issue = await this.client.getIssue(input.issueNumber);
    validateIssue(issue, input.issueNumber);

    let comments = await this.client.listComments(input.issueNumber);
    let comment = findExistingResult(
      comments,
      input.workResult,
      identity,
    );
    let reconciled = comment !== null;
    if (comment === null) {
      const body = formatResultComment(input.workResult);
      try {
        comment = await this.client.createComment(input.issueNumber, body);
      } catch (error) {
        if (!(error instanceof AmbiguousCreateError)) {
          throw error;
        }
        comments = await this.client.listComments(input.issueNumber);
        comment = findExistingResult(
          comments,
          input.workResult,
          identity,
        );
        if (comment === null) {
          throw new ReporterError(
            "result comment creation was ambiguous and no authenticated " +
              "canonical Result was found",
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
        comments = await this.client.listComments(input.issueNumber);
        comment = findExistingResult(
          comments,
          input.workResult,
          identity,
        );
        if (comment === null) {
          throw new ReporterError(
            "GitHub did not confirm the authenticated canonical Result comment",
          );
        }
        reconciled = true;
      }
    }

    return {
      assignmentId: input.workResult.assignmentId,
      taskType: input.workResult.taskType,
      commentNodeId: requireCommentNodeId(comment),
      reconciled,
    };
  }
}

const NON_EMPTY_STRING = {
  type: "string",
  minLength: 1,
  pattern: "[\\s\\S]*\\S[\\s\\S]*",
};
const VALIDATION_PROFILE_NAME = {
  type: "string",
  minLength: 1,
  maxLength: MAX_VALIDATION_PROFILE_NAME_LENGTH,
  pattern: VALIDATION_PROFILE_NAME_PATTERN.source,
};

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function assignmentSchema(taskType) {
  const validation = taskType === "issue-validation";
  return strictObject({
    assignmentId: NON_EMPTY_STRING,
    agentProfile: NON_EMPTY_STRING,
    priority: { type: "integer", minimum: 0 },
    taskType: { const: taskType },
    task: validation
      ? strictObject({
          validationProfile: VALIDATION_PROFILE_NAME,
        })
      : strictObject({
          riskProfile: NON_EMPTY_STRING,
          dimensions: {
            type: "array",
            minItems: 1,
            items: NON_EMPTY_STRING,
          },
        }),
  });
}

function workResultSchema(taskType) {
  const validation = taskType === "issue-validation";
  return strictObject({
    assignmentId: NON_EMPTY_STRING,
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

const TOOL = {
  name: "report_result",
  description:
    "Publish or reconcile one strict WorkGraphResult/v1 conversation " +
    "comment for an issue-validation or issue-risk-profile assignment.",
  inputSchema: strictObject({
    issueNumber: { type: "integer", minimum: 1 },
    assignment: {
      oneOf: TASK_TYPES.map((taskType) => assignmentSchema(taskType)),
    },
    workResult: {
      oneOf: TASK_TYPES.map((taskType) => workResultSchema(taskType)),
    },
  }),
};

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
          name: "drasi-workgraph-result-reporter",
          version: "1.0.0",
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      if (message.params?.name !== TOOL.name) {
        return toolError(new ReporterError("unknown tool"));
      }
      try {
        validateInput(message.params.arguments);
        const config = loadConfig();
        const reporter = new ResultReporter(
          config,
          new GitHubClient(config),
        );
        return toolResult(await reporter.report(message.params.arguments));
      } catch (error) {
        return toolError(
          error instanceof ReporterError
            ? error
            : new ReporterError("Result reporter failed"),
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
