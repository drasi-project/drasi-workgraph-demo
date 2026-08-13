import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPORTER = path.join(
  ROOT,
  ".github",
  "mcp",
  "workgraph-reporter.mjs",
);
const FIXTURE = JSON.parse(
  await readFile(
    path.join(ROOT, "tests", "fixtures", "issue-validator-events.json"),
    "utf8",
  ),
);

const PROJECT_ID = "PVT_kwDOCX0YF84BgNE3";
const STATUS_FIELD_ID = "PVTSSF_lADOCX0YF84BgNE3zhaadbw";
const STATUS_OPTION_ID = "3407e5fe";
const REPOSITORY = "drasi-project/drasi-workgraph-demo";
const INPUT = FIXTURE.taskPrompt;

function resultForBody(body) {
  const found = (body ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line === "WorkGraph-Validation: pass");
  return found
    ? {
        outcome: "passed",
        reasonCode: "required-marker-present",
        evidence: {
          requiredMarker: "WorkGraph-Validation: pass",
          found: true,
        },
        summary: "The required prototype marker is present.",
      }
    : {
        outcome: "failed",
        reasonCode: "required-marker-missing",
        evidence: {
          requiredMarker: "WorkGraph-Validation: pass",
          found: false,
        },
        summary: "The required prototype marker is missing.",
      };
}

function canonicalEvent(
  input,
  issueBody,
  completedAt = "2026-08-13T01:00:20Z",
) {
  return {
    schemaVersion: "workgraph.event/v1",
    eventId: input.expectedEventId,
    eventType: "CompletedIssueValidation",
    projectItemNodeId: input.projectItemNodeId,
    subjectType: "Issue",
    subjectNodeId: input.subjectNodeId,
    repository: REPOSITORY,
    subjectNumber: input.subjectNumber,
    actorType: "Agent",
    actorId: "issue-validator",
    routeId: input.routeId,
    responsibilityId: input.responsibilityId,
    executionId: input.executionId,
    contentVersion: input.contentVersion,
    profileRef: input.profileRef,
    result: resultForBody(issueBody),
    completedAt,
  };
}

function eventComment(event) {
  return `WorkGraphEvent/v1\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
}

function executionComment(input) {
  return {
    node_id: "IC_execution",
    user: { id: 7, login: "trusted-launcher" },
    body: JSON.stringify({
      schemaVersion: "workgraph.execution/v1",
      messageType: "execution",
      routeId: input.routeId,
      responsibilityId: input.responsibilityId,
      executionId: input.executionId,
      expectedEventId: input.expectedEventId,
      requiredEventType: "CompletedIssueValidation",
      taskId: "task-1",
      taskUrl: "https://github.com/github/copilot/tasks/task-1",
      agentProfile: "issue-validator",
      profileRef: input.profileRef,
      requestedModel: "gpt-5.6-sol",
      actualModel: "gpt-5.4",
      state: "started",
      startedAt: "2026-08-13T01:00:05Z",
    }),
  };
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startFakeGitHub({
  issueBody = "Context\nWorkGraph-Validation: pass\n",
  existingComments = [],
  commentMode = "success",
  projectItem = {},
} = {}) {
  const state = {
    comments: [executionComment(INPUT), ...existingComments],
    operations: [],
    mutation: null,
    projectQuery: null,
    postAttempts: 0,
  };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer test-token") {
      sendJson(response, 401, { message: "bad token" });
      return;
    }
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/user") {
      state.operations.push("identity");
      sendJson(response, 200, { id: 42, login: "workgraph-reporter" });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/repos/drasi-project/drasi-workgraph-demo/issues/${INPUT.subjectNumber}`
    ) {
      state.operations.push("issue");
      sendJson(response, 200, {
        node_id: INPUT.subjectNodeId,
        number: INPUT.subjectNumber,
        body: issueBody,
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(
        `/issues/${INPUT.subjectNumber}/comments`,
      )
    ) {
      state.operations.push("comments");
      sendJson(response, 200, state.comments);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith(
        `/issues/${INPUT.subjectNumber}/comments`,
      )
    ) {
      state.postAttempts += 1;
      const payload = await requestBody(request);
      if (commentMode === "failure") {
        state.operations.push("comment-failure");
        sendJson(response, 422, { message: "comment rejected" });
        return;
      }
      const comment = {
        node_id: "IC_created",
        user: { id: 42, login: "workgraph-reporter" },
        body: payload.body,
      };
      state.comments.push(comment);
      if (commentMode === "ambiguous" && state.postAttempts === 1) {
        state.operations.push("comment-ambiguous");
        request.socket.destroy();
        return;
      }
      state.operations.push("comment");
      sendJson(response, 201, comment);
      return;
    }
    if (request.method === "POST" && url.pathname === "/graphql") {
      const payload = await requestBody(request);
      if (payload.query.includes("query WorkGraphProjectItem")) {
        state.operations.push("project-item");
        state.projectQuery = payload.query;
        sendJson(response, 200, {
          data: {
            organization: {
              projectV2: {
                id: projectItem.configuredProjectId ?? PROJECT_ID,
              },
            },
            node: {
              id: projectItem.id ?? INPUT.projectItemNodeId,
              project: {
                id: projectItem.projectId ?? PROJECT_ID,
              },
              content: {
                id: projectItem.subjectNodeId ?? INPUT.subjectNodeId,
                number:
                  projectItem.subjectNumber ?? INPUT.subjectNumber,
                repository: {
                  nameWithOwner:
                    projectItem.repository ?? REPOSITORY,
                },
              },
            },
          },
        });
        return;
      }
      if (payload.query.includes("query WorkGraphVerifyStatus")) {
        state.operations.push("status-verify");
        sendJson(response, 200, {
          data: {
            node: {
              fieldValueByName: { name: "AwaitingRouting" },
            },
          },
        });
        return;
      }
      if (payload.query.includes("mutation WorkGraphAwaitingRouting")) {
        state.operations.push("status");
        state.mutation = payload;
        sendJson(response, 200, {
          data: {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: INPUT.projectItemNodeId },
            },
          },
        });
        return;
      }
    }
    sendJson(response, 404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    state,
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function runMcp(
  messages,
  apiUrl,
  { reporterLogin = "workgraph-reporter" } = {},
) {
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKGRAPH_TEST_GITHUB_API_URL: apiUrl,
      WORKGRAPH_TOKEN: "test-token",
      WORKGRAPH_LAUNCHER_LOGIN: "trusted-launcher",
      WORKGRAPH_REPORTER_LOGIN: reporterLogin,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function protocolMessages(argumentsValue = INPUT) {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "report_completion",
        arguments: argumentsValue,
      },
    },
  ];
}

test("exposes exactly one strict report_completion tool", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(
      responses[0].result.serverInfo.name,
      "drasi-workgraph-completion-reporter",
    );
    assert.deepEqual(responses[1].result, {});
    const tools = responses[2].result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "report_completion",
    ]);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(tools[0].inputSchema.properties).sort(),
      Object.keys(INPUT).sort(),
    );
    const properties = tools[0].inputSchema.properties;
    for (const forbidden of [
      "repository",
      "project",
      "status",
      "field",
      "commentBody",
      "graphql",
    ]) {
      assert.equal(Object.hasOwn(properties, forbidden), false);
    }
  } finally {
    await fake.close();
  }
});

test("rejects additional input before any GitHub operation", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(
      protocolMessages({ ...INPUT, status: "Done" }),
      fake.apiUrl,
    );
    assert.equal(responses[3].result.isError, true);
    assert.match(responses[3].result.content[0].text, /extra=.*status/);
    assert.deepEqual(fake.state.operations, []);
  } finally {
    await fake.close();
  }
});

test("rejects a PAT identity that does not match configured reporter", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl, {
      reporterLogin: "different-reporter",
    });
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /PAT identity does not match/,
    );
    assert.deepEqual(fake.state.operations, ["identity"]);
  } finally {
    await fake.close();
  }
});

test("creates a server-owned canonical event before fixed status mutation", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.equal(result.reconciled, false);
    assert.equal(result.projectStatus, "AwaitingRouting");
    assert.ok(
      fake.state.operations.indexOf("comment") <
        fake.state.operations.indexOf("status"),
    );
    const created = fake.state.comments.at(-1);
    assert.equal(created.user.id, 42);
    assert.match(created.body, /^WorkGraphEvent\/v1\n```json\n/);
    const payload = JSON.parse(
      created.body.match(/```json\n([\s\S]+)\n```$/)[1],
    );
    assert.equal(payload.repository, REPOSITORY);
    assert.equal(payload.actorType, "Agent");
    assert.equal(payload.actorId, "issue-validator");
    assert.equal(payload.eventType, "CompletedIssueValidation");
    assert.equal(payload.result.outcome, "passed");
    assert.match(payload.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(fake.state.mutation.variables.item, INPUT.projectItemNodeId);
    const projectRead = fake.state.operations.indexOf("project-item");
    assert.ok(projectRead >= 0);
    assert.match(
      fake.state.projectQuery,
      /organization\(login: "drasi-project"\)/,
    );
    assert.match(fake.state.projectQuery, /projectV2\(number: 3\)/);
    assert.match(fake.state.mutation.query, new RegExp(PROJECT_ID));
    assert.match(fake.state.mutation.query, new RegExp(STATUS_FIELD_ID));
    assert.match(fake.state.mutation.query, new RegExp(STATUS_OPTION_ID));
    assert.ok(
      fake.state.operations.indexOf("status") <
        fake.state.operations.indexOf("status-verify"),
    );
  } finally {
    await fake.close();
  }
});

test("rejects a mismatched fixed Project owner/number lookup", async () => {
  const fake = await startFakeGitHub({
    projectItem: { configuredProjectId: "PVT_wrong" },
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /Project number 3 does not match/,
    );
    assert.equal(fake.state.postAttempts, 0);
    assert.equal(fake.state.operations.includes("status"), false);
  } finally {
    await fake.close();
  }
});

test("adopts one authenticated schema-valid duplicate", async () => {
  const issueBody = "WorkGraph-Validation: pass\n";
  const existing = {
    node_id: "IC_existing",
    user: { id: 42, login: "workgraph-reporter" },
    body: eventComment(canonicalEvent(INPUT, issueBody)),
  };
  const fake = await startFakeGitHub({
    issueBody,
    existingComments: [existing],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.structuredContent.reconciled, true);
    assert.equal(responses[3].result.structuredContent.commentNodeId, "IC_existing");
    assert.equal(fake.state.postAttempts, 0);
    assert.ok(fake.state.operations.includes("status"));
  } finally {
    await fake.close();
  }
});

test("does not adopt a spoofed completion comment", async () => {
  const issueBody = "WorkGraph-Validation: pass\n";
  const spoof = {
    node_id: "IC_spoof",
    user: { id: 99, login: "attacker" },
    body: eventComment(canonicalEvent(INPUT, issueBody)),
  };
  const fake = await startFakeGitHub({
    issueBody,
    existingComments: [spoof],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.structuredContent.reconciled, false);
    assert.equal(fake.state.postAttempts, 1);
    assert.ok(
      fake.state.operations.indexOf("comment") <
        fake.state.operations.indexOf("status"),
    );
  } finally {
    await fake.close();
  }
});

test("reconciles an ambiguous comment create before status", async () => {
  const fake = await startFakeGitHub({ commentMode: "ambiguous" });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.equal(result.reconciled, true);
    assert.equal(result.commentNodeId, "IC_created");
    assert.equal(fake.state.postAttempts, 1);
    const ambiguous = fake.state.operations.indexOf("comment-ambiguous");
    const secondCommentRead = fake.state.operations.lastIndexOf("comments");
    const status = fake.state.operations.indexOf("status");
    assert.ok(ambiguous < secondCommentRead);
    assert.ok(secondCommentRead < status);
  } finally {
    await fake.close();
  }
});

test("never writes status after explicit comment failure", async () => {
  const fake = await startFakeGitHub({ commentMode: "failure" });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /HTTP 422: comment rejected/,
    );
    assert.equal(fake.state.operations.includes("status"), false);
  } finally {
    await fake.close();
  }
});

test("rejects a Project Item outside the fixed Project", async () => {
  const fake = await startFakeGitHub({
    projectItem: { projectId: "PVT_wrong" },
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /does not belong to the fixed Project/,
    );
    assert.equal(fake.state.postAttempts, 0);
    assert.equal(fake.state.operations.includes("status"), false);
  } finally {
    await fake.close();
  }
});
