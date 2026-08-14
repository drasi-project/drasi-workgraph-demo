import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const REPOSITORY = "drasi-project/drasi-workgraph-demo";
const INPUT = FIXTURE.input;
const IDENTITY = FIXTURE.identity;
const TIMESTAMP = "2026-08-14T12:00:00Z";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestForBody(body) {
  return `sha256:${sha256(body ?? "")}`;
}

function runIdFor(contentDigest) {
  const material =
    `workgraph.run/v1\n${IDENTITY.projectItemNodeId}\n` +
    `${IDENTITY.subjectNodeId}\n${contentDigest}`;
  return `run:sha256:${sha256(material)}`;
}

function eventIdFor(runId, eventType) {
  return `event:sha256:${sha256(
    `workgraph.event/v1\n${runId}\n${eventType}`,
  )}`;
}

function envelope(eventType, runId, payload) {
  return {
    schemaVersion: "workgraph.event/v1",
    eventId: eventIdFor(runId, eventType),
    eventType,
    runId,
    projectItemNodeId: IDENTITY.projectItemNodeId,
    subjectNodeId: IDENTITY.subjectNodeId,
    payload,
  };
}

function assignmentEvent(body) {
  const contentDigest = digestForBody(body);
  const runId = runIdFor(contentDigest);
  return envelope("ResponsibilityAssigned", runId, {
    responsibilityType: "issue-validation",
    profileRef: IDENTITY.profileRef,
    contentDigest,
  });
}

function executionEvent(body) {
  const runId = runIdFor(digestForBody(body));
  return envelope("ExecutionStarted", runId, {
    executionId: INPUT.executionId,
    taskId: IDENTITY.taskId,
  });
}

function completionEvent(body) {
  const passed = (body ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .includes("WorkGraph-Validation: pass");
  return envelope(
    "CompletedIssueValidation",
    runIdFor(digestForBody(body)),
    {
      executionId: INPUT.executionId,
      outcome: passed ? "passed" : "failed",
      reasonCode: passed
        ? "required-marker-present"
        : "required-marker-missing",
    },
  );
}

function summaryFor(event) {
  switch (event.eventType) {
    case "ResponsibilityAssigned":
      return "Issue validation responsibility assigned.";
    case "ExecutionStarted":
      return "Issue validation execution started.";
    case "CompletedIssueValidation":
      return event.payload.outcome === "passed"
        ? "Issue validation passed."
        : "Issue validation failed.";
    default:
      throw new Error("unsupported fixture event");
  }
}

function eventBody(event, summary = summaryFor(event)) {
  return (
    `WorkGraphEvent/v1\n\n${summary}\n\n` +
    JSON.stringify(event, null, 2)
  );
}

function comment(
  event,
  {
    nodeId = `IC_${event.eventType}`,
    userId = 7,
    login = "trusted-launcher",
    body = eventBody(event),
    createdAt = TIMESTAMP,
    updatedAt = createdAt,
  } = {},
) {
  return {
    node_id: nodeId,
    user: { id: userId, login },
    body,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function trustedComments(body) {
  return [
    comment(assignmentEvent(body)),
    comment(executionEvent(body)),
  ];
}

function parseEventBody(body) {
  const match =
    /^WorkGraphEvent\/v1\n\n([^\n]+)\n\n(\{[\s\S]*\})$/.exec(body);
  assert.ok(match, "expected strict WorkGraphEvent/v1 body");
  return { summary: match[1], event: JSON.parse(match[2]) };
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
  issueBody = FIXTURE.passed.body,
  issueBodies,
  assignmentBody = issueBody ?? "",
  comments,
  extraComments = [],
  commentMode = "success",
  projectId = PROJECT_ID,
  projectItems,
  issueNodeId = IDENTITY.subjectNodeId,
} = {}) {
  const state = {
    comments: [
      ...(comments ?? trustedComments(assignmentBody)),
      ...extraComments,
    ],
    operations: [],
    postAttempts: 0,
    issueReads: 0,
    graphqlQueries: [],
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
      const currentBody =
        issueBodies?.[
          Math.min(state.issueReads, issueBodies.length - 1)
        ] ?? issueBody;
      state.issueReads += 1;
      sendJson(response, 200, {
        node_id: issueNodeId,
        number: INPUT.subjectNumber,
        body: currentBody,
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/issues/${INPUT.subjectNumber}/comments`)
    ) {
      state.operations.push("comments");
      sendJson(response, 200, state.comments);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith(`/issues/${INPUT.subjectNumber}/comments`)
    ) {
      state.postAttempts += 1;
      const payload = await requestBody(request);
      if (commentMode === "failure") {
        state.operations.push("comment-failure");
        sendJson(response, 422, { message: "comment rejected" });
        return;
      }
      const created = {
        node_id: "IC_created",
        user: { id: 42, login: "workgraph-reporter" },
        body: payload.body,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      };
      state.comments.push(created);
      if (
        commentMode === "ambiguous-changed-correlation" ||
        commentMode === "success-changed-correlation"
      ) {
        state.comments = [
          ...trustedComments(FIXTURE.failed.body),
          created,
        ];
      }
      if (commentMode === "ambiguous-changed-correlation") {
        state.operations.push("comment-ambiguous");
        request.socket.destroy();
        return;
      }
      if (commentMode === "race") {
        state.comments.push({
          ...created,
          node_id: "IC_created_race",
        });
      }
      if (commentMode === "ambiguous" && state.postAttempts === 1) {
        state.operations.push("comment-ambiguous");
        request.socket.destroy();
        return;
      }
      if (commentMode === "empty-success") {
        state.operations.push("comment-empty-success");
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end("");
        return;
      }
      state.operations.push("comment");
      sendJson(response, 201, created);
      return;
    }
    if (request.method === "POST" && url.pathname === "/graphql") {
      const payload = await requestBody(request);
      state.graphqlQueries.push(payload.query);
      if (payload.query.includes("query WorkGraphProjectItems")) {
        state.operations.push("project-items");
        sendJson(response, 200, {
          data: {
            organization: {
              projectV2: {
                id: projectId,
                items: {
                  nodes:
                    projectItems ??
                    [
                      {
                        id: IDENTITY.projectItemNodeId,
                        content: {
                          id: issueNodeId,
                          number: INPUT.subjectNumber,
                          repository: { nameWithOwner: REPOSITORY },
                        },
                      },
                    ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
        return;
      }
      assert.fail(`unexpected GraphQL operation: ${payload.query}`);
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
  {
    launcherLogin = "trusted-launcher",
    launcherUserId = "7",
    reporterLogin = "workgraph-reporter",
    reporterUserId = "42",
  } = {},
) {
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKGRAPH_TEST_GITHUB_API_URL: apiUrl,
      WORKGRAPH_TOKEN: "test-token",
      WORKGRAPH_LAUNCHER_LOGIN: launcherLogin,
      WORKGRAPH_LAUNCHER_USER_ID: launcherUserId,
      WORKGRAPH_REPORTER_LOGIN: reporterLogin,
      WORKGRAPH_REPORTER_USER_ID: reporterUserId,
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

async function callReporter(fake, options) {
  const responses = await runMcp(
    protocolMessages(options?.input ?? INPUT),
    fake.apiUrl,
    options?.config,
  );
  return responses[3].result;
}

test("exposes exactly one strict two-field report_completion tool", async () => {
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
    assert.deepEqual(tools[0].inputSchema.required, [
      "subjectNumber",
      "executionId",
    ]);
    assert.deepEqual(
      Object.keys(tools[0].inputSchema.properties),
      ["subjectNumber", "executionId"],
    );
  } finally {
    await fake.close();
  }
});

test("rejects additional input before any GitHub operation", async () => {
  const fake = await startFakeGitHub();
  try {
    const result = await callReporter(fake, {
      input: { ...INPUT, subjectNodeId: IDENTITY.subjectNodeId },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /extra=.*subjectNodeId/);
    assert.deepEqual(fake.state.operations, []);
  } finally {
    await fake.close();
  }
});

test("shared body digest, run ID, and event ID vectors are exact", () => {
  for (const name of ["passed", "failed", "emptyBody"]) {
    const vector = FIXTURE[name];
    assert.equal(digestForBody(vector.body), vector.contentDigest);
    assert.equal(runIdFor(vector.contentDigest), vector.runId);
    for (const [eventType, expected] of Object.entries(vector.eventIds)) {
      assert.equal(eventIdFor(vector.runId, eventType), expected);
    }
  }
  assert.notEqual(
    digestForBody(FIXTURE.passed.body.replaceAll("\n", "\r\n")),
    FIXTURE.passed.contentDigest,
  );
});

for (const [name, vector] of [
  ["passed", FIXTURE.passed],
  ["failed", FIXTURE.failed],
]) {
  test(`creates the exact ${name} common event without Project mutation`, async () => {
    const fake = await startFakeGitHub({ issueBody: vector.body });
    try {
      const result = await callReporter(fake);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.eventId, vector.eventIds.CompletedIssueValidation);
      assert.equal(result.structuredContent.executionId, INPUT.executionId);
      assert.equal(result.structuredContent.projectItemNodeId, IDENTITY.projectItemNodeId);
      assert.equal(result.structuredContent.subjectNodeId, IDENTITY.subjectNodeId);
      assert.equal(result.structuredContent.reconciled, false);
      const created = fake.state.comments.at(-1);
      assert.equal(created.body.includes("```"), false);
      assert.equal(created.body.endsWith("}"), true);
      const parsed = parseEventBody(created.body);
      assert.equal(parsed.summary, vector.summary);
      assert.deepEqual(Object.keys(parsed.event), [
        "schemaVersion",
        "eventId",
        "eventType",
        "runId",
        "projectItemNodeId",
        "subjectNodeId",
        "payload",
      ]);
      assert.deepEqual(parsed.event.payload, vector.payload);
      for (const forbidden of [
        "actor",
        "actorType",
        "actorId",
        "repository",
        "number",
        "subjectNumber",
        "subjectType",
        "timestamp",
        "completedAt",
        "routeId",
        "responsibilityId",
        "contentVersion",
        "profileRef",
        "expectedEventId",
        "result",
        "evidence",
      ]) {
        assert.equal(Object.hasOwn(parsed.event, forbidden), false);
      }
      assert.deepEqual(fake.state.operations, [
        "identity",
        "issue",
        "comments",
        "project-items",
        "issue",
        "comment",
        "comments",
        "issue",
      ]);
      assert.equal(
        fake.state.graphqlQueries.some((query) =>
          query.includes("updateProjectV2ItemFieldValue"),
        ),
        false,
      );
    } finally {
      await fake.close();
    }
  });
}

test("treats a null body as exact empty UTF-8 and fails validation", async () => {
  const fake = await startFakeGitHub({
    issueBody: null,
    assignmentBody: "",
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
    const parsed = parseEventBody(fake.state.comments.at(-1).body);
    assert.equal(parsed.summary, "Issue validation failed.");
    assert.deepEqual(parsed.event.payload, {
      executionId: INPUT.executionId,
      outcome: "failed",
      reasonCode: "required-marker-missing",
    });
    assert.equal(parsed.event.runId, FIXTURE.emptyBody.runId);
  } finally {
    await fake.close();
  }
});

test("accepts renamed launcher and reporter logins by immutable IDs", async () => {
  const fake = await startFakeGitHub();
  try {
    const result = await callReporter(fake, {
      config: {
        launcherLogin: "renamed-launcher",
        launcherUserId: "7",
        reporterLogin: "renamed-reporter",
        reporterUserId: "42",
      },
    });
    assert.equal(result.isError, false);
  } finally {
    await fake.close();
  }
});

test("rejects reporter login reuse when immutable ID differs", async () => {
  const fake = await startFakeGitHub();
  try {
    const result = await callReporter(fake, {
      config: { reporterUserId: "99" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /expected 99/);
    assert.deepEqual(fake.state.operations, ["identity"]);
  } finally {
    await fake.close();
  }
});

test("rejects launcher login reuse when immutable ID differs", async () => {
  const fake = await startFakeGitHub();
  try {
    const result = await callReporter(fake, {
      config: { launcherUserId: "99" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /expected launcher user ID 99/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects invalid immutable IDs before GitHub access", async (t) => {
  for (const [field, message] of [
    ["launcherUserId", /LAUNCHER_USER_ID must be a positive integer/],
    ["reporterUserId", /REPORTER_USER_ID must be a positive integer/],
  ]) {
    await t.test(field, async () => {
      const fake = await startFakeGitHub();
      try {
        const result = await callReporter(fake, {
          config: { [field]: "not-an-integer" },
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, message);
        assert.deepEqual(fake.state.operations, []);
      } finally {
        await fake.close();
      }
    });
  }
});

test("accepts CRLF strict launcher events after parser normalization", async () => {
  const comments = trustedComments(FIXTURE.passed.body).map((entry) => ({
    ...entry,
    body: entry.body.replaceAll("\n", "\r\n"),
  }));
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
  } finally {
    await fake.close();
  }
});

test("strictly ignores legacy JSON-only and fenced event formats", async (t) => {
  const assignment = assignmentEvent(FIXTURE.passed.body);
  const execution = executionEvent(FIXTURE.passed.body);
  for (const [name, comments] of [
    [
      "JSON-only",
      [
        comment(assignment, { body: JSON.stringify(assignment) }),
        comment(execution, { body: JSON.stringify(execution) }),
      ],
    ],
    [
      "fenced",
      [
        comment(assignment, {
          body: `WorkGraphEvent/v1\n\`\`\`json\n${JSON.stringify(assignment, null, 2)}\n\`\`\``,
        }),
        comment(execution, {
          body: `WorkGraphEvent/v1\n\`\`\`json\n${JSON.stringify(execution, null, 2)}\n\`\`\``,
        }),
      ],
    ],
  ]) {
    await t.test(name, async () => {
      const fake = await startFakeGitHub({ comments });
      try {
        const result = await callReporter(fake);
        assert.equal(result.isError, true);
        assert.match(
          result.content[0].text,
          /exactly one trusted ExecutionStarted/,
        );
        assert.equal(fake.state.postAttempts, 0);
      } finally {
        await fake.close();
      }
    });
  }
});

test("rejects an unknown-field launcher event without writing", async () => {
  const execution = executionEvent(FIXTURE.passed.body);
  const comments = [
    comment(assignmentEvent(FIXTURE.passed.body)),
    comment({ ...execution, actor: "spoof" }),
  ];
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not strict and canonical/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects edited trusted launcher records without writing", async () => {
  const comments = trustedComments(FIXTURE.passed.body);
  comments[1] = {
    ...comments[1],
    updated_at: "2026-08-14T12:01:00Z",
  };
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /execution event was edited/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects ambiguous trusted execution records without writing", async () => {
  const comments = [
    ...trustedComments(FIXTURE.passed.body),
    comment(executionEvent(FIXTURE.passed.body), {
      nodeId: "IC_execution_duplicate",
    }),
  ];
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one trusted ExecutionStarted/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects trusted launcher reuse of the execution event ID", async () => {
  const execution = executionEvent(FIXTURE.passed.body);
  const conflict = {
    ...execution,
    eventType: "RoutingDecided",
    payload: {
      fromStatus: "AwaitingValidation",
      toStatus: "AwaitingIssueRiskProfiling",
      nextResponsibilityType: "issue-risk-profiling",
    },
  };
  const comments = [
    ...trustedComments(FIXTURE.passed.body),
    comment(conflict, {
      nodeId: "IC_execution_event_id_conflict",
      body: eventBody(conflict, "Routing decided."),
    }),
  ];
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /eventId is conflicting/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a trusted assignment that conflicts with execution identity", async () => {
  const assignment = assignmentEvent(FIXTURE.passed.body);
  const conflicting = {
    ...assignment,
    projectItemNodeId: "PVTI_conflict",
  };
  const comments = [
    comment(conflicting),
    comment(executionEvent(FIXTURE.passed.body)),
  ];
  const fake = await startFakeGitHub({ comments });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /assignment runId is invalid/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects stale authoritative body before any write", async () => {
  const fake = await startFakeGitHub({
    issueBody: "Changed after assignment\nWorkGraph-Validation: pass\n",
    assignmentBody: FIXTURE.passed.body,
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /body digest does not match/);
    assert.equal(fake.state.postAttempts, 0);
    assert.deepEqual(fake.state.operations, [
      "identity",
      "issue",
      "comments",
      "project-items",
    ]);
  } finally {
    await fake.close();
  }
});

test("rechecks the exact body digest immediately before writing", async () => {
  const changed = "Changed during reporting\nWorkGraph-Validation: pass\n";
  const fake = await startFakeGitHub({
    issueBody: FIXTURE.passed.body,
    issueBodies: [FIXTURE.passed.body, changed],
    assignmentBody: FIXTURE.passed.body,
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /body changed during/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a mismatched fixed Project lookup without writing", async () => {
  const fake = await startFakeGitHub({ projectId: "PVT_wrong" });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not match the fixed Project/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a Project Item that does not track the exact Issue", async () => {
  const fake = await startFakeGitHub({ projectItems: [] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one Item tracking the Issue/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("reconciles one exact unedited reporter-authored completion", async () => {
  const event = completionEvent(FIXTURE.passed.body);
  const existing = comment(event, {
    nodeId: "IC_existing",
    userId: 42,
    login: "workgraph-reporter",
  });
  const fake = await startFakeGitHub({ extraComments: [existing] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.reconciled, true);
    assert.equal(result.structuredContent.commentNodeId, "IC_existing");
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("does not adopt a spoofed canonical completion", async () => {
  const spoof = comment(completionEvent(FIXTURE.passed.body), {
    nodeId: "IC_spoof",
    userId: 99,
    login: "attacker",
  });
  const fake = await startFakeGitHub({ extraComments: [spoof] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.reconciled, false);
    assert.equal(fake.state.postAttempts, 1);
  } finally {
    await fake.close();
  }
});

test("rejects an edited reporter-authored completion", async () => {
  const existing = comment(completionEvent(FIXTURE.passed.body), {
    userId: 42,
    login: "workgraph-reporter",
    updatedAt: "2026-08-14T12:01:00Z",
  });
  const fake = await startFakeGitHub({ extraComments: [existing] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /completion comment was edited/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a conflicting reporter-authored canonical event", async () => {
  const expected = completionEvent(FIXTURE.passed.body);
  const conflict = {
    ...expected,
    payload: {
      executionId: INPUT.executionId,
      outcome: "failed",
      reasonCode: "required-marker-missing",
    },
  };
  const existing = comment(conflict, {
    userId: 42,
    login: "workgraph-reporter",
  });
  const fake = await startFakeGitHub({ extraComments: [existing] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /conflicts with expected event/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a noncanonical reporter-authored completion candidate", async () => {
  const expected = completionEvent(FIXTURE.passed.body);
  const noncanonical = { ...expected, actor: "forbidden" };
  const existing = comment(noncanonical, {
    userId: 42,
    login: "workgraph-reporter",
  });
  const fake = await startFakeGitHub({ extraComments: [existing] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not strict and canonical/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects reporter-authored event type conflict for completion event ID", async () => {
  const expected = completionEvent(FIXTURE.passed.body);
  const conflict = {
    ...expected,
    eventType: "RoutingDecided",
    payload: {
      fromStatus: "AwaitingValidation",
      toStatus: "AwaitingIssueRiskProfiling",
      nextResponsibilityType: "issue-risk-profiling",
    },
  };
  const existing = comment(conflict, {
    userId: 42,
    login: "workgraph-reporter",
    body: eventBody(conflict, "Routing decided."),
  });
  const fake = await startFakeGitHub({ extraComments: [existing] });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /completion event type is invalid/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects ambiguous duplicate reporter-authored completions", async () => {
  const event = completionEvent(FIXTURE.passed.body);
  const fake = await startFakeGitHub({
    extraComments: [
      comment(event, { nodeId: "IC_existing_1", userId: 42 }),
      comment(event, { nodeId: "IC_existing_2", userId: 42 }),
    ],
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /multiple authenticated/);
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("detects a concurrent duplicate after successful comment creation", async () => {
  const fake = await startFakeGitHub({ commentMode: "race" });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /multiple authenticated/);
    assert.equal(fake.state.postAttempts, 1);
  } finally {
    await fake.close();
  }
});

test("reconciles an ambiguous comment create response", async () => {
  const fake = await startFakeGitHub({ commentMode: "ambiguous" });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.reconciled, true);
    assert.equal(result.structuredContent.commentNodeId, "IC_created");
    assert.equal(fake.state.postAttempts, 1);
    assert.ok(
      fake.state.operations.indexOf("comment-ambiguous") <
        fake.state.operations.lastIndexOf("comments"),
    );
  } finally {
    await fake.close();
  }
});

test("reconciles an empty successful comment create response", async () => {
  const fake = await startFakeGitHub({ commentMode: "empty-success" });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.reconciled, true);
    assert.equal(result.structuredContent.commentNodeId, "IC_created");
    assert.equal(fake.state.postAttempts, 1);
  } finally {
    await fake.close();
  }
});

test("rejects launcher correlation changes during ambiguous create", async () => {
  const fake = await startFakeGitHub({
    commentMode: "ambiguous-changed-correlation",
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /correlation changed/);
    assert.equal(fake.state.postAttempts, 1);
  } finally {
    await fake.close();
  }
});

test("rejects launcher correlation changes after successful create", async () => {
  const fake = await startFakeGitHub({
    commentMode: "success-changed-correlation",
  });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /correlation changed/);
    assert.equal(fake.state.postAttempts, 1);
  } finally {
    await fake.close();
  }
});

test("surfaces explicit comment failure without another write", async () => {
  const fake = await startFakeGitHub({ commentMode: "failure" });
  try {
    const result = await callReporter(fake);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /HTTP 422: comment rejected/);
    assert.equal(fake.state.postAttempts, 1);
    assert.equal(
      fake.state.operations.filter(
        (operation) => operation === "comment-failure",
      ).length,
      1,
    );
  } finally {
    await fake.close();
  }
});
