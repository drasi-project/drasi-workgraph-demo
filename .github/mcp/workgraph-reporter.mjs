#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";

const GITHUB_API_URL = "https://api.github.com";
const REPOSITORY = "drasi-project/drasi-workgraph-demo";
const REPOSITORY_OWNER = "drasi-project";
const REPOSITORY_NAME = "drasi-workgraph-demo";
const PROJECT_OWNER = "drasi-project";
const PROJECT_NUMBER = 3;
const PROJECT_ID = "PVT_kwDOCX0YF84BgNE3";
const EVENT_SCHEMA = "workgraph.event/v1";
const EVENT_PREFIX = "WorkGraphEvent/v1";
const ASSIGNMENT_TYPE = "ResponsibilityAssigned";
const EXECUTION_TYPE = "ExecutionStarted";
const COMPLETION_TYPE = "CompletedIssueValidation";
const MARKER = "WorkGraph-Validation: pass";

const INPUT_KEYS = ["subjectNumber", "executionId"];
const ENVELOPE_KEYS = [
  "schemaVersion",
  "eventId",
  "eventType",
  "runId",
  "projectItemNodeId",
  "subjectNodeId",
  "payload",
];
const ASSIGNMENT_KEYS = [
  "responsibilityType",
  "profileRef",
  "contentDigest",
];
const EXECUTION_KEYS = ["executionId", "taskId"];
const COMPLETION_KEYS = ["executionId", "outcome", "reasonCode"];

class ReporterError extends Error {}
class AmbiguousCreateError extends ReporterError {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isObject(value)) {
    throw new ReporterError(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (!isDeepStrictEqual([...actual].sort(), [...expectedKeys].sort())) {
    const missing = expectedKeys.filter((key) => !actual.includes(key));
    const extra = actual.filter((key) => !expectedKeys.includes(key));
    throw new ReporterError(
      `${label} has invalid properties; missing=${JSON.stringify(missing)}, ` +
        `extra=${JSON.stringify(extra)}`,
    );
  }
}

function requireKeyOrder(value, expectedKeys, label) {
  if (!isDeepStrictEqual(Object.keys(value), expectedKeys)) {
    throw new ReporterError(`${label} properties are not canonically ordered`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReporterError(`${label} must be a non-empty string`);
  }
}

function validateLogin(value, label) {
  requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(value)) {
    throw new ReporterError(`${label} is not a valid trusted GitHub login`);
  }
}

function parseUserId(value, label) {
  const userId = Number(value);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ReporterError(`${label} must be a positive integer`);
  }
  return userId;
}

function validateInput(input) {
  requireExactKeys(input, INPUT_KEYS, "arguments");
  if (!Number.isInteger(input.subjectNumber) || input.subjectNumber <= 0) {
    throw new ReporterError("arguments.subjectNumber must be a positive integer");
  }
  requireString(input.executionId, "arguments.executionId");
  if (!input.executionId.startsWith("execution:")) {
    throw new ReporterError(
      "arguments.executionId must start with 'execution:'",
    );
  }
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bodyDigest(body) {
  return `sha256:${sha256Hex(body ?? "")}`;
}

function runIdFor(projectItemNodeId, subjectNodeId, contentDigest) {
  const material =
    `workgraph.run/v1\n${projectItemNodeId}\n${subjectNodeId}\n` +
    contentDigest;
  return `run:sha256:${sha256Hex(material)}`;
}

function eventIdFor(runId, eventType) {
  return `event:sha256:${sha256Hex(
    `workgraph.event/v1\n${runId}\n${eventType}`,
  )}`;
}

function commentDigest(body) {
  return `sha256:${sha256Hex(body)}`;
}

function markerPresent(body) {
  return body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line === MARKER);
}

function validationResult(body) {
  if (markerPresent(body)) {
    return {
      summary: "Issue validation passed.",
      outcome: "passed",
      reasonCode: "required-marker-present",
    };
  }
  return {
    summary: "Issue validation failed.",
    outcome: "failed",
    reasonCode: "required-marker-missing",
  };
}

function validateEnvelope(event) {
  requireExactKeys(event, ENVELOPE_KEYS, "event");
  requireKeyOrder(event, ENVELOPE_KEYS, "event");
  if (event.schemaVersion !== EVENT_SCHEMA) {
    throw new ReporterError("event.schemaVersion is invalid");
  }
  requireString(event.eventId, "event.eventId");
  requireString(event.runId, "event.runId");
  requireString(event.projectItemNodeId, "event.projectItemNodeId");
  requireString(event.subjectNodeId, "event.subjectNodeId");
  if (!event.projectItemNodeId.startsWith("PVTI_")) {
    throw new ReporterError("event.projectItemNodeId is invalid");
  }
  if (!event.subjectNodeId.startsWith("I_")) {
    throw new ReporterError("event.subjectNodeId is invalid");
  }
}

function validateAssignment(event) {
  validateEnvelope(event);
  if (event.eventType !== ASSIGNMENT_TYPE) {
    throw new ReporterError("assignment event type is invalid");
  }
  requireExactKeys(event.payload, ASSIGNMENT_KEYS, "assignment payload");
  requireKeyOrder(event.payload, ASSIGNMENT_KEYS, "assignment payload");
  if (event.payload.responsibilityType !== "issue-validation") {
    throw new ReporterError("assignment responsibility type is invalid");
  }
  if (!/^issue-validator@[0-9a-f]{40}$/.test(event.payload.profileRef)) {
    throw new ReporterError("assignment profileRef is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(event.payload.contentDigest)) {
    throw new ReporterError("assignment contentDigest is invalid");
  }
  const expectedRunId = runIdFor(
    event.projectItemNodeId,
    event.subjectNodeId,
    event.payload.contentDigest,
  );
  if (event.runId !== expectedRunId) {
    throw new ReporterError("assignment runId is invalid");
  }
  if (event.eventId !== eventIdFor(event.runId, ASSIGNMENT_TYPE)) {
    throw new ReporterError("assignment eventId is invalid");
  }
}

function validateExecution(event) {
  validateEnvelope(event);
  if (event.eventType !== EXECUTION_TYPE) {
    throw new ReporterError("execution event type is invalid");
  }
  requireExactKeys(event.payload, EXECUTION_KEYS, "execution payload");
  requireKeyOrder(event.payload, EXECUTION_KEYS, "execution payload");
  requireString(event.payload.executionId, "execution payload.executionId");
  requireString(event.payload.taskId, "execution payload.taskId");
  if (!event.payload.executionId.startsWith("execution:")) {
    throw new ReporterError("execution payload.executionId is invalid");
  }
  if (event.eventId !== eventIdFor(event.runId, EXECUTION_TYPE)) {
    throw new ReporterError("execution eventId is invalid");
  }
}

function canonicalCompletionEvent(execution, outcome, reasonCode) {
  return {
    schemaVersion: EVENT_SCHEMA,
    eventId: eventIdFor(execution.runId, COMPLETION_TYPE),
    eventType: COMPLETION_TYPE,
    runId: execution.runId,
    projectItemNodeId: execution.projectItemNodeId,
    subjectNodeId: execution.subjectNodeId,
    payload: {
      executionId: execution.payload.executionId,
      outcome,
      reasonCode,
    },
  };
}

function validateCompletion(event) {
  validateEnvelope(event);
  if (event.eventType !== COMPLETION_TYPE) {
    throw new ReporterError("completion event type is invalid");
  }
  requireExactKeys(event.payload, COMPLETION_KEYS, "completion payload");
  requireKeyOrder(event.payload, COMPLETION_KEYS, "completion payload");
  requireString(event.payload.executionId, "completion payload.executionId");
  const validResult =
    (event.payload.outcome === "passed" &&
      event.payload.reasonCode === "required-marker-present") ||
    (event.payload.outcome === "failed" &&
      event.payload.reasonCode === "required-marker-missing");
  if (!validResult) {
    throw new ReporterError("completion outcome and reasonCode are invalid");
  }
  if (event.eventId !== eventIdFor(event.runId, COMPLETION_TYPE)) {
    throw new ReporterError("completion eventId is invalid");
  }
}

function formatEvent(summary, event) {
  if (
    typeof summary !== "string" ||
    summary.length === 0 ||
    summary.length > 120 ||
    summary.includes("\n") ||
    summary.includes("\r")
  ) {
    throw new ReporterError("event summary is invalid");
  }
  return `${EVENT_PREFIX}\n\n${summary}\n\n${JSON.stringify(event, null, 2)}`;
}

function parseEventCandidate(body) {
  if (typeof body !== "string") {
    return null;
  }
  const normalized = body.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    return null;
  }
  const match =
    /^WorkGraphEvent\/v1\n\n([^\n]{1,120})\n\n(\{[\s\S]*\})$/.exec(
      normalized,
    );
  if (match === null) {
    return null;
  }
  let event;
  try {
    event = JSON.parse(match[2]);
  } catch {
    return null;
  }
  if (!isObject(event)) {
    return null;
  }
  return {
    summary: match[1],
    event,
    normalizedBody: normalized,
    json: match[2],
  };
}

function parseEventComment(body) {
  const candidate = parseEventCandidate(body);
  if (candidate === null) {
    return null;
  }
  try {
    validateEnvelope(candidate.event);
  } catch {
    return null;
  }
  if (candidate.json !== JSON.stringify(candidate.event, null, 2)) {
    return null;
  }
  return candidate;
}

function isUnedited(comment) {
  return (
    typeof comment?.created_at === "string" &&
    comment.created_at.length > 0 &&
    comment.updated_at === comment.created_at
  );
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
  const launcherLogin = process.env.WORKGRAPH_LAUNCHER_LOGIN ?? "";
  const launcherUserIdText = process.env.WORKGRAPH_LAUNCHER_USER_ID ?? "";
  const reporterLogin = process.env.WORKGRAPH_REPORTER_LOGIN ?? "";
  const reporterUserIdText = process.env.WORKGRAPH_REPORTER_USER_ID ?? "";
  if (!token) {
    throw new ReporterError(
      "WORKGRAPH_TOKEN is not configured from the " +
        "COPILOT_MCP_WORKGRAPH_TOKEN Agents secret",
    );
  }
  validateLogin(launcherLogin, "WORKGRAPH_LAUNCHER_LOGIN");
  const launcherUserId = parseUserId(
    launcherUserIdText,
    "WORKGRAPH_LAUNCHER_USER_ID",
  );
  validateLogin(reporterLogin, "WORKGRAPH_REPORTER_LOGIN");
  const reporterUserId = parseUserId(
    reporterUserIdText,
    "WORKGRAPH_REPORTER_USER_ID",
  );
  return {
    token,
    launcherLogin,
    launcherUserId,
    reporterLogin,
    reporterUserId,
    apiUrl: apiBaseUrl(),
  };
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
          "User-Agent": "drasi-workgraph-completion-reporter",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (ambiguousWrite) {
        throw new AmbiguousCreateError(
          "comment creation result is ambiguous",
          { cause: error },
        );
      }
      throw new ReporterError(`GitHub API request failed: ${error.message}`, {
        cause: error,
      });
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (ambiguousWrite) {
        throw new AmbiguousCreateError(
          "comment creation response is ambiguous",
          { cause: error },
        );
      }
      throw new ReporterError("GitHub API response could not be read", {
        cause: error,
      });
    }
    if (!response.ok && ambiguousWrite && response.status >= 500) {
      throw new AmbiguousCreateError(
        `comment creation returned HTTP ${response.status}`,
      );
    }
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (ambiguousWrite && response.ok) {
          throw new AmbiguousCreateError(
            "comment creation response is ambiguous",
            { cause: error },
          );
        }
        throw new ReporterError("GitHub API response is not valid JSON", {
          cause: error,
        });
      }
    }
    if (!response.ok) {
      const detail = isObject(body) && body.message ? body.message : text;
      throw new ReporterError(
        `GitHub API request failed with HTTP ${response.status}: ${detail}`,
      );
    }
    return body;
  }

  async graphql(query, variables) {
    const response = await this.request("POST", "/graphql", {
      query,
      variables,
    });
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      const details = response.errors
        .map((error) => error.message ?? "unknown GraphQL error")
        .join("; ");
      throw new ReporterError(`GitHub GraphQL request failed: ${details}`);
    }
    if (!isObject(response?.data)) {
      throw new ReporterError("GitHub GraphQL response has no data");
    }
    return response.data;
  }

  async getIdentity() {
    const identity = await this.request("GET", "/user");
    if (!isObject(identity) || !identity.id || !identity.login) {
      throw new ReporterError("GitHub token identity could not be determined");
    }
    return identity;
  }

  async getIssue(subjectNumber) {
    return this.request(
      "GET",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/${subjectNumber}`,
    );
  }

  async listComments(subjectNumber) {
    const comments = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request(
        "GET",
        `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
          `${subjectNumber}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new ReporterError("GitHub comments response is not an array");
      }
      comments.push(...batch);
      if (batch.length < 100) {
        return comments;
      }
    }
    throw new ReporterError("comment search exceeded 100 pages");
  }

  async createComment(subjectNumber, body) {
    return this.request(
      "POST",
      `/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/issues/` +
        `${subjectNumber}/comments`,
      { body },
      { ambiguousWrite: true },
    );
  }

  async findProjectItem(subjectNodeId) {
    const query = `
query WorkGraphProjectItems($cursor: String) {
  organization(login: "${PROJECT_OWNER}") {
    projectV2(number: ${PROJECT_NUMBER}) {
      id
      items(first: 100, after: $cursor) {
        nodes {
          id
          content {
            ... on Issue {
              id
              number
              repository { nameWithOwner }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
    const matches = [];
    let cursor = null;
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.graphql(query, { cursor });
      const project = data.organization?.projectV2;
      if (!isObject(project) || project.id !== PROJECT_ID) {
        throw new ReporterError(
          "drasi-project Project number 3 does not match the fixed Project node ID",
        );
      }
      const connection = project.items;
      if (!isObject(connection) || !Array.isArray(connection.nodes)) {
        throw new ReporterError("fixed Project Items could not be read");
      }
      matches.push(
        ...connection.nodes.filter(
          (item) => item?.content?.id === subjectNodeId,
        ),
      );
      if (!connection.pageInfo?.hasNextPage) {
        return matches;
      }
      requireString(connection.pageInfo.endCursor, "Project Items endCursor");
      cursor = connection.pageInfo.endCursor;
    }
    throw new ReporterError("Project Item search exceeded 100 pages");
  }
}

function validateIssue(issue, subjectNumber) {
  if (!isObject(issue) || issue.pull_request !== undefined) {
    throw new ReporterError("completion subject is not an Issue");
  }
  if (issue.number !== subjectNumber) {
    throw new ReporterError("Issue number does not match tool input");
  }
  requireString(issue.node_id, "Issue node ID");
  if (!issue.node_id.startsWith("I_")) {
    throw new ReporterError("Issue node ID is invalid");
  }
  if (issue.body !== null && typeof issue.body !== "string") {
    throw new ReporterError("Issue body is invalid");
  }
}

function trustedEventCandidates(comments, launcherUserId) {
  return comments
    .filter(
      (comment) =>
        isObject(comment) &&
        comment.user?.id === launcherUserId &&
        typeof comment.body === "string",
    )
    .map((comment) => ({
      comment,
      candidate: parseEventCandidate(comment.body),
      parsed: parseEventComment(comment.body),
      unedited: isUnedited(comment),
    }));
}

function findExecution(comments, input, config) {
  const trusted = trustedEventCandidates(
    comments,
    config.launcherUserId,
  );
  const matches = trusted.filter(
    ({ candidate }) =>
      candidate?.event?.eventType === EXECUTION_TYPE &&
      candidate.event.payload?.executionId === input.executionId,
  );
  if (matches.some(({ parsed }) => parsed === null)) {
    throw new ReporterError(
      "trusted ExecutionStarted event is not strict and canonical",
    );
  }
  if (matches.some(({ unedited }) => !unedited)) {
    throw new ReporterError("trusted execution event was edited");
  }
  if (matches.length !== 1) {
    throw new ReporterError(
      "exactly one trusted ExecutionStarted event must match executionId; " +
        `expected launcher user ID ${config.launcherUserId} ` +
        `(${config.launcherLogin})`,
    );
  }
  validateExecution(matches[0].parsed.event);
  const expectedEventId = eventIdFor(
    matches[0].parsed.event.runId,
    EXECUTION_TYPE,
  );
  const eventIdMatches = trusted.filter(
    ({ candidate }) => candidate?.event?.eventId === expectedEventId,
  );
  if (
    eventIdMatches.length !== 1 ||
    eventIdMatches[0].comment !== matches[0].comment
  ) {
    throw new ReporterError(
      "trusted ExecutionStarted eventId is conflicting or ambiguous",
    );
  }
  return matches[0].parsed.event;
}

function findAssignment(comments, execution, config) {
  const expectedEventId = eventIdFor(execution.runId, ASSIGNMENT_TYPE);
  const candidates = trustedEventCandidates(
    comments,
    config.launcherUserId,
  ).filter(
    ({ candidate }) =>
      candidate?.event?.eventId === expectedEventId ||
      (candidate?.event?.eventType === ASSIGNMENT_TYPE &&
        candidate.event.runId === execution.runId),
  );
  if (candidates.some(({ parsed }) => parsed === null)) {
    throw new ReporterError(
      "trusted ResponsibilityAssigned event is not strict and canonical",
    );
  }
  if (candidates.some(({ unedited }) => !unedited)) {
    throw new ReporterError("trusted assignment event was edited");
  }
  if (candidates.length !== 1) {
    throw new ReporterError(
      "exactly one trusted ResponsibilityAssigned event must match execution",
    );
  }
  validateAssignment(candidates[0].parsed.event);
  return candidates[0].parsed.event;
}

function validateCurrentChain(
  comments,
  input,
  config,
  expectedExecution,
  expectedAssignment,
) {
  const execution = findExecution(comments, input, config);
  const assignment = findAssignment(comments, execution, config);
  validateExecutionAssignment(execution, assignment);
  if (
    !isDeepStrictEqual(execution, expectedExecution) ||
    !isDeepStrictEqual(assignment, expectedAssignment)
  ) {
    throw new ReporterError(
      "trusted launcher correlation changed during comment creation",
    );
  }
}

function validateExecutionAssignment(execution, assignment) {
  if (
    execution.runId !== assignment.runId ||
    execution.projectItemNodeId !== assignment.projectItemNodeId ||
    execution.subjectNodeId !== assignment.subjectNodeId
  ) {
    throw new ReporterError("execution does not match assignment");
  }
}

function validateProjectItem(matches, execution, issue, subjectNumber) {
  if (matches.length !== 1) {
    throw new ReporterError(
      "fixed Project must contain exactly one Item tracking the Issue",
    );
  }
  const item = matches[0];
  if (item.id !== execution.projectItemNodeId) {
    throw new ReporterError(
      "trusted execution Project Item does not match fixed Project membership",
    );
  }
  if (
    item.content?.id !== issue.node_id ||
    item.content?.number !== subjectNumber ||
    item.content?.repository?.nameWithOwner !== REPOSITORY
  ) {
    throw new ReporterError(
      "Project Item does not contain the authoritative repository Issue",
    );
  }
}

function findOwnedCompletion(
  comments,
  expectedEvent,
  expectedBody,
  identity,
) {
  const expectedHash = commentDigest(expectedBody);
  const owned = [];
  for (const comment of comments) {
    if (!isObject(comment) || comment.user?.id !== identity.id) {
      continue;
    }
    const candidate = parseEventCandidate(comment.body);
    if (candidate?.event?.eventId !== expectedEvent.eventId) {
      continue;
    }
    const parsed = parseEventComment(comment.body);
    if (parsed === null) {
      throw new ReporterError(
        "authenticated completion comment is not strict and canonical",
      );
    }
    if (!isUnedited(comment)) {
      throw new ReporterError("authenticated completion comment was edited");
    }
    validateCompletion(parsed.event);
    if (
      !isDeepStrictEqual(parsed.event, expectedEvent) ||
      commentDigest(comment.body) !== expectedHash ||
      comment.body !== expectedBody
    ) {
      throw new ReporterError(
        "authenticated completion comment conflicts with expected event",
      );
    }
    owned.push(comment);
  }
  if (owned.length > 1) {
    throw new ReporterError(
      "multiple authenticated completion comments exist for eventId",
    );
  }
  return owned[0] ?? null;
}

async function verifyCurrentIssue(client, input, expectedNodeId, assignment) {
  const issue = await client.getIssue(input.subjectNumber);
  validateIssue(issue, input.subjectNumber);
  if (issue.node_id !== expectedNodeId) {
    throw new ReporterError("authoritative Issue identity changed");
  }
  if (bodyDigest(issue.body ?? "") !== assignment.payload.contentDigest) {
    throw new ReporterError(
      "authoritative Issue body changed during completion reporting",
    );
  }
}

class CompletionReporter {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  async reportCompletion(input) {
    validateInput(input);
    const identity = await this.client.getIdentity();
    if (identity.id !== this.config.reporterUserId) {
      throw new ReporterError(
        "GitHub PAT identity does not match WORKGRAPH_REPORTER_USER_ID; " +
          `expected ${this.config.reporterUserId} ` +
          `(${this.config.reporterLogin})`,
      );
    }

    const issue = await this.client.getIssue(input.subjectNumber);
    validateIssue(issue, input.subjectNumber);
    const issueBody = issue.body ?? "";
    let comments = await this.client.listComments(input.subjectNumber);
    const execution = findExecution(comments, input, this.config);
    const assignment = findAssignment(comments, execution, this.config);
    validateExecutionAssignment(execution, assignment);

    if (execution.subjectNodeId !== issue.node_id) {
      throw new ReporterError(
        "trusted execution subject does not match authoritative Issue",
      );
    }
    const projectItems = await this.client.findProjectItem(issue.node_id);
    validateProjectItem(projectItems, execution, issue, input.subjectNumber);

    const actualDigest = bodyDigest(issueBody);
    if (assignment.payload.contentDigest !== actualDigest) {
      throw new ReporterError(
        "authoritative Issue body digest does not match assignment",
      );
    }

    const result = validationResult(issueBody);
    const event = canonicalCompletionEvent(
      execution,
      result.outcome,
      result.reasonCode,
    );
    const body = formatEvent(result.summary, event);
    let comment = findOwnedCompletion(comments, event, body, identity);
    const existingCompletion = comment !== null;
    let ambiguousCreate = false;

    if (comment === null) {
      await verifyCurrentIssue(
        this.client,
        input,
        issue.node_id,
        assignment,
      );
      try {
        const created = await this.client.createComment(
          input.subjectNumber,
          body,
        );
        if (
          !isObject(created) ||
          created.user?.id !== identity.id ||
          created.body !== body ||
          !isUnedited(created)
        ) {
          throw new AmbiguousCreateError(
            "GitHub comment creation response was not authoritative",
          );
        }
      } catch (error) {
        if (!(error instanceof AmbiguousCreateError)) {
          throw error;
        }
        ambiguousCreate = true;
      }
    }

    comments = await this.client.listComments(input.subjectNumber);
    validateCurrentChain(
      comments,
      input,
      this.config,
      execution,
      assignment,
    );
    comment = findOwnedCompletion(comments, event, body, identity);
    if (comment === null) {
      if (ambiguousCreate) {
        throw new ReporterError(
          "comment creation was ambiguous and no authenticated " +
            "canonical completion was found",
        );
      }
      throw new ReporterError(
        "completion comment could not be reconciled",
      );
    }
    await verifyCurrentIssue(
      this.client,
      input,
      issue.node_id,
      assignment,
    );
    requireString(comment.node_id, "completion comment node ID");
    return {
      eventId: event.eventId,
      executionId: input.executionId,
      commentNodeId: comment.node_id,
      projectItemNodeId: execution.projectItemNodeId,
      subjectNodeId: execution.subjectNodeId,
      reconciled: existingCompletion || ambiguousCreate,
    };
  }
}

const TOOL = {
  name: "report_completion",
  description:
    "Resolve and validate one trusted issue-validation execution and publish " +
    "only its canonical completion event comment.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: INPUT_KEYS,
    properties: {
      subjectNumber: { type: "integer", minimum: 1 },
      executionId: { type: "string", pattern: "^execution:" },
    },
  },
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
          name: "drasi-workgraph-completion-reporter",
          version: "3.0.0",
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
        const reporter = new CompletionReporter(
          config,
          new GitHubClient(config),
        );
        return toolResult(
          await reporter.reportCompletion(message.params.arguments),
        );
      } catch (error) {
        return toolError(
          error instanceof ReporterError
            ? error
            : new ReporterError("completion reporter failed"),
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
    let message;
    let id = null;
    try {
      message = JSON.parse(line);
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

main().catch(() => {
  process.exitCode = 1;
});
