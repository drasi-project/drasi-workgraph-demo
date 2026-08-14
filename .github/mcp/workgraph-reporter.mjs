#!/usr/bin/env node

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
const STATUS_FIELD_ID = "PVTSSF_lADOCX0YF84BgNE3zhaadbw";
const AWAITING_ROUTING_OPTION_ID = "3407e5fe";
const EVENT_TYPE = "CompletedIssueValidation";
const ACTOR_TYPE = "Agent";
const ACTOR_ID = "issue-validator";
const MARKER = "WorkGraph-Validation: pass";
const STATUS_NAME = "AwaitingRouting";

const INPUT_KEYS = [
  "projectItemNodeId",
  "subjectNodeId",
  "subjectNumber",
  "routeId",
  "responsibilityId",
  "executionId",
  "expectedEventId",
  "contentVersion",
  "profileRef",
];

const EVENT_KEYS = [
  "schemaVersion",
  "eventId",
  "eventType",
  "projectItemNodeId",
  "subjectType",
  "subjectNodeId",
  "repository",
  "subjectNumber",
  "actorType",
  "actorId",
  "routeId",
  "responsibilityId",
  "executionId",
  "contentVersion",
  "profileRef",
  "result",
  "completedAt",
];

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

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReporterError(`${label} must be a non-empty string`);
  }
}

function requireRfc3339(value, label) {
  requireString(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (match === null) {
    throw new ReporterError(`${label} must be a valid RFC3339 UTC instant`);
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ReporterError(`${label} must be a valid RFC3339 UTC instant`);
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
  for (const key of INPUT_KEYS) {
    if (key !== "subjectNumber") {
      requireString(input[key], `arguments.${key}`);
    }
  }
  if (
    !Number.isInteger(input.subjectNumber) ||
    input.subjectNumber <= 0
  ) {
    throw new ReporterError("arguments.subjectNumber must be a positive integer");
  }
  if (!input.projectItemNodeId.startsWith("PVTI_")) {
    throw new ReporterError(
      "arguments.projectItemNodeId must be a ProjectV2 Item node ID",
    );
  }
  if (!input.subjectNodeId.startsWith("I_")) {
    throw new ReporterError(
      "arguments.subjectNodeId must be an Issue node ID",
    );
  }
  if (!input.executionId.startsWith("execution:")) {
    throw new ReporterError(
      "arguments.executionId must start with 'execution:'",
    );
  }
  const expectedEventId = `event:${input.executionId}:${EVENT_TYPE}`;
  if (input.expectedEventId !== expectedEventId) {
    throw new ReporterError(
      `arguments.expectedEventId must be ${JSON.stringify(expectedEventId)}`,
    );
  }
  if (!/^issue-validator@[0-9a-fA-F]{40}$/.test(input.profileRef)) {
    throw new ReporterError(
      "arguments.profileRef must identify issue-validator at a 40-character blob SHA",
    );
  }
}

function markerPresent(body) {
  return (body ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line === MARKER);
}

function validationResult(body) {
  if (markerPresent(body)) {
    return {
      outcome: "passed",
      reasonCode: "required-marker-present",
      evidence: {
        requiredMarker: MARKER,
        found: true,
      },
      summary: "The required prototype marker is present.",
    };
  }
  return {
    outcome: "failed",
    reasonCode: "required-marker-missing",
    evidence: {
      requiredMarker: MARKER,
      found: false,
    },
    summary: "The required prototype marker is missing.",
  };
}

function completedAtNow() {
  const wholeSecond = Math.floor(Date.now() / 1000) * 1000;
  return new Date(wholeSecond).toISOString().replace(".000Z", "Z");
}

function canonicalEvent(input, issueBody, completedAt) {
  return {
    schemaVersion: "workgraph.event/v1",
    eventId: input.expectedEventId,
    eventType: EVENT_TYPE,
    projectItemNodeId: input.projectItemNodeId,
    subjectType: "Issue",
    subjectNodeId: input.subjectNodeId,
    repository: REPOSITORY,
    subjectNumber: input.subjectNumber,
    actorType: ACTOR_TYPE,
    actorId: ACTOR_ID,
    routeId: input.routeId,
    responsibilityId: input.responsibilityId,
    executionId: input.executionId,
    contentVersion: input.contentVersion,
    profileRef: input.profileRef,
    result: validationResult(issueBody),
    completedAt,
  };
}

function formatComment(event) {
  return `WorkGraphEvent/v1\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
}

function parseCompletionComment(body) {
  if (typeof body !== "string") {
    return null;
  }
  const match = body.match(
    /^WorkGraphEvent\/v1[ \t]*\r?\n```json[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/,
  );
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateExistingEvent(event, input, issueBody) {
  requireExactKeys(event, EVENT_KEYS, "existing completion event");
  requireRfc3339(event.completedAt, "existing completion event.completedAt");
  const expected = canonicalEvent(input, issueBody, event.completedAt);
  if (!isDeepStrictEqual(event, expected)) {
    throw new ReporterError(
      "authenticated completion comment conflicts with expected event",
    );
  }
  return expected;
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
      "WORKGRAPH_TOKEN is not configured from the COPILOT_MCP_WORKGRAPH_TOKEN Agents secret",
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

  async getProjectItem(projectItemNodeId) {
    const query = `
query WorkGraphProjectItem($item: ID!) {
  organization(login: "${PROJECT_OWNER}") {
    projectV2(number: ${PROJECT_NUMBER}) { id }
  }
  node(id: $item) {
    ... on ProjectV2Item {
      id
      project { id }
      content {
        ... on Issue {
          id
          number
          repository { nameWithOwner }
        }
      }
    }
  }
}`;
    const data = await this.graphql(query, { item: projectItemNodeId });
    return {
      item: data.node,
      configuredProjectId: data.organization?.projectV2?.id,
    };
  }

  async setAwaitingRouting(projectItemNodeId) {
    const mutation = `
mutation WorkGraphAwaitingRouting($item: ID!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: "${PROJECT_ID}",
    itemId: $item,
    fieldId: "${STATUS_FIELD_ID}",
    value: {singleSelectOptionId: "${AWAITING_ROUTING_OPTION_ID}"}
  }) {
    projectV2Item { id }
  }
}`;
    const data = await this.graphql(mutation, { item: projectItemNodeId });
    const updated = data.updateProjectV2ItemFieldValue?.projectV2Item;
    if (updated?.id !== projectItemNodeId) {
      throw new ReporterError("GitHub did not confirm the fixed status update");
    }
    const verifyQuery = `
query WorkGraphVerifyStatus($item: ID!) {
  node(id: $item) {
    ... on ProjectV2Item {
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}`;
    const verifyData = await this.graphql(verifyQuery, {
      item: projectItemNodeId,
    });
    if (verifyData.node?.fieldValueByName?.name !== STATUS_NAME) {
      throw new ReporterError("Project Item Status verification failed");
    }
    return STATUS_NAME;
  }
}

function validateIssue(issue, input) {
  if (!isObject(issue) || issue.pull_request !== undefined) {
    throw new ReporterError("completion subject is not an Issue");
  }
  if (
    issue.node_id !== input.subjectNodeId ||
    issue.number !== input.subjectNumber
  ) {
    throw new ReporterError("Issue identity does not match tool input");
  }
}

function validateProjectItem(projectLookup, input) {
  if (projectLookup.configuredProjectId !== PROJECT_ID) {
    throw new ReporterError(
      "drasi-project Project number 3 does not match the fixed Project node ID",
    );
  }
  const item = projectLookup.item;
  if (!isObject(item) || item.id !== input.projectItemNodeId) {
    throw new ReporterError("Project Item was not found");
  }
  if (item.project?.id !== PROJECT_ID) {
    throw new ReporterError("Project Item does not belong to the fixed Project");
  }
  if (
    item.content?.id !== input.subjectNodeId ||
    item.content?.number !== input.subjectNumber ||
    item.content?.repository?.nameWithOwner !== REPOSITORY
  ) {
    throw new ReporterError(
      "Project Item does not contain the validated repository Issue",
    );
  }
}

function validateActiveExecution(comments, input, config) {
  const matches = [];
  for (const comment of comments) {
    if (
      !isObject(comment) ||
      comment.user?.id !== config.launcherUserId ||
      typeof comment.body !== "string"
    ) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(comment.body);
    } catch {
      continue;
    }
    if (!isObject(record) || record.executionId !== input.executionId) {
      continue;
    }
    const expected = {
      schemaVersion: "workgraph.execution/v1",
      messageType: "execution",
      routeId: input.routeId,
      responsibilityId: input.responsibilityId,
      executionId: input.executionId,
      expectedEventId: input.expectedEventId,
      requiredEventType: EVENT_TYPE,
      agentProfile: ACTOR_ID,
      profileRef: input.profileRef,
      state: "started",
    };
    const mismatches = Object.entries(expected)
      .filter(([key, value]) => record[key] !== value)
      .map(([key]) => key);
    if (mismatches.length > 0) {
      throw new ReporterError(
        `trusted execution record conflicts with: ${mismatches.join(", ")}`,
      );
    }
    for (const field of [
      "taskId",
      "taskUrl",
      "requestedModel",
      "actualModel",
    ]) {
      requireString(record[field], `execution.${field}`);
    }
    requireRfc3339(record.startedAt, "execution.startedAt");
    matches.push(record);
  }
  if (matches.length !== 1) {
    throw new ReporterError(
      "exactly one trusted started execution must match the completion; " +
        `expected launcher user ID ${config.launcherUserId} ` +
        `(${config.launcherLogin})`,
    );
  }
}

function findOwnedCompletion(comments, input, issueBody, identity) {
  const matches = [];
  for (const comment of comments) {
    if (!isObject(comment) || comment.user?.id !== identity.id) {
      continue;
    }
    const event = parseCompletionComment(comment.body);
    if (event?.eventId === input.expectedEventId) {
      const expected = validateExistingEvent(event, input, issueBody);
      if (comment.body !== formatComment(expected)) {
        throw new ReporterError(
          "authenticated completion comment is not canonically formatted",
        );
      }
      matches.push({ comment, event: expected });
      continue;
    }
    if (
      typeof comment.body === "string" &&
      comment.body.startsWith("WorkGraphEvent/v1") &&
      comment.body.includes(input.expectedEventId)
    ) {
      throw new ReporterError(
        "authenticated identity wrote a conflicting completion comment",
      );
    }
  }
  if (matches.length > 1) {
    throw new ReporterError(
      "multiple authenticated completion comments exist for eventId",
    );
  }
  return matches[0] ?? null;
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
    validateIssue(issue, input);
    const item = await this.client.getProjectItem(input.projectItemNodeId);
    validateProjectItem(item, input);
    let comments = await this.client.listComments(input.subjectNumber);
    validateActiveExecution(comments, input, this.config);

    let completion = findOwnedCompletion(
      comments,
      input,
      issue.body,
      identity,
    );
    let reconciled = completion !== null;
    if (completion === null) {
      const event = canonicalEvent(input, issue.body, completedAtNow());
      const body = formatComment(event);
      let comment;
      try {
        comment = await this.client.createComment(input.subjectNumber, body);
      } catch (error) {
        if (!(error instanceof AmbiguousCreateError)) {
          throw error;
        }
        comments = await this.client.listComments(input.subjectNumber);
        validateActiveExecution(comments, input, this.config);
        completion = findOwnedCompletion(
          comments,
          input,
          issue.body,
          identity,
        );
        if (completion === null) {
          throw new ReporterError(
            "comment creation was ambiguous and no authenticated completion was found",
          );
        }
        reconciled = true;
      }
      if (completion === null) {
        if (
          !isObject(comment) ||
          comment.user?.id !== identity.id ||
          comment.body !== body
        ) {
          throw new ReporterError(
            "GitHub did not confirm the authenticated canonical comment",
          );
        }
        completion = { comment, event };
      }
    }

    const commentNodeId = completion.comment.node_id;
    if (typeof commentNodeId !== "string" || commentNodeId.length === 0) {
      throw new ReporterError("completion comment has no node ID");
    }

    const projectStatus = await this.client.setAwaitingRouting(
      input.projectItemNodeId,
    );
    return {
      eventId: input.expectedEventId,
      commentNodeId,
      projectItemNodeId: input.projectItemNodeId,
      projectStatus,
      reconciled,
    };
  }
}

const TOOL = {
  name: "report_completion",
  description:
    "Validate one trusted issue-validation execution, publish its canonical " +
    "event, then set its fixed Project Item status to AwaitingRouting.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: INPUT_KEYS,
    properties: {
      projectItemNodeId: { type: "string", pattern: "^PVTI_" },
      subjectNodeId: { type: "string", pattern: "^I_" },
      subjectNumber: { type: "integer", minimum: 1 },
      routeId: { type: "string", minLength: 1 },
      responsibilityId: { type: "string", minLength: 1 },
      executionId: { type: "string", pattern: "^execution:" },
      expectedEventId: { type: "string", minLength: 1 },
      contentVersion: { type: "string", minLength: 1 },
      profileRef: {
        type: "string",
        pattern: "^issue-validator@[0-9a-fA-F]{40}$",
      },
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
          version: "2.0.0",
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
