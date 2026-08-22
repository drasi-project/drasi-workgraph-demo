import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { formatTask } from "../../.github/mcp/workgraph-reporter.mjs";

export const FIXED_REPOSITORY = "drasi-project/drasi-workgraph-demo";
export const TASK_PAYLOAD = {
  taskType: "validate-issue",
  inputs: { validationProfile: "new-issue-default" },
};
export const TASK_BODY = formatTask(TASK_PAYLOAD);

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REPORTER = path.join(ROOT, ".github/mcp/workgraph-reporter.mjs");
const API = "https://api.github.com";
const GRAPHQL_API = `${API}/graphql`;
const RUN_MARKER = /^wg-protocol-it\/\d{8}T\d{6}Z\/[0-9a-f-]{36}$/;
const CLEANUP_POLL_INTERVAL_MS = 5_000;
const CLEANUP_POLL_TIMEOUT_MS = 60_000;
const ROLE_ENV = [
  "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
  "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
  "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
  "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
  "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
];

function required(env, name) {
  const value = env[name] ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numericId(env, name) {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadLiveConfig(env = process.env) {
  if (env.WORKGRAPH_GITHUB_INTEGRATION !== "1") {
    throw new Error(
      "live GitHub protocol tests require WORKGRAPH_GITHUB_INTEGRATION=1",
    );
  }
  const repository = required(env, "WORKGRAPH_GITHUB_REPOSITORY");
  if (repository !== FIXED_REPOSITORY) {
    throw new Error(`WORKGRAPH_GITHUB_REPOSITORY must be ${FIXED_REPOSITORY}`);
  }
  const taskTypeId = required(
    env,
    "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID",
  );
  if (!/^[A-Za-z0-9_-]+$/.test(taskTypeId)) {
    throw new Error(
      "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID must be a GitHub node ID",
    );
  }
  return {
    repository,
    token: required(env, "COPILOT_MCP_WORKGRAPH_TOKEN"),
    taskTypeId,
    roleIds: Object.fromEntries(
      ROLE_ENV.map((name) => [name, numericId(env, name)]),
    ),
  };
}

export function makeRunMarker(
  now = new Date(),
  uuid = randomUUID(),
) {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `wg-protocol-it/${timestamp}/${uuid}`;
}

export function validateRunMarker(marker) {
  if (!RUN_MARKER.test(marker)) {
    throw new Error("WORKGRAPH_GITHUB_RUN_ID is not a canonical run marker");
  }
  return marker;
}

export function parentTitle(marker) {
  return `[${validateRunMarker(marker)}] parent`;
}

export function parentBody(marker) {
  return (
    "WorkGraph GitHub protocol integration parent.\n\n" +
    `<!-- WorkGraphProtocolIntegration/v1 runId=${validateRunMarker(marker)} -->\n`
  );
}

export function childTitle(marker) {
  return `[${validateRunMarker(marker)}] validate-issue`;
}

function issueKind(issue, marker) {
  if (issue.title === parentTitle(marker)) return "parent";
  if (issue.title === childTitle(marker)) return "child";
  return null;
}

function validateCleanupIssue(issue, marker, actorId) {
  const kind = issueKind(issue, marker);
  if (kind === null) return null;
  if (
    issue.pull_request ||
    issue.user?.id !== actorId ||
    issue.repository_url !== `${API}/repos/${FIXED_REPOSITORY}` ||
    (kind === "parent" && issue.body !== parentBody(marker)) ||
    (kind === "child" && issue.body !== TASK_BODY)
  ) {
    throw new Error(
      `refusing cleanup: ${kind} marker match has foreign provenance or body`,
    );
  }
  return { kind, issue };
}

export function selectCleanupIssues(issues, marker, actorId) {
  validateRunMarker(marker);
  const selected = issues
    .map((issue) => validateCleanupIssue(issue, marker, actorId))
    .filter(Boolean);
  for (const kind of ["parent", "child"]) {
    if (selected.filter((entry) => entry.kind === kind).length > 1) {
      throw new Error(`refusing cleanup: multiple ${kind} issues match marker`);
    }
  }
  return selected;
}

export class GitHubClient {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(url, { method = "GET", body } = {}) {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "drasi-workgraph-protocol-integration",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`GitHub returned non-JSON HTTP ${response.status}`);
      }
    }
    if (!response.ok) {
      throw new Error(
        `GitHub request failed with HTTP ${response.status}: ${payload?.message ?? "unknown error"}`,
      );
    }
    return payload;
  }

  rest(method, route, body) {
    return this.request(`${API}${route}`, { method, body });
  }

  async graphql(query, variables) {
    const payload = await this.request(GRAPHQL_API, {
      method: "POST",
      body: { query, variables },
    });
    if (payload.errors?.length) {
      throw new Error(
        `GitHub GraphQL failed: ${payload.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    return payload.data;
  }

  async repositoryAndViewer() {
    const data = await this.graphql(
      `query RepositoryAndViewer($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) { id }
        viewer { login }
      }`,
      { owner: "drasi-project", repo: "drasi-workgraph-demo" },
    );
    const restViewer = await this.rest("GET", "/user");
    return {
      repositoryId: data.repository.id,
      login: data.viewer.login,
      id: restViewer.id,
    };
  }

  async createIssue(input) {
    const data = await this.graphql(
      `mutation CreateProtocolIssue($input: CreateIssueInput!) {
        createIssue(input: $input) {
          issue {
            id
            number
            title
            body
            url
            state
            author { login }
            issueType { id name }
            parent { id number }
          }
        }
      }`,
      { input },
    );
    return data.createIssue.issue;
  }

  async graphIssue(number) {
    const data = await this.graphql(
      `query ProtocolIssue($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            id
            number
            title
            body
            state
            author { login }
            issueType { id name }
            parent { id number }
            subIssues(first: 100) { nodes { id number } }
          }
        }
      }`,
      { owner: "drasi-project", repo: "drasi-workgraph-demo", number },
    );
    return data.repository.issue;
  }

  issue(number) {
    return this.rest(
      "GET",
      `/repos/drasi-project/drasi-workgraph-demo/issues/${number}`,
    );
  }

  parent(number) {
    return this.rest(
      "GET",
      `/repos/drasi-project/drasi-workgraph-demo/issues/${number}/parent`,
    );
  }

  async paginate(route, label) {
    const items = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = route.includes("?") ? "&" : "?";
      const batch = await this.rest(
        "GET",
        `${route}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new Error(`${label} pagination response must be an array`);
      }
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(`${label} pagination exceeded 100 pages`);
  }

  comments(number) {
    return this.paginate(
      `/repos/drasi-project/drasi-workgraph-demo/issues/${number}/comments`,
      "issue comments",
    );
  }

  closeIssue(number) {
    return this.rest(
      "PATCH",
      `/repos/drasi-project/drasi-workgraph-demo/issues/${number}`,
      { state: "closed" },
    );
  }

  async openIssues() {
    const issues = await this.paginate(
      "/repos/drasi-project/drasi-workgraph-demo/issues?state=open",
      "open issues",
    );
    return issues.filter((issue) => !issue.pull_request);
  }
}

export async function cleanupRun(
  client,
  {
    marker,
    actorId,
    tracked = [],
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
) {
  validateRunMarker(marker);
  const byNumber = new Map();
  for (const item of tracked) {
    const issue = await client.issue(item.number);
    const validated = validateCleanupIssue(issue, marker, actorId);
    if (validated?.kind !== item.kind) {
      throw new Error(
        `refusing cleanup: tracked ${item.kind} #${item.number} does not match the run marker`,
      );
    }
    byNumber.set(issue.number, issue);
  }
  for (const issue of await client.openIssues()) {
    if (issueKind(issue, marker) !== null) byNumber.set(issue.number, issue);
  }
  const selected = selectCleanupIssues(
    [...byNumber.values()],
    marker,
    actorId,
  );
  const parent = selected.find((entry) => entry.kind === "parent")?.issue;
  const child = selected.find((entry) => entry.kind === "child")?.issue;
  if (child) {
    const nativeParent = await client.parent(child.number);
    const expectedParent = parent ?? (await client.issue(nativeParent.number));
    const validatedParent = validateCleanupIssue(
      expectedParent,
      marker,
      actorId,
    );
    if (validatedParent?.kind !== "parent") {
      throw new Error(
        "refusing cleanup: child native parent is not the run parent",
      );
    }
    if (
      nativeParent.number !== expectedParent.number ||
      nativeParent.node_id !== expectedParent.node_id
    ) {
      throw new Error(
        "refusing cleanup: child native parent does not match the run parent",
      );
    }
  }

  const failures = [];
  for (const issue of [child, parent].filter(Boolean)) {
    if (issue.state === "closed") continue;
    try {
      await client.closeIssue(issue.number);
    } catch (error) {
      failures.push(new Error(`failed to close issue #${issue.number}: ${error.message}`));
    }
  }

  for (
    let elapsed = 0;
    elapsed <= CLEANUP_POLL_TIMEOUT_MS;
    elapsed += CLEANUP_POLL_INTERVAL_MS
  ) {
    const remaining = selectCleanupIssues(
      await client.openIssues(),
      marker,
      actorId,
    );
    if (remaining.length === 0) break;
    if (elapsed === CLEANUP_POLL_TIMEOUT_MS) {
      failures.push(
        new Error("marker-scoped open issues remain after cleanup"),
      );
      break;
    }
    await sleep(CLEANUP_POLL_INTERVAL_MS);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "WorkGraph integration cleanup failed");
  }
  return selected.map(({ kind, issue }) => ({
    kind,
    number: issue.number,
  }));
}

export async function invokeReporter(
  config,
  leaseValidator,
  tool,
  args,
) {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
  ];
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      NODE_ENV: "test",
      COPILOT_MCP_WORKGRAPH_TOKEN: config.token,
      COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: config.taskTypeId,
      ...Object.fromEntries(
        Object.entries(config.roleIds).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
      COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL: leaseValidator.url,
      COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN: leaseValidator.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  const [code] = await once(child, "close");
  if (code !== 0 || stderr !== "") {
    throw new Error(`reporter process failed with code ${code}`);
  }
  const responses = stdout.trim().split("\n").map(JSON.parse);
  return responses.at(-1).result;
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
}

export async function startLeaseValidator() {
  const token = randomBytes(32).toString("hex");
  const leases = new Map();
  const counts = new Map();
  const queuedModes = [];
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/lease/validate" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    const payload = await readJson(request);
    const lease = leases.get(payload?.leaseId);
    counts.set(payload?.leaseId, (counts.get(payload?.leaseId) ?? 0) + 1);
    const expected = lease && {
      taskNodeId: lease.taskNodeId,
      leaseId: lease.leaseId,
      assignmentCommentNodeId: lease.assignmentCommentNodeId,
      agentId: lease.agentId,
      slotId: lease.slotId,
    };
    if (!lease || !isDeepStrictEqual(payload, expected)) {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    const mode = queuedModes.shift() ?? "ok";
    if (mode === "unauthorized") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end("{}");
      return;
    }
    if (mode === "malformed") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{");
      return;
    }
    const body =
      mode === "extra"
        ? { ...lease, unexpected: true }
        : mode === "mismatch"
          ? { ...lease, slotId: `${lease.agentId}/99` }
          : lease;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    token,
    url: `http://127.0.0.1:${server.address().port}/lease/validate`,
    register(lease) {
      if (leases.has(lease.leaseId)) {
        throw new Error(`Lease ${lease.leaseId} is already registered`);
      }
      leases.set(lease.leaseId, structuredClone(lease));
    },
    queueMode(mode) {
      queuedModes.push(mode);
    },
    count(leaseId) {
      return counts.get(leaseId) ?? 0;
    },
    close() {
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
