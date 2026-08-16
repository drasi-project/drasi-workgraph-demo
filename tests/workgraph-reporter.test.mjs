import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
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
const ISSUE_NUMBER = 7;

const VALIDATION_ASSIGNMENT = {
  assignmentId: "assignment-validation-001",
  agentProfile: "issue-validator",
  priority: 10,
  taskType: "issue-validation",
  task: {
    validationProfile: "default",
    criteria: [
      "The issue defines acceptance criteria",
      "The issue identifies an owner",
    ],
  },
};

const VALIDATION_RESULT = {
  assignmentId: "assignment-validation-001",
  taskType: "issue-validation",
  outcome: "succeeded",
  summary: "Evaluated both requested validation criteria.",
  result: {
    criteria: [
      {
        criterion: "The issue defines acceptance criteria",
        passed: true,
        evidence: "The body contains an acceptance checklist.",
      },
      {
        criterion: "The issue identifies an owner",
        passed: false,
        evidence: "The title and body do not identify an owner.",
      },
    ],
  },
};

const EXPECTED_VALIDATION_COMMENT = `<details>
<summary>WorkGraph Result</summary>

WorkGraphResult/v1

Evaluated both requested validation criteria.

\`\`\`json
{
  "assignmentId": "assignment-validation-001",
  "taskType": "issue-validation",
  "outcome": "succeeded",
  "summary": "Evaluated both requested validation criteria.",
  "result": {
    "criteria": [
      {
        "criterion": "The issue defines acceptance criteria",
        "passed": true,
        "evidence": "The body contains an acceptance checklist."
      },
      {
        "criterion": "The issue identifies an owner",
        "passed": false,
        "evidence": "The title and body do not identify an owner."
      }
    ]
  }
}
\`\`\`
</details>
`;

const RISK_ASSIGNMENT = {
  assignmentId: "assignment-risk-001",
  agentProfile: "issue-risk-profiler",
  priority: 4,
  taskType: "issue-risk-profile",
  task: {
    riskProfile: "delivery",
    dimensions: ["Security impact", "Rollback complexity"],
  },
};

const RISK_RESULT = {
  assignmentId: "assignment-risk-001",
  taskType: "issue-risk-profile",
  outcome: "succeeded",
  summary: "Scored both requested risk dimensions.",
  result: {
    dimensions: [
      {
        dimension: "Security impact",
        score: 75,
        rationale: "The change affects authorization checks.",
      },
      {
        dimension: "Rollback complexity",
        score: 25,
        rationale: "The issue describes a feature-flag rollback.",
      },
    ],
  },
};

function inputFor(assignment, workResult) {
  return {
    issueNumber: ISSUE_NUMBER,
    assignment,
    workResult,
  };
}

function resultComment(workResult) {
  return (
    `<details>\n<summary>WorkGraph Result</summary>\n\n` +
    `WorkGraphResult/v1\n\n${workResult.summary}\n\n` +
    `\`\`\`json\n${JSON.stringify(workResult, null, 2)}\n\`\`\`\n` +
    `</details>\n`
  );
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body.length > 0 ? JSON.parse(body) : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startFakeGitHub({
  existingComments = [],
  commentMode = "success",
  identityId = 42,
  issueIsPullRequest = false,
} = {}) {
  const state = {
    comments: [...existingComments],
    operations: [],
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
      sendJson(response, 200, {
        id: identityId,
        login: "workgraph-reporter",
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname ===
        `/repos/drasi-project/drasi-workgraph-demo/issues/${ISSUE_NUMBER}`
    ) {
      state.operations.push("issue");
      sendJson(response, 200, {
        node_id: "I_example",
        number: ISSUE_NUMBER,
        title: "Example issue",
        body: "Acceptance criteria:\n- [ ] Complete",
        ...(issueIsPullRequest
          ? { pull_request: { url: "https://example.test/pull/7" } }
          : {}),
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/issues/${ISSUE_NUMBER}/comments`)
    ) {
      state.operations.push("comments");
      sendJson(response, 200, state.comments);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith(`/issues/${ISSUE_NUMBER}/comments`)
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
        user: { id: identityId, login: "workgraph-reporter" },
        body: payload.body,
      };
      state.comments.push(comment);
      if (commentMode === "ambiguous") {
        state.operations.push("comment-ambiguous");
        request.socket.destroy();
        return;
      }
      if (commentMode === "malformed-response") {
        state.operations.push("comment-malformed-response");
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end("not-json");
        return;
      }
      state.operations.push("comment");
      sendJson(response, 201, comment);
      return;
    }
    sendJson(response, 404, { message: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    state,
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

async function runMcp(
  messages,
  apiUrl,
  { reporterUserId = "42" } = {},
) {
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKGRAPH_TEST_GITHUB_API_URL: apiUrl,
      WORKGRAPH_TOKEN: "test-token",
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

function protocolMessages(
  input = inputFor(VALIDATION_ASSIGNMENT, VALIDATION_RESULT),
) {
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
      params: { name: "report_result", arguments: input },
    },
  ];
}

async function runCall(options = {}) {
  const fake = await startFakeGitHub(options);
  try {
    const responses = await runMcp(
      protocolMessages(options.input),
      fake.apiUrl,
      options.config,
    );
    return { fake, responses };
  } catch (error) {
    await fake.close();
    throw error;
  }
}

test("exposes one strict typed report_result tool", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(
      responses[0].result.serverInfo.name,
      "drasi-workgraph-result-reporter",
    );
    assert.deepEqual(responses[1].result, {});
    const tools = responses[2].result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["report_result"]);
    const schema = tools[0].inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "assignment",
      "issueNumber",
      "workResult",
    ]);
    assert.equal(schema.properties.assignment.oneOf.length, 2);
    assert.equal(schema.properties.workResult.oneOf.length, 2);
    const serialized = JSON.stringify(schema);
    for (const forbidden of [
      "repository",
      "commentBody",
      "graphql",
      "projectItemNodeId",
      "routeId",
      "executionId",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await fake.close();
  }
});

test("creates one canonical issue-validation Result", async () => {
  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.deepEqual(result, {
      assignmentId: VALIDATION_ASSIGNMENT.assignmentId,
      taskType: "issue-validation",
      commentNodeId: "IC_created",
      reconciled: false,
    });
    assert.deepEqual(fake.state.operations, [
      "identity",
      "issue",
      "comments",
      "comment",
    ]);
    assert.equal(fake.state.postAttempts, 1);
    const body = fake.state.comments[0].body;
    assert.equal(body, EXPECTED_VALIDATION_COMMENT);
    assert.equal((body.match(/^```/gm) ?? []).length, 2);
    const lines = body.split("\n");
    assert.deepEqual(lines.slice(0, 7), [
      "<details>",
      "<summary>WorkGraph Result</summary>",
      "",
      "WorkGraphResult/v1",
      "",
      VALIDATION_RESULT.summary,
      "",
    ]);
    assert.equal(lines.at(-3), "```");
    assert.equal(lines.at(-2), "</details>");
    assert.equal(lines.at(-1), "");
    assert.equal(body.includes("<details open>"), false);
    assert.equal(body.includes("<details open=\"open\">"), false);
    assert.equal(body.includes(`Issue #${ISSUE_NUMBER}`), false);
    const payload = JSON.parse(
      body.match(/```json\n([\s\S]+)\n```\n<\/details>\n$/)[1],
    );
    assert.deepEqual(payload, VALIDATION_RESULT);
    assert.deepEqual(Object.keys(payload).sort(), [
      "assignmentId",
      "outcome",
      "result",
      "summary",
      "taskType",
    ]);
  } finally {
    await fake.close();
  }
});

test("creates one canonical issue-risk-profile Result", async () => {
  const fake = await startFakeGitHub();
  try {
    const input = inputFor(RISK_ASSIGNMENT, RISK_RESULT);
    const responses = await runMcp(protocolMessages(input), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.equal(result.taskType, "issue-risk-profile");
    assert.equal(result.reconciled, false);
    assert.equal(fake.state.postAttempts, 1);
    assert.equal(fake.state.comments[0].body, resultComment(RISK_RESULT));
    const payload = JSON.parse(
      fake.state.comments[0].body.match(
        /```json\n([\s\S]+)\n```\n<\/details>\n$/,
      )[1],
    );
    assert.deepEqual(payload.result.dimensions, RISK_RESULT.result.dimensions);
    assert.equal(payload.result.dimensions[0].score, 75);
  } finally {
    await fake.close();
  }
});

test("rejects additional input before GitHub access", async () => {
  const fake = await startFakeGitHub();
  try {
    const input = {
      ...inputFor(VALIDATION_ASSIGNMENT, VALIDATION_RESULT),
      repository: "other/repository",
    };
    const responses = await runMcp(protocolMessages(input), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(responses[3].result.content[0].text, /extra=.*repository/);
    assert.deepEqual(fake.state.operations, []);
  } finally {
    await fake.close();
  }
});

test("rejects malformed typed Assignments before GitHub access", async (t) => {
  const cases = [
    {
      name: "empty agent profile",
      assignment: {
        ...VALIDATION_ASSIGNMENT,
        agentProfile: " ",
      },
      pattern: /agentProfile must be a non-empty string/,
    },
    {
      name: "empty validation profile",
      assignment: {
        ...VALIDATION_ASSIGNMENT,
        task: {
          ...VALIDATION_ASSIGNMENT.task,
          validationProfile: " ",
        },
      },
      pattern: /validationProfile must be a non-empty string/,
    },
    {
      name: "extra task field",
      assignment: {
        ...RISK_ASSIGNMENT,
        task: { ...RISK_ASSIGNMENT.task, route: "legacy" },
      },
      pattern: /extra=.*route/,
      workResult: RISK_RESULT,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = await startFakeGitHub();
      try {
        const responses = await runMcp(
          protocolMessages(
            inputFor(
              item.assignment,
              item.workResult ?? VALIDATION_RESULT,
            ),
          ),
          fake.apiUrl,
        );
        assert.equal(responses[3].result.isError, true);
        assert.match(responses[3].result.content[0].text, item.pattern);
        assert.deepEqual(fake.state.operations, []);
      } finally {
        await fake.close();
      }
    });
  }
});

test("rejects malformed typed Results before GitHub access", async (t) => {
  const cases = [
    {
      name: "empty evidence",
      assignment: VALIDATION_ASSIGNMENT,
      workResult: {
        ...VALIDATION_RESULT,
        result: {
          criteria: [
            {
              ...VALIDATION_RESULT.result.criteria[0],
              evidence: "",
            },
            VALIDATION_RESULT.result.criteria[1],
          ],
        },
      },
      pattern: /evidence must be a non-empty string/,
    },
    {
      name: "non-integer score",
      assignment: RISK_ASSIGNMENT,
      workResult: {
        ...RISK_RESULT,
        result: {
          dimensions: [
            { ...RISK_RESULT.result.dimensions[0], score: 50.5 },
            RISK_RESULT.result.dimensions[1],
          ],
        },
      },
      pattern: /score must be an integer between 0 and 100/,
    },
    {
      name: "score above 100",
      assignment: RISK_ASSIGNMENT,
      workResult: {
        ...RISK_RESULT,
        result: {
          dimensions: [
            { ...RISK_RESULT.result.dimensions[0], score: 101 },
            RISK_RESULT.result.dimensions[1],
          ],
        },
      },
      pattern: /score must be an integer between 0 and 100/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = await startFakeGitHub();
      try {
        const responses = await runMcp(
          protocolMessages(inputFor(item.assignment, item.workResult)),
          fake.apiUrl,
        );
        assert.equal(responses[3].result.isError, true);
        assert.match(responses[3].result.content[0].text, item.pattern);
        assert.deepEqual(fake.state.operations, []);
      } finally {
        await fake.close();
      }
    });
  }
});

test("requires Result items to match the Assignment in order", async () => {
  const fake = await startFakeGitHub();
  try {
    const workResult = {
      ...VALIDATION_RESULT,
      result: {
        criteria: [...VALIDATION_RESULT.result.criteria].reverse(),
      },
    };
    const responses = await runMcp(
      protocolMessages(inputFor(VALIDATION_ASSIGNMENT, workResult)),
      fake.apiUrl,
    );
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /criteria must exactly match the assigned criteria in order/,
    );
    assert.deepEqual(fake.state.operations, []);
  } finally {
    await fake.close();
  }
});

test("reconciles one authenticated canonical Result", async () => {
  const existing = {
    node_id: "IC_existing",
    user: { id: 42, login: "workgraph-reporter" },
    body: resultComment(VALIDATION_RESULT),
  };
  const fake = await startFakeGitHub({ existingComments: [existing] });
  try {
    const reorderedResult = {
      result: {
        criteria: VALIDATION_RESULT.result.criteria.map((entry) => ({
          evidence: entry.evidence,
          passed: entry.passed,
          criterion: entry.criterion,
        })),
      },
      summary: VALIDATION_RESULT.summary,
      outcome: VALIDATION_RESULT.outcome,
      taskType: VALIDATION_RESULT.taskType,
      assignmentId: VALIDATION_RESULT.assignmentId,
    };
    const responses = await runMcp(
      protocolMessages(
        inputFor(VALIDATION_ASSIGNMENT, reorderedResult),
      ),
      fake.apiUrl,
    );
    assert.deepEqual(responses[3].result.structuredContent, {
      assignmentId: VALIDATION_ASSIGNMENT.assignmentId,
      taskType: "issue-validation",
      commentNodeId: "IC_existing",
      reconciled: true,
    });
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects malformed Result envelopes instead of duplicating", async (t) => {
  const canonical = resultComment(VALIDATION_RESULT);
  const unwrapped =
    `WorkGraphResult/v1\n${VALIDATION_RESULT.summary}\n` +
    `\`\`\`json\n${JSON.stringify(VALIDATION_RESULT, null, 2)}\n\`\`\``;
  const cases = [
    {
      name: "unwrapped",
      body: unwrapped,
    },
    {
      name: "open details",
      body: canonical.replace("<details>", "<details open>"),
    },
    {
      name: "details attributes",
      body: canonical.replace("<details>", '<details data-kind="result">'),
    },
    {
      name: "mismatched summary label",
      body: canonical.replace(
        "<summary>WorkGraph Result</summary>",
        "<summary>Result</summary>",
      ),
    },
    {
      name: "missing summary blank line",
      body: canonical.replace(
        "<summary>WorkGraph Result</summary>\n\n",
        "<summary>WorkGraph Result</summary>\n",
      ),
    },
    {
      name: "missing marker blank line",
      body: canonical.replace(
        "WorkGraphResult/v1\n\n",
        "WorkGraphResult/v1\n",
      ),
    },
    {
      name: "missing human summary blank line",
      body: canonical.replace(
        `${VALIDATION_RESULT.summary}\n\n\`\`\`json`,
        `${VALIDATION_RESULT.summary}\n\`\`\`json`,
      ),
    },
    {
      name: "mismatched JSON fence",
      body: canonical.replace("```json", "```JSON"),
    },
    {
      name: "multiple JSON fences",
      body: canonical.replace(
        "\n```\n</details>",
        "\n```\n```\n</details>",
      ),
    },
    {
      name: "unclosed details",
      body: canonical.replace("\n</details>", ""),
    },
    {
      name: "missing final LF",
      body: canonical.slice(0, -1),
    },
    {
      name: "extra final LF",
      body: `${canonical}\n`,
    },
    {
      name: "prose after details",
      body: `${canonical}Unexpected trailing prose.\n`,
    },
    {
      name: "literal backslash-n separators",
      body: canonical.replaceAll("\n", "\\n"),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = await startFakeGitHub({
        existingComments: [
          {
            node_id: "IC_malformed",
            user: { id: 42, login: "workgraph-reporter" },
            body: item.body,
          },
        ],
      });
      try {
        const responses = await runMcp(protocolMessages(), fake.apiUrl);
        assert.equal(responses[3].result.isError, true);
        assert.match(
          responses[3].result.content[0].text,
          /malformed Result comment envelope/,
        );
        assert.equal(fake.state.postAttempts, 0);
      } finally {
        await fake.close();
      }
    });
  }
});

test("rejects byte-noncanonical bodies instead of duplicating", async (t) => {
  const compact = resultComment(VALIDATION_RESULT).replace(
    JSON.stringify(VALIDATION_RESULT, null, 2),
    JSON.stringify(VALIDATION_RESULT),
  );
  const cases = [
    { name: "compact JSON", body: compact },
    {
      name: "CRLF bytes",
      body: resultComment(VALIDATION_RESULT).replaceAll("\n", "\r\n"),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fake = await startFakeGitHub({
        existingComments: [
          {
            node_id: "IC_noncanonical",
            user: { id: 42, login: "workgraph-reporter" },
            body: item.body,
          },
        ],
      });
      try {
        const responses = await runMcp(protocolMessages(), fake.apiUrl);
        assert.equal(responses[3].result.isError, true);
        assert.match(
          responses[3].result.content[0].text,
          /authenticated Result comment.*conflicts/,
        );
        assert.equal(fake.state.postAttempts, 0);
      } finally {
        await fake.close();
      }
    });
  }
});

test("rejects a malformed existing Result payload", async () => {
  const malformed = {
    ...VALIDATION_RESULT,
    unexpected: true,
  };
  const fake = await startFakeGitHub({
    existingComments: [
      {
        node_id: "IC_malformed_payload",
        user: { id: 42, login: "workgraph-reporter" },
        body: resultComment(malformed),
      },
    ],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /malformed Result payload/,
    );
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects a human summary that mismatches the Result payload", async () => {
  const fake = await startFakeGitHub({
    existingComments: [
      {
        node_id: "IC_mismatched_summary",
        user: { id: 42, login: "workgraph-reporter" },
        body: resultComment(VALIDATION_RESULT).replace(
          VALIDATION_RESULT.summary,
          "A different human summary.",
        ),
      },
    ],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /authenticated Result comment.*conflicts/,
    );
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("fails instead of duplicating a conflicting authenticated Result", async () => {
  const conflicting = {
    ...VALIDATION_RESULT,
    summary: "A different valid result.",
  };
  const fake = await startFakeGitHub({
    existingComments: [
      {
        node_id: "IC_conflict",
        user: { id: 42, login: "workgraph-reporter" },
        body: resultComment(conflicting),
      },
    ],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /authenticated Result comment.*conflicts/,
    );
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("fails instead of duplicating another author's valid Result", async () => {
  const fake = await startFakeGitHub({
    existingComments: [
      {
        node_id: "IC_other",
        user: { id: 99, login: "other" },
        body: resultComment(VALIDATION_RESULT),
      },
    ],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /exists from a different author/,
    );
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("rejects multiple valid Results for one assignmentId", async () => {
  const body = resultComment(VALIDATION_RESULT);
  const fake = await startFakeGitHub({
    existingComments: [
      {
        node_id: "IC_one",
        user: { id: 42, login: "workgraph-reporter" },
        body,
      },
      {
        node_id: "IC_two",
        user: { id: 42, login: "workgraph-reporter" },
        body,
      },
    ],
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /multiple schema-valid Result comments/,
    );
    assert.equal(fake.state.postAttempts, 0);
  } finally {
    await fake.close();
  }
});

test("reconciles an ambiguous create without a second POST", async () => {
  const fake = await startFakeGitHub({ commentMode: "ambiguous" });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.equal(result.reconciled, true);
    assert.equal(result.commentNodeId, "IC_created");
    assert.equal(fake.state.postAttempts, 1);
    assert.deepEqual(fake.state.operations, [
      "identity",
      "issue",
      "comments",
      "comment-ambiguous",
      "comments",
    ]);
  } finally {
    await fake.close();
  }
});

test("reconciles a malformed successful create response", async () => {
  const fake = await startFakeGitHub({
    commentMode: "malformed-response",
  });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    const result = responses[3].result.structuredContent;
    assert.equal(result.reconciled, true);
    assert.equal(result.commentNodeId, "IC_created");
    assert.equal(fake.state.postAttempts, 1);
    assert.deepEqual(fake.state.operations, [
      "identity",
      "issue",
      "comments",
      "comment-malformed-response",
      "comments",
    ]);
  } finally {
    await fake.close();
  }
});

test("does not retry an explicit comment rejection", async () => {
  const fake = await startFakeGitHub({ commentMode: "failure" });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /HTTP 422: comment rejected/,
    );
    assert.equal(fake.state.postAttempts, 1);
    assert.equal(
      fake.state.operations.filter((entry) => entry === "comments").length,
      1,
    );
  } finally {
    await fake.close();
  }
});

test("rejects a token identity mismatch before Issue access", async () => {
  const fake = await startFakeGitHub({ identityId: 42 });
  try {
    const responses = await runMcp(
      protocolMessages(),
      fake.apiUrl,
      { reporterUserId: "99" },
    );
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /does not match WORKGRAPH_REPORTER_USER_ID 99/,
    );
    assert.deepEqual(fake.state.operations, ["identity"]);
  } finally {
    await fake.close();
  }
});

test("rejects a pull request destination before comment access", async () => {
  const fake = await startFakeGitHub({ issueIsPullRequest: true });
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(responses[3].result.isError, true);
    assert.match(
      responses[3].result.content[0].text,
      /destination is not the requested Issue/,
    );
    assert.deepEqual(fake.state.operations, ["identity", "issue"]);
  } finally {
    await fake.close();
  }
});
