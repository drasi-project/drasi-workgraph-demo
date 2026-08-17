import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  formatTaskResult,
  loadIssueValidationProfile,
  parseIssueValidationProfile,
  resolveIssueValidationProfilePath,
} from "../.github/mcp/workgraph-reporter.mjs";

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
const TASK_NUMBER = 17;
const TASK_NODE_ID = "I_task";
const PARENT_NUMBER = 7;
const PARENT_NODE_ID = "I_parent";
const TASK_TYPE_ID = "IT_workgraph_task";
const REPORTER_USER_ID = 42;
const CREATOR_USER_ID = 84;
const VALIDATION_ASSIGNMENT_ID = `issue-validation:${PARENT_NODE_ID}`;
const RISK_ASSIGNMENT_ID = `issue-risk-profile:${PARENT_NODE_ID}`;
const VALIDATION_PROFILE_NAME = "new-issue-default";
const VALIDATION_CRITERIA = [
  "The Issue has a non-empty title",
  "The Issue body is present",
];

const VALIDATION_ASSIGNMENT = {
  assignmentId: VALIDATION_ASSIGNMENT_ID,
  agentProfile: "issue-validator",
  priority: 10,
  taskType: "issue-validation",
  task: {
    validationProfile: VALIDATION_PROFILE_NAME,
  },
};
const VALIDATION_RESULT = {
  assignmentId: VALIDATION_ASSIGNMENT_ID,
  taskType: "issue-validation",
  outcome: "succeeded",
  summary: "Validated the title and body requirements.",
  result: {
    criteria: [
      {
        criterion: VALIDATION_CRITERIA[0],
        passed: true,
        evidence: "The title contains non-whitespace text.",
      },
      {
        criterion: VALIDATION_CRITERIA[1],
        passed: true,
        evidence: "The body contains non-whitespace text.",
      },
    ],
  },
};
const RISK_ASSIGNMENT = {
  assignmentId: RISK_ASSIGNMENT_ID,
  agentProfile: "issue-risk-profiler",
  priority: 4,
  taskType: "issue-risk-profile",
  task: {
    riskProfile: "delivery",
    dimensions: ["Security impact", "Rollback complexity"],
  },
};
const RISK_RESULT = {
  assignmentId: RISK_ASSIGNMENT_ID,
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
const EXPECTED_VALIDATION_COMMENT = `WorkGraphTaskResult/v1

\`\`\`json
{
  "assignmentId": "issue-validation:I_parent",
  "taskType": "issue-validation",
  "outcome": "succeeded",
  "summary": "Validated the title and body requirements.",
  "result": {
    "criteria": [
      {
        "criterion": "The Issue has a non-empty title",
        "passed": true,
        "evidence": "The title contains non-whitespace text."
      },
      {
        "criterion": "The Issue body is present",
        "passed": true,
        "evidence": "The body contains non-whitespace text."
      }
    ]
  }
}
\`\`\`
`;

function issueReferences() {
  return {
    taskIssueNumber: TASK_NUMBER,
    taskIssueNodeId: TASK_NODE_ID,
    parentIssueNumber: PARENT_NUMBER,
    parentIssueNodeId: PARENT_NODE_ID,
  };
}

function resultInput(
  assignment = VALIDATION_ASSIGNMENT,
  workResult = VALIDATION_RESULT,
) {
  return {
    ...issueReferences(),
    workResult,
    assignment,
  };
}

function submitInput(workResult = VALIDATION_RESULT) {
  return {
    ...issueReferences(),
    workResult,
  };
}

function progressInput(message = "Reviewed the parent Issue fields.") {
  return {
    ...issueReferences(),
    assignmentId: VALIDATION_ASSIGNMENT_ID,
    message,
  };
}

function profileMarkdown(criteriaLines) {
  return (
    "# Test profile\n\n## Guidance\n\nUse current Issue fields.\n\n" +
    `## Criteria\n\n${criteriaLines.join("\n")}\n`
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
  assignment = VALIDATION_ASSIGNMENT,
  taskOverrides = {},
  parentOverrides = {},
  existingComments = [],
  commentMode = "success",
  identityId = REPORTER_USER_ID,
} = {}) {
  const state = {
    comments: [...existingComments],
    operations: [],
    postAttempts: 0,
    requests: [],
  };
  const task = {
    node_id: TASK_NODE_ID,
    number: TASK_NUMBER,
    state: "open",
    title: "WorkGraph task",
    body: `${JSON.stringify(assignment, null, 2)}\n`,
    user: { id: CREATOR_USER_ID, login: "workgraph-core" },
    type: { id: TASK_TYPE_ID, name: "WorkGraphTask" },
    ...taskOverrides,
  };
  const parent = {
    node_id: PARENT_NODE_ID,
    number: PARENT_NUMBER,
    state: "open",
    title: "Example parent",
    body: "Acceptance criteria:\n- [ ] Complete",
    repository_url:
      "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
    ...parentOverrides,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    state.requests.push({ method: request.method, path: url.pathname });
    if (request.headers.authorization !== "Bearer test-token") {
      sendJson(response, 401, { message: "bad token" });
      return;
    }
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
        `/repos/drasi-project/drasi-workgraph-demo/issues/${TASK_NUMBER}`
    ) {
      state.operations.push("task");
      sendJson(response, 200, task);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/issues/${TASK_NUMBER}/parent`)
    ) {
      state.operations.push("parent");
      sendJson(response, 200, parent);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/issues/${TASK_NUMBER}/comments`)
    ) {
      state.operations.push("comments");
      sendJson(response, 200, state.comments);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith(`/issues/${TASK_NUMBER}/comments`)
    ) {
      state.postAttempts += 1;
      const payload = await requestBody(request);
      const comment = {
        node_id: `IC_created_${state.postAttempts}`,
        user: { id: identityId, login: "workgraph-reporter" },
        body: payload.body,
      };
      if (commentMode === "failure") {
        state.operations.push("comment-failure");
        sendJson(response, 422, { message: "comment rejected" });
        return;
      }
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
  config = {},
) {
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKGRAPH_TEST_GITHUB_API_URL: apiUrl,
      WORKGRAPH_TOKEN: "test-token",
      WORKGRAPH_TASK_ISSUE_TYPE_ID:
        config.taskIssueTypeId ?? TASK_TYPE_ID,
      WORKGRAPH_LAUNCHER_USER_ID:
        config.launcherUserId ?? String(CREATOR_USER_ID),
      WORKGRAPH_REPORTER_USER_ID:
        config.reporterUserId ?? String(REPORTER_USER_ID),
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

function protocolMessages(name = "submit_task_result", input = submitInput()) {
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
      params: { name, arguments: input },
    },
  ];
}

async function callReporter(fakeOptions, name, input, config) {
  const fake = await startFakeGitHub(fakeOptions);
  try {
    const responses = await runMcp(
      protocolMessages(name, input),
      fake.apiUrl,
      config,
    );
    return { response: responses[3].result, state: fake.state };
  } finally {
    await fake.close();
  }
}

function assertNoForbiddenMutation(state) {
  for (const request of state.requests) {
    assert.notEqual(request.method, "PATCH");
    assert.notEqual(request.method, "PUT");
    assert.notEqual(request.method, "DELETE");
    assert.equal(
      request.method === "POST" &&
        !request.path.endsWith(`/issues/${TASK_NUMBER}/comments`),
      false,
    );
  }
}

test("exposes only the two narrow task reporter tools", async () => {
  const { response } = await callReporter(
    {},
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.isError, false);

  const fake = await startFakeGitHub();
  try {
    const responses = await runMcp(protocolMessages(), fake.apiUrl);
    assert.equal(
      responses[0].result.serverInfo.name,
      "drasi-workgraph-task-reporter",
    );
    assert.deepEqual(responses[1].result, {});
    const tools = responses[2].result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["report_progress", "submit_task_result"],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    assert.deepEqual(
      Object.keys(tools[0].inputSchema.properties),
      [
        "taskIssueNumber",
        "taskIssueNodeId",
        "parentIssueNumber",
        "parentIssueNodeId",
        "assignmentId",
        "message",
      ],
    );
    assert.deepEqual(
      Object.keys(tools[1].inputSchema.properties),
      [
        "taskIssueNumber",
        "taskIssueNodeId",
        "parentIssueNumber",
        "parentIssueNodeId",
        "workResult",
      ],
    );
    assert.equal(
      tools[0].inputSchema.properties.assignmentId.maxLength,
      256,
    );
    assert.equal(
      tools[0].inputSchema.properties.taskIssueNodeId.maxLength,
      256,
    );
    const serialized = JSON.stringify(tools);
    for (const forbidden of [
      "repository",
      "commentBody",
      "graphql",
      "state_reason",
      "report_result",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await fake.close();
  }
});

test("loads and strictly parses the repository validation profile", () => {
  assert.equal(
    resolveIssueValidationProfilePath(VALIDATION_PROFILE_NAME),
    path.join(
      ROOT,
      ".github",
      "workgraph",
      "profiles",
      "issue-validation",
      `${VALIDATION_PROFILE_NAME}.md`,
    ),
  );
  assert.deepEqual(
    loadIssueValidationProfile(VALIDATION_PROFILE_NAME),
    VALIDATION_CRITERIA,
  );
  assert.deepEqual(
    parseIssueValidationProfile(
      profileMarkdown([
        `1. ${VALIDATION_CRITERIA[0]}`,
        `2. ${VALIDATION_CRITERIA[1]}`,
      ]),
    ),
    VALIDATION_CRITERIA,
  );
  assert.throws(
    () => resolveIssueValidationProfilePath("../profile"),
    /validationProfile must be 1-64 lowercase letters/,
  );
  assert.throws(
    () => parseIssueValidationProfile("# Profile\n"),
    /missing the ## Criteria section/,
  );
});

test("creates exact issue-validation Result bytes on the task only", async () => {
  const { response, state } = await callReporter(
    {},
    "submit_task_result",
    submitInput(),
  );
  assert.deepEqual(response.structuredContent, {
    taskIssueNodeId: TASK_NODE_ID,
    parentIssueNodeId: PARENT_NODE_ID,
    assignmentId: VALIDATION_ASSIGNMENT_ID,
    taskType: "issue-validation",
    commentNodeId: "IC_created_1",
    reconciled: false,
  });
  assert.equal(state.comments[0].body, EXPECTED_VALIDATION_COMMENT);
  assert.equal(state.comments[0].body, formatTaskResult(VALIDATION_RESULT));
  assert.equal(state.comments[0].body.endsWith("```\n"), true);
  assert.equal(state.comments[0].body.includes("<details"), false);
  assert.deepEqual(state.operations, [
    "identity",
    "task",
    "parent",
    "comments",
    "comment",
  ]);
  assertNoForbiddenMutation(state);
});

test("creates exact issue-risk-profile Result bytes", async () => {
  const { response, state } = await callReporter(
    { assignment: RISK_ASSIGNMENT },
    "submit_task_result",
    submitInput(RISK_RESULT),
  );
  assert.equal(response.structuredContent.taskType, "issue-risk-profile");
  assert.equal(state.comments[0].body, formatTaskResult(RISK_RESULT));
  assert.deepEqual(
    JSON.parse(
      state.comments[0].body.match(
        /^WorkGraphTaskResult\/v1\n\n```json\n([\s\S]+)\n```\n$/,
      )[1],
    ).result.dimensions,
    RISK_RESULT.result.dimensions,
  );
  assertNoForbiddenMutation(state);
});

test("posts bounded ordinary progress on the task only", async () => {
  const progress = "Reviewed the parent Issue fields.\nScoring dimensions.";
  const { response, state } = await callReporter(
    {},
    "report_progress",
    progressInput(progress),
  );
  assert.deepEqual(response.structuredContent, {
    taskIssueNodeId: TASK_NODE_ID,
    commentNodeId: "IC_created_1",
  });
  assert.equal(state.comments[0].body, progress);
  assert.deepEqual(state.operations, [
    "identity",
    "task",
    "parent",
    "comment",
  ]);
  assertNoForbiddenMutation(state);
});

test("progress cross-checks its assignment ID after resolving the parent", async () => {
  const { response, state } = await callReporter(
    {},
    "report_progress",
    {
      ...progressInput(),
      assignmentId: "issue-validation:I_other",
    },
  );
  assert.equal(response.isError, true);
  assert.match(
    response.content[0].text,
    /supplied assignmentId must match assignment.assignmentId/,
  );
  assert.deepEqual(state.operations, ["identity", "task", "parent"]);
  assert.equal(state.postAttempts, 0);
});

test("rejects progress control content before GitHub access", async (t) => {
  const cases = [
    ["carriage return", "one\r\ntwo"],
    ["current Result marker", "WorkGraphTaskResult/v1"],
    ["legacy Result marker", "WorkGraphResult/v1"],
    ["legacy Assignment marker", "WorkGraphAssignment/v1"],
    ["fence", "```json\n{}\n```"],
    ["details", "<details>text</details>"],
    ["summary", "<summary>text</summary>"],
    ["oversized", "x".repeat(4097)],
  ];
  for (const [name, progress] of cases) {
    await t.test(name, async () => {
      const { response, state } = await callReporter(
        {},
        "report_progress",
        progressInput(progress),
      );
      assert.equal(response.isError, true);
      assert.deepEqual(state.operations, []);
      assert.equal(state.postAttempts, 0);
    });
  }
});

test("validates all task identity, type, body, and parent boundaries", async (t) => {
  const cases = [
    {
      name: "task is a pull request",
      options: { taskOverrides: { pull_request: { url: "x" } } },
      pattern: /requested non-PR Issue/,
    },
    {
      name: "task number mismatch",
      options: { taskOverrides: { number: 99 } },
      pattern: /requested non-PR Issue/,
    },
    {
      name: "task node mismatch",
      options: { taskOverrides: { node_id: "I_other" } },
      pattern: /requested non-PR Issue/,
    },
    {
      name: "type name mismatch",
      options: { taskOverrides: { type: { id: TASK_TYPE_ID, name: "Task" } } },
      pattern: /exact WorkGraphTask type ID and name/,
    },
    {
      name: "type ID mismatch",
      options: {
        taskOverrides: {
          type: { id: "IT_other", name: "WorkGraphTask" },
        },
      },
      pattern: /exact WorkGraphTask type ID and name/,
    },
    {
      name: "creator mismatch",
      options: {
        taskOverrides: { user: { id: 999, login: "other" } },
      },
      pattern: /LAUNCHER_USER_ID/,
    },
    {
      name: "body is fenced",
      options: {
        taskOverrides: {
          body: `\`\`\`json\n${JSON.stringify(VALIDATION_ASSIGNMENT)}\n\`\`\``,
        },
      },
      pattern: /only raw WorkGraphAssignment JSON/,
    },
    {
      name: "body has prose",
      options: {
        taskOverrides: {
          body: `Assignment:\n${JSON.stringify(VALIDATION_ASSIGNMENT)}`,
        },
      },
      pattern: /not valid WorkGraphAssignment JSON/,
    },
    {
      name: "body has unknown field",
      options: {
        assignment: { ...VALIDATION_ASSIGNMENT, parent: PARENT_NUMBER },
      },
      pattern: /extra=.*parent/,
    },
    {
      name: "profile mapping mismatch",
      options: {
        assignment: {
          ...VALIDATION_ASSIGNMENT,
          agentProfile: "issue-risk-profiler",
        },
      },
      pattern: /agentProfile does not match/,
    },
    {
      name: "assignment not bound to parent",
      options: {
        assignment: {
          ...VALIDATION_ASSIGNMENT,
          assignmentId: "I_wrong_parent",
        },
      },
      pattern: /must equal taskType:authoritativeParentNodeId/,
    },
    {
      name: "parent is a pull request",
      options: { parentOverrides: { pull_request: { url: "x" } } },
      pattern: /requested non-PR parent Issue/,
    },
    {
      name: "parent number mismatch",
      options: { parentOverrides: { number: 88 } },
      pattern: /requested non-PR parent Issue/,
    },
    {
      name: "parent node mismatch",
      options: { parentOverrides: { node_id: "I_other" } },
      pattern: /requested non-PR parent Issue/,
    },
    {
      name: "parent repository mismatch",
      options: {
        parentOverrides: {
          repository_url: "https://api.github.com/repos/other/repository",
        },
      },
      pattern: /not in the fixed repository/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { response, state } = await callReporter(
        item.options,
        "submit_task_result",
        submitInput(),
      );
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, item.pattern);
      assert.equal(state.postAttempts, 0);
      assertNoForbiddenMutation(state);
    });
  }
});

test("validates reporter configuration and identity", async (t) => {
  const cases = [
    {
      name: "wrong configured type ID",
      config: { taskIssueTypeId: "IT_wrong" },
      pattern: /exact WorkGraphTask type ID and name/,
    },
    {
      name: "wrong configured creator ID",
      config: { launcherUserId: "999" },
      pattern: /LAUNCHER_USER_ID/,
    },
    {
      name: "wrong configured reporter ID",
      config: { reporterUserId: "999" },
      pattern: /REPORTER_USER_ID/,
    },
    {
      name: "non-positive launcher ID",
      config: { launcherUserId: "0" },
      pattern: /LAUNCHER_USER_ID must be a positive integer/,
    },
    {
      name: "empty Issue Type ID",
      config: { taskIssueTypeId: "" },
      pattern: /TASK_ISSUE_TYPE_ID/,
    },
    {
      name: "wrong authenticated reporter",
      options: { identityId: 999 },
      pattern: /REPORTER_USER_ID/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { response, state } = await callReporter(
        item.options ?? {},
        "submit_task_result",
        submitInput(),
        item.config,
      );
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, item.pattern);
      assert.equal(state.postAttempts, 0);
      assertNoForbiddenMutation(state);
    });
  }
});

test("rejects malformed and unreconciled typed Results", async (t) => {
  const cases = [
    {
      name: "assignment ID mismatch",
      result: { ...VALIDATION_RESULT, assignmentId: "I_other" },
      pattern: /must match assignment.assignmentId/,
    },
    {
      name: "task type mismatch",
      result: {
        ...RISK_RESULT,
        assignmentId: VALIDATION_ASSIGNMENT_ID,
      },
      pattern: /must match assignment.taskType/,
    },
    {
      name: "profile criterion mismatch",
      result: {
        ...VALIDATION_RESULT,
        result: {
          criteria: [
            {
              ...VALIDATION_RESULT.result.criteria[0],
              criterion: "Different criterion",
            },
            VALIDATION_RESULT.result.criteria[1],
          ],
        },
      },
      pattern: /must exactly match the validation profile/,
    },
    {
      name: "dimension order mismatch",
      assignment: RISK_ASSIGNMENT,
      result: {
        ...RISK_RESULT,
        result: {
          dimensions: [...RISK_RESULT.result.dimensions].reverse(),
        },
      },
      pattern: /must exactly match the Assignment dimensions/,
    },
    {
      name: "summary has marker",
      result: {
        ...VALIDATION_RESULT,
        summary: "Includes WorkGraphTaskResult/v1",
      },
      pattern: /structured markers/,
    },
    {
      name: "invalid risk score",
      assignment: RISK_ASSIGNMENT,
      result: {
        ...RISK_RESULT,
        result: {
          dimensions: [
            { ...RISK_RESULT.result.dimensions[0], score: 101 },
            RISK_RESULT.result.dimensions[1],
          ],
        },
      },
      pattern: /integer between 0 and 100/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { response, state } = await callReporter(
        { assignment: item.assignment ?? VALIDATION_ASSIGNMENT },
        "submit_task_result",
        submitInput(item.result),
      );
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, item.pattern);
      assert.equal(state.postAttempts, 0);
      assertNoForbiddenMutation(state);
    });
  }
});

test("ignores ordinary task progress and adopts one exact authenticated Result", async () => {
  const existing = {
    node_id: "IC_result",
    user: { id: REPORTER_USER_ID, login: "workgraph-reporter" },
    body: formatTaskResult(VALIDATION_RESULT),
  };
  const { response, state } = await callReporter(
    {
      taskOverrides: { state: "closed" },
      existingComments: [
        {
          node_id: "IC_progress",
          user: { id: REPORTER_USER_ID, login: "workgraph-reporter" },
          body: "Reviewed the parent fields.",
        },
        existing,
      ],
    },
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.structuredContent.reconciled, true);
  assert.equal(response.structuredContent.commentNodeId, "IC_result");
  assert.equal(state.postAttempts, 0);
  assertNoForbiddenMutation(state);
});

test("rejects malformed, conflicting, foreign, and multiple candidates", async (t) => {
  const canonical = formatTaskResult(VALIDATION_RESULT);
  const conflicting = formatTaskResult({
    ...VALIDATION_RESULT,
    summary: "A different valid result.",
  });
  const cases = [
    {
      name: "legacy marker",
      comments: [{
        node_id: "IC_legacy",
        user: { id: REPORTER_USER_ID },
        body: "WorkGraphResult/v1\n",
      }],
      pattern: /malformed structured Result/,
    },
    {
      name: "malformed current marker",
      comments: [{
        node_id: "IC_malformed",
        user: { id: REPORTER_USER_ID },
        body: canonical.slice(0, -1),
      }],
      pattern: /malformed structured Result/,
    },
    {
      name: "Result-shaped fence without marker",
      comments: [{
        node_id: "IC_unmarked",
        user: { id: REPORTER_USER_ID },
        body: canonical.replace("WorkGraphTaskResult/v1\n\n", ""),
      }],
      pattern: /malformed structured Result/,
    },
    {
      name: "Result-shaped uppercase fence without marker",
      comments: [{
        node_id: "IC_unmarked_uppercase",
        user: { id: REPORTER_USER_ID },
        body: canonical
          .replace("WorkGraphTaskResult/v1\n\n", "")
          .replace("```json", "```JSON"),
      }],
      pattern: /malformed structured Result/,
    },
    {
      name: "conflicting authenticated result",
      comments: [{
        node_id: "IC_conflict",
        user: { id: REPORTER_USER_ID },
        body: conflicting,
      }],
      pattern: /conflicts with the requested result/,
    },
    {
      name: "foreign canonical result",
      comments: [{
        node_id: "IC_foreign",
        user: { id: 999 },
        body: canonical,
      }],
      pattern: /different author/,
    },
    {
      name: "multiple candidates",
      comments: [
        {
          node_id: "IC_one",
          user: { id: REPORTER_USER_ID },
          body: canonical,
        },
        {
          node_id: "IC_two",
          user: { id: REPORTER_USER_ID },
          body: canonical,
        },
      ],
      pattern: /multiple structured Result/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { response, state } = await callReporter(
        { existingComments: item.comments },
        "submit_task_result",
        submitInput(),
      );
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, item.pattern);
      assert.equal(state.postAttempts, 0);
      assertNoForbiddenMutation(state);
    });
  }
});

test("rejects a closed task without an exact Result", async () => {
  const { response, state } = await callReporter(
    { taskOverrides: { state: "closed" } },
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /closed task Issue has no/);
  assert.equal(state.postAttempts, 0);
  assertNoForbiddenMutation(state);
});

test("reconciles an ambiguous Result create with one re-list and no second POST", async () => {
  const { response, state } = await callReporter(
    { commentMode: "ambiguous" },
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.structuredContent.reconciled, true);
  assert.equal(state.postAttempts, 1);
  assert.deepEqual(state.operations, [
    "identity",
    "task",
    "parent",
    "comments",
    "comment-ambiguous",
    "comments",
  ]);
  assertNoForbiddenMutation(state);
});

test("reconciles an unreadable successful response without a second POST", async () => {
  const { response, state } = await callReporter(
    { commentMode: "malformed-response" },
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.structuredContent.reconciled, true);
  assert.equal(state.postAttempts, 1);
  assert.equal(
    state.operations.filter((operation) => operation === "comments").length,
    2,
  );
  assertNoForbiddenMutation(state);
});

test("does not retry an explicit Result POST failure", async () => {
  const { response, state } = await callReporter(
    { commentMode: "failure" },
    "submit_task_result",
    submitInput(),
  );
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /HTTP 422: comment rejected/);
  assert.equal(state.postAttempts, 1);
  assert.equal(
    state.operations.filter((operation) => operation === "comments").length,
    1,
  );
  assertNoForbiddenMutation(state);
});

test("rejects obsolete report_result and additional input before GitHub access", async () => {
  const fake = await startFakeGitHub();
  try {
    const obsolete = await runMcp(
      protocolMessages("report_result", submitInput()),
      fake.apiUrl,
    );
    assert.equal(obsolete[3].result.isError, true);
    assert.match(obsolete[3].result.content[0].text, /unknown tool/);
    const extra = await runMcp(
      protocolMessages("submit_task_result", {
        ...submitInput(),
        repository: "other/repository",
      }),
      fake.apiUrl,
    );
    assert.equal(extra[3].result.isError, true);
    assert.match(extra[3].result.content[0].text, /extra=.*repository/);
    assert.deepEqual(fake.state.operations, []);
  } finally {
    await fake.close();
  }
});
