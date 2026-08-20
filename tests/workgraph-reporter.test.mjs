import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatAcceptance,
  formatAssignment as formatV2Assignment,
  formatHistoricalAssignment,
  formatHistoricalTaskResult,
  formatLease,
  formatLeaseExpiration,
  parseWorkersYaml,
  selectWorker,
  formatTask,
  formatTaskResult as formatV2TaskResult,
  parseTask,
  resultDigest,
} from "../.github/mcp/workgraph-reporter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTER = path.join(ROOT, ".github/mcp/workgraph-reporter.mjs");
const TYPE_ID = "IT_kwDOCX0YF84CKGIJ";
const IDS = {
  launcher: 10,
  assignment: 11,
  result: 12,
  acceptance: 13,
  orchestrator: 14,
  info: 15,
  redispatch: 16,
  dispatcher: 17,
  leaseReporter: 18,
  submitter: 20,
  human: 21,
};
const PARENT_NUMBER = 7;
const PARENT_NODE = "I_parent";
const TASK_NUMBER = 17;
const TASK_NODE = "I_task";
const CRITERIA = [
  "The Issue has a non-empty title",
  "The Issue body is present",
];
const WORKERS_YAML =
  "version: 1\nworkers:\n" +
  "  - workerId: issue-validation-01\n" +
  "    agentProfile: issue-validator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n" +
  "  - workerId: issue-information-01\n" +
  "    agentProfile: issue-info-requester\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n";
const ACTIVE_LEASE = {
  leaseId: "lease-001",
  assignmentCommentNodeId: "IC_assignment",
  workerId: "issue-validation-01",
  slotId: "issue-validation-01/1",
  acquiredAt: "2026-08-18T23:30:00Z",
  expiresAt: "2026-08-19T00:30:00Z",
};
const INFO_LEASE = {
  leaseId: "lease-info-001",
  assignmentCommentNodeId: "IC_assignment_request",
  workerId: "issue-information-01",
  slotId: "issue-information-01/1",
  acquiredAt: "2026-08-18T23:30:00Z",
  expiresAt: "2026-08-19T00:30:00Z",
};
const PASS_RESULT = {
  taskType: "validate-issue",
  outcome: "succeeded",
  summary: "Both required fields are present.",
  result: {
    criteria: [
      { criterion: CRITERIA[0], passed: true, evidence: "Title is non-empty." },
      { criterion: CRITERIA[1], passed: true, evidence: "Body is non-empty." },
    ],
  },
};
const FAIL_RESULT = {
  ...PASS_RESULT,
  summary: "The issue body is missing.",
  result: {
    criteria: [
      PASS_RESULT.result.criteria[0],
      { criterion: CRITERIA[1], passed: false, evidence: "Body is empty." },
    ],
  },
};

function formatAssignment(profile, workerId) {
  return workerId
    ? formatV2Assignment(profile, workerId)
    : formatHistoricalAssignment(profile);
}

function formatTaskResult(result) {
  return result.leaseId
    ? formatV2TaskResult(result)
    : formatHistoricalTaskResult(result);
}

function leasedResult(result, leaseId = ACTIVE_LEASE.leaseId) {
  return {
    taskType: result.taskType,
    leaseId,
    outcome: result.outcome,
    summary: result.summary,
    result: structuredClone(result.result),
  };
}

function compatibleWorkers(profile = "issue-validator") {
  return [
    {
      workerId:
        profile === "issue-validator"
          ? "issue-validation-01"
          : "issue-information-01",
      agentProfile: profile,
      queueDepth: 0,
    },
  ];
}

function activeLeaseInput(
  lease = ACTIVE_LEASE,
  leaseCommentNodeId = "IC_lease",
) {
  return {
    assignmentCommentNodeId: lease.assignmentCommentNodeId,
    leaseCommentNodeId,
    ...lease,
  };
}

function taskPayload(taskType = "validate-issue", resultNode = "IC_validation") {
  return taskType === "validate-issue"
    ? {
        taskType,
        inputs: { validationProfile: "new-issue-default" },
      }
    : {
        taskType,
        inputs: { validationResultCommentNodeId: resultNode },
      };
}

function makeTask({
  number = TASK_NUMBER,
  nodeId = TASK_NODE,
  id = 117,
  taskType = "validate-issue",
  resultNode,
  state = "open",
  authorId = IDS.launcher,
} = {}) {
  const payload = taskPayload(taskType, resultNode);
  return {
    id,
    number,
    node_id: nodeId,
    state,
    title: `WorkGraph: ${taskType}`,
    body: formatTask(payload),
    user: { id: authorId, login: "launcher", type: "Bot" },
    type: { name: "WorkGraphTask", node_id: TYPE_ID },
    repository_url:
      "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
  };
}

function makeComment(
  body,
  authorId,
  nodeId,
  id,
  createdAt = "2026-08-18T22:00:00Z",
  updatedAt = createdAt,
) {
  return {
    id,
    node_id: nodeId,
    body,
    created_at: createdAt,
    updated_at: updatedAt,
    user: {
      id: authorId,
      login: authorId === IDS.submitter ? "submitter" : `actor-${authorId}`,
      type: authorId === IDS.human || authorId === IDS.submitter ? "User" : "Bot",
    },
  };
}

function assignmentComment(profile = "issue-validator", author = IDS.assignment) {
  return makeComment(formatAssignment(profile), author, "IC_assignment", 201);
}

function assignmentV2Comment(
  profile = "issue-validator",
  workerId = "issue-validation-01",
  nodeId = "IC_assignment",
) {
  return makeComment(
    formatAssignment(profile, workerId),
    IDS.assignment,
    nodeId,
    201,
  );
}

function leaseComment(lease = ACTIVE_LEASE, nodeId = "IC_lease") {
  return makeComment(
    formatLease(lease),
    IDS.dispatcher,
    nodeId,
    204,
    lease.acquiredAt,
  );
}

function resultComment(result = PASS_RESULT, author = IDS.result, nodeId = "IC_result") {
  return makeComment(formatTaskResult(result), author, nodeId, 202);
}

function acceptanceComment(result = PASS_RESULT, author = IDS.acceptance) {
  const body = formatTaskResult(result);
  return makeComment(
    formatAcceptance({
      resultCommentNodeId: "IC_result",
      resultBodyDigest: resultDigest(body),
      summary: "Result is satisfactory.",
    }),
    author,
    "IC_acceptance",
    203,
  );
}

async function jsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function fakeGitHub({
  parentStatus = "status:new",
  tasks = [makeTask()],
  children = [TASK_NUMBER],
  comments = {},
  parentComments = [],
  failures = {},
  incorrectlyTypedCreates = 0,
  workerConfig = WORKERS_YAML,
} = {}) {
  const state = {
    identityId: IDS.result,
    operations: [],
    tasks: new Map(tasks.map((item) => [item.number, structuredClone(item)])),
    children: [...children],
    comments: new Map(),
    nextIssue: 30,
    nextComment: 300,
    failures: { ...failures },
    incorrectlyTypedCreates,
    createPayloads: [],
    workerConfig,
    hooks: {},
    subIssueRepositoryUrl:
      "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
    parentIssueReads: 0,
    parent: {
      id: 107,
      number: PARENT_NUMBER,
      node_id: PARENT_NODE,
      state: "open",
      title: "Parent title",
      body: "Parent body",
      labels: [{ name: parentStatus }, { name: "kind:demo" }],
      user: { id: IDS.submitter, login: "submitter", type: "User" },
      repository_url: "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
    },
  };
  state.comments.set(PARENT_NUMBER, structuredClone(parentComments));
  for (const task of state.tasks.values()) {
    state.comments.set(task.number, structuredClone(comments[task.number] ?? []));
  }

  function fail(operation, timing, response) {
    if (state.failures[operation] !== timing) return false;
    delete state.failures[operation];
    send(response, 500, { message: `${operation} failed ${timing} write` });
    return true;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;
    state.operations.push(`${request.method} ${route}`);
    if (request.headers.authorization !== "Bearer test-token") {
      send(response, 401, { message: "bad token" });
      return;
    }
    if (request.method === "GET" && route === "/user") {
      send(response, 200, {
        id: state.identityId,
        login: `actor-${state.identityId}`,
      });
      return;
    }
    if (
      request.method === "GET" &&
      route ===
        "/repos/drasi-project/drasi-workgraph-demo/contents/.github/workgraph/workers.yaml"
    ) {
      send(response, 200, {
        path: ".github/workgraph/workers.yaml",
        encoding: "base64",
        content: Buffer.from(state.workerConfig, "utf8").toString("base64"),
        sha: "1".repeat(40),
      });
      return;
    }
    const issueMatch = route.match(
      /^\/repos\/drasi-project\/drasi-workgraph-demo\/issues\/(\d+)$/,
    );
    if (request.method === "GET" && issueMatch) {
      const number = Number(issueMatch[1]);
      if (number === PARENT_NUMBER) {
        state.parentIssueReads += 1;
        state.hooks.beforeParentIssueRead?.(state.parentIssueReads, state);
      }
      send(
        response,
        200,
        number === PARENT_NUMBER ? state.parent : state.tasks.get(number),
      );
      return;
    }
    const parentMatch = route.match(/\/issues\/(\d+)\/parent$/);
    if (request.method === "GET" && parentMatch) {
      const number = Number(parentMatch[1]);
      if (state.children.includes(number)) {
        send(response, 200, state.parent);
      } else {
        send(response, 404, { message: "Not Found" });
      }
      return;
    }
    const commentMatch = route.match(/\/issues\/comments\/(\d+)$/);
    if (request.method === "GET" && commentMatch) {
      const id = Number(commentMatch[1]);
      state.hooks.beforeGetComment?.(id, state);
      for (const list of state.comments.values()) {
        const comment = list.find((item) => item.id === id);
        if (comment) {
          send(response, 200, comment);
          return;
        }
      }
      send(response, 404, { message: "Not Found" });
      return;
    }
    const commentsMatch = route.match(/\/issues\/(\d+)\/comments$/);
    if (request.method === "GET" && commentsMatch) {
      send(response, 200, state.comments.get(Number(commentsMatch[1])) ?? []);
      return;
    }
    if (request.method === "POST" && commentsMatch) {
      const number = Number(commentsMatch[1]);
      const payload = await jsonBody(request);
      state.hooks.beforePostComment?.(number, payload, state);
      const comment = makeComment(
        payload.body,
        state.identityId,
        `IC_created_${state.nextComment}`,
        state.nextComment,
        `2026-08-18T22:${String(state.nextComment % 60).padStart(2, "0")}:00Z`,
      );
      state.nextComment += 1;
      const list = state.comments.get(number) ?? [];
      list.push(comment);
      state.comments.set(number, list);
      state.hooks.afterPostComment?.(number, comment, state);
      send(response, 201, comment);
      return;
    }
    const patchMatch = route.match(/\/issues\/comments\/(\d+)$/);
    if (request.method === "PATCH" && patchMatch) {
      const id = Number(patchMatch[1]);
      const payload = await jsonBody(request);
      state.hooks.beforePatchComment?.(id, payload, state);
      for (const list of state.comments.values()) {
        const comment = list.find((item) => item.id === id);
        if (comment) {
          comment.body = payload.body;
          state.hooks.afterPatchComment?.(id, comment, state);
          send(response, 200, comment);
          return;
        }
      }
    }
    const subMatch = route.match(/\/issues\/(\d+)\/sub_issues$/);
    if (request.method === "GET" && subMatch) {
      send(
        response,
        200,
        state.children.map((number) => ({
          number,
          node_id: state.tasks.get(number).node_id,
          repository_url: state.subIssueRepositoryUrl,
        })),
      );
      return;
    }
    if (request.method === "POST" && subMatch) {
      if (fail("attach", "before", response)) return;
      const payload = await jsonBody(request);
      const child = [...state.tasks.values()].find(
        (item) => item.id === payload.sub_issue_id,
      );
      if (!state.children.includes(child.number)) state.children.push(child.number);
      if (fail("attach", "after", response)) return;
      send(response, 201, child);
      return;
    }
    if (
      request.method === "GET" &&
      route === "/repos/drasi-project/drasi-workgraph-demo/issues"
    ) {
      send(response, 200, [
        state.parent,
        ...[...state.tasks.values()].filter((task) => task.state === "open"),
      ]);
      return;
    }
    if (
      request.method === "POST" &&
      route === "/repos/drasi-project/drasi-workgraph-demo/issues"
    ) {
      if (fail("create", "before", response)) return;
      const payload = await jsonBody(request);
      state.createPayloads.push(payload);
      const task = makeTask({
        number: state.nextIssue,
        nodeId: `I_created_${state.nextIssue}`,
        id: 1000 + state.nextIssue,
        taskType: payload.body.includes("request-info")
          ? "request-info"
          : "validate-issue",
        resultNode:
          payload.body.match(/validationResultCommentNodeId: ([A-Za-z0-9_-]+)/)?.[1],
      });
      task.title = payload.title;
      task.body = payload.body;
      if (state.incorrectlyTypedCreates > 0) {
        task.type = null;
        state.incorrectlyTypedCreates -= 1;
      }
      state.nextIssue += 1;
      state.tasks.set(task.number, task);
      state.comments.set(task.number, []);
      if (fail("create", "after", response)) return;
      send(response, 201, task);
      return;
    }
    const labelsMatch = route.match(/\/issues\/(\d+)\/labels$/);
    if (request.method === "PUT" && labelsMatch) {
      if (fail("status", "before", response)) return;
      const payload = await jsonBody(request);
      state.parent.labels = payload.labels.map((name) => ({ name }));
      if (fail("status", "after", response)) return;
      send(response, 200, state.parent.labels);
      return;
    }
    send(response, 404, { message: `unhandled ${request.method} ${route}` });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    state,
    api: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function baseInput(task = makeTask()) {
  return {
    taskIssueNumber: task.number,
    taskIssueNodeId: task.node_id,
    parentIssueNumber: PARENT_NUMBER,
    parentIssueNodeId: PARENT_NODE,
  };
}

async function runTool(fake, actorId, name, input) {
  fake.state.identityId = actorId;
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: input },
    },
  ];
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      WORKGRAPH_TEST_GITHUB_API_URL: fake.api,
      COPILOT_MCP_WORKGRAPH_TOKEN: "test-token",
      COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: TYPE_ID,
      COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID: String(IDS.launcher),
      COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID: String(IDS.assignment),
      COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID: String(IDS.result),
      COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID: String(IDS.acceptance),
      COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID: String(IDS.orchestrator),
      COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID: String(IDS.info),
      COPILOT_MCP_WORKGRAPH_REDISPATCH_REPORTER_USER_ID: String(IDS.redispatch),
      COPILOT_MCP_WORKGRAPH_DISPATCHER_USER_ID: String(IDS.dispatcher),
      COPILOT_MCP_WORKGRAPH_LEASE_REPORTER_USER_ID: String(IDS.leaseReporter),
      WORKGRAPH_TEST_NOW: "2026-08-19T00:00:00Z",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  const responses = stdout.trim().split("\n").map(JSON.parse);
  return { tools: responses[1].result.tools, result: responses[2].result };
}

async function withFake(options, callback) {
  const fake = await fakeGitHub(options);
  try {
    await callback(fake);
  } finally {
    await fake.close();
  }
}

test("exact canonical task YAML supports only the two contracts", () => {
  const validation = formatTask(taskPayload());
  assert.equal(
    validation,
    "WorkGraphTask/v1\n\n```yaml\ntaskType: validate-issue\ninputs:\n  validationProfile: new-issue-default\n```\n",
  );
  assert.deepEqual(parseTask(validation), taskPayload());
  const request = formatTask(taskPayload("request-info", "IC_validation"));
  assert.equal(
    request,
    "WorkGraphTask/v1\n\n```yaml\ntaskType: request-info\ninputs:\n  validationResultCommentNodeId: IC_validation\n```\n",
  );
  assert.deepEqual(parseTask(request), taskPayload("request-info", "IC_validation"));
  assert.throws(
    () => parseTask(validation.replace("```yaml", "```yml")),
    /not canonical/,
  );
  assert.throws(
    () => parseTask(validation.replace("new-issue-default", "other")),
    /new-issue-default/,
  );
});

test("exact Assignment, validation pass/failure, request-info, and Acceptance bytes", () => {
  assert.equal(
    formatAssignment("issue-validator", "issue-validation-01"),
    'WorkGraphTaskAssignment/v2\n\n```json\n{\n  "agentProfile": "issue-validator",\n  "workerId": "issue-validation-01"\n}\n```\n',
  );
  for (const result of [PASS_RESULT, FAIL_RESULT]) {
    const body = formatTaskResult(leasedResult(result));
    assert.equal(body.startsWith("WorkGraphTaskResult/v2\n\n```json\n{\n"), true);
    assert.equal(body.includes("assignmentId"), false);
    assert.equal(body.includes("bodyDigest"), false);
    assert.equal(body.endsWith("```\n"), true);
  }
  const info = {
    taskType: "request-info",
    outcome: "succeeded",
    summary: "Requested missing information.",
    result: {
      requestCommentNodeId: "IC_info",
    },
  };
  assert.equal(
    formatTaskResult(leasedResult(info)).includes('"requestCommentNodeId"'),
    true,
  );
  const acceptance = formatAcceptance({
    resultCommentNodeId: "IC_result",
    resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
    summary: "Result is satisfactory.",
  });

  test("worker config is strict and worker selection is deterministic", () => {
    assert.deepEqual(parseWorkersYaml(WORKERS_YAML), [
      {
        workerId: "issue-validation-01",
        agentProfile: "issue-validator",
        slots: 1,
        leaseDuration: "PT30M",
      },
      {
        workerId: "issue-information-01",
        agentProfile: "issue-info-requester",
        slots: 1,
        leaseDuration: "PT30M",
      },
    ]);
    assert.equal(
      selectWorker(
        [
          { workerId: "worker-z", agentProfile: "issue-validator", queueDepth: 1 },
          { workerId: "worker-b", agentProfile: "issue-validator", queueDepth: 0 },
          { workerId: "worker-a", agentProfile: "issue-validator", queueDepth: 0 },
        ],
        "issue-validator",
      ).workerId,
      "worker-a",
    );
    assert.throws(
      () => parseWorkersYaml(WORKERS_YAML.replace("slots: 1", "slots: 0")),
      /slots/,
    );
    assert.throws(
      () => parseWorkersYaml(WORKERS_YAML.replace("leaseDuration: PT30M", "leaseDuration: P1Y")),
      /malformed|duration/,
    );
    assert.match(
      formatV2Assignment("issue-validator", "issue-validation.01"),
      /"workerId": "issue-validation\.01"/,
    );
    assert.match(
      formatV2TaskResult(leasedResult(PASS_RESULT, "lease:attempt.01")),
      /"leaseId": "lease:attempt\.01"/,
    );
  });
  assert.match(acceptance, /^WorkGraphTaskResultAcceptance\/v1/);
});

test("exposes only seven narrow tools and ignores MCP notifications", async () => {
  await withFake({}, async (fake) => {
    const { tools } = await runTool(fake, IDS.assignment, "submit_task_assignment", {
      ...baseInput(),
      agentProfile: "issue-validator",
      workerId: "issue-validation-01",
      compatibleWorkers: compatibleWorkers(),
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "get_result_snapshot",
        "submit_task_assignment",
        "submit_task_result",
        "submit_result_acceptance",
        "transition_issue",
        "post_parent_info_request",
        "feedback_and_redispatch",
      ],
    );
    tools.forEach((tool) =>
      assert.equal(tool.inputSchema.additionalProperties, false),
    );
  });
});

test("verified Result snapshot supplies the acceptor digest", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.acceptance,
        "get_result_snapshot",
        baseInput(),
      );
      assert.deepEqual(response.result.structuredContent, {
        resultCommentNodeId: "IC_result",
        resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
        workResult: PASS_RESULT,
      });
      assert.equal(response.result.isError, false);
    },
  );
});

test("Acceptance reviews and digest-binds Result/v2 identically to Result/v1", async () => {
  const result = leasedResult(PASS_RESULT);
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          assignmentV2Comment(),
          leaseComment(),
          resultComment(result),
        ],
      },
    },
    async (fake) => {
      const snapshot = await runTool(
        fake,
        IDS.acceptance,
        "get_result_snapshot",
        baseInput(),
      );
      assert.deepEqual(snapshot.result.structuredContent.workResult, result);
      const accepted = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: resultDigest(formatTaskResult(result)),
          summary: "Lease-bound Result is satisfactory.",
        },
      );
      assert.equal(accepted.result.isError, false);
      assert.equal(
        fake.state.comments
          .get(TASK_NUMBER)
          .at(-1).body.includes("WorkGraphTaskResultAcceptance/v1"),
        true,
      );
    },
  );
});

test("assignment submission is task-only, exact, and idempotent", async () => {
  await withFake({}, async (fake) => {
    const input = {
      ...baseInput(),
      agentProfile: "issue-validator",
      workerId: "issue-validation-01",
      compatibleWorkers: compatibleWorkers(),
    };
    const first = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      input,
    );
    assert.equal(first.result.isError, false);
    const second = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      input,
    );
    assert.equal(second.result.structuredContent.reconciled, true);
    assert.equal(
      fake.state.comments.get(TASK_NUMBER)[0].body,
      formatAssignment("issue-validator", "issue-validation-01"),
    );
    assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 0);
  });
});

test("assignment rejects wrong target mapping and foreign author", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          makeComment(
            formatAssignment("issue-validator", "issue-validation-01"),
            999,
            "IC_assignment",
            201,
          ),
        ],
      },
    },
    async (fake) => {
      let response = await runTool(
        fake,
        IDS.assignment,
        "submit_task_assignment",
        {
          ...baseInput(),
          agentProfile: "issue-validator",
          workerId: "issue-validation-01",
          compatibleWorkers: compatibleWorkers(),
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /foreign/);
      response = await runTool(
        fake,
        IDS.assignment,
        "submit_task_assignment",
        {
          ...baseInput(),
          agentProfile: "issue-info-requester",
          workerId: "issue-information-01",
          compatibleWorkers: compatibleWorkers("issue-info-requester"),
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /does not match taskType/);
    },
  );
});

test("assignment rejects nondeterministic selection and malformed authoritative config", async () => {
  await withFake({}, async (fake) => {
    const response = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      {
        ...baseInput(),
        agentProfile: "issue-validator",
        workerId: "worker-z",
        compatibleWorkers: [
          {
            workerId: "worker-z",
            agentProfile: "issue-validator",
            queueDepth: 1,
          },
          {
            workerId: "issue-validation-01",
            agentProfile: "issue-validator",
            queueDepth: 0,
          },
        ],
      },
    );
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /lowest queue depth/);
  });
  await withFake({ workerConfig: "version: 1\nworkers: []\n" }, async (fake) => {
    const response = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      {
        ...baseInput(),
        agentProfile: "issue-validator",
        workerId: "issue-validation-01",
        compatibleWorkers: compatibleWorkers(),
      },
    );
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /worker config/);
  });
});

test("Result v2 ends its Lease, reconciles exact retries, and rejects same-Lease revision", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), leaseComment()],
      },
    },
    async (fake) => {
      const result = leasedResult(FAIL_RESULT);
      const input = {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: result,
      };
      const first = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(first.result.isError, false);
      assert.equal(first.result.structuredContent.revised, false);
      const duplicate = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      const revisedResult = {
        ...result,
        summary: "The issue still needs a body.",
      };
      const revised = await runTool(fake, IDS.result, "submit_task_result", {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: revisedResult,
      });
      assert.equal(revised.result.isError, true);
      assert.match(revised.result.content[0].text, /ended by Result/);
      assert.equal(fake.state.tasks.get(TASK_NUMBER).state, "open");
      assert.equal(
        fake.state.operations.some(
          (op) => op.startsWith("PATCH") && !op.includes("/issues/comments/"),
        ),
        false,
      );
    },
  );
});

test("Result submits a valid passing validation without closing the task", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), leaseComment()],
      },
    },
    async (fake) => {
      const result = leasedResult(PASS_RESULT);
      const response = await runTool(fake, IDS.result, "submit_task_result", {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: result,
      });
      assert.equal(response.result.isError, false);
      assert.equal(
        fake.state.comments.get(TASK_NUMBER).at(-1).body,
        formatTaskResult(result),
      );
      assert.equal(fake.state.tasks.get(TASK_NUMBER).state, "open");
      assert.equal(
        fake.state.operations.some((operation) =>
          /PATCH .*\/issues\/17$/.test(operation),
        ),
        false,
      );
    },
  );
});

test("Result rejects expired, mismatched, duplicate, superseded, and ended Leases", async () => {
  const expiredLease = {
    ...ACTIVE_LEASE,
    acquiredAt: "2026-08-18T23:00:00Z",
    expiresAt: "2026-08-18T23:59:59Z",
  };
  const newerLease = {
    ...ACTIVE_LEASE,
    leaseId: "lease-002",
    acquiredAt: "2026-08-18T23:45:00Z",
    expiresAt: "2026-08-19T00:45:00Z",
  };
  const cases = [
    {
      name: "expired",
      lease: expiredLease,
      extras: [],
      input: activeLeaseInput(expiredLease),
      expected: /expired; stale late Result rejected/,
    },
    {
      name: "wrong slot",
      lease: ACTIVE_LEASE,
      extras: [],
      input: { ...activeLeaseInput(), slotId: "issue-validation-01/2" },
      expected: /not an enabled slot/,
    },
    {
      name: "wrong assignment",
      lease: ACTIVE_LEASE,
      extras: [],
      input: {
        ...activeLeaseInput(),
        assignmentCommentNodeId: "IC_other_assignment",
      },
      expected: /exact Assignment\/v2/,
    },
    {
      name: "duplicate",
      lease: ACTIVE_LEASE,
      extras: [leaseComment(ACTIVE_LEASE, "IC_duplicate_lease")],
      input: activeLeaseInput(),
      expected: /duplicate Lease acquisitions/,
    },
    {
      name: "superseded",
      lease: ACTIVE_LEASE,
      extras: [leaseComment(newerLease, "IC_newer_lease")],
      input: activeLeaseInput(),
      expected: /superseded/,
    },
    {
      name: "expired artifact",
      lease: ACTIVE_LEASE,
      extras: [
        makeComment(
          formatLeaseExpiration({
            leaseCommentNodeId: "IC_lease",
            leaseId: ACTIVE_LEASE.leaseId,
            expiredAt: "2026-08-18T23:59:59Z",
            reason: "Lease deadline reached.",
          }),
          IDS.leaseReporter,
          "IC_expiration",
          205,
        ),
      ],
      input: activeLeaseInput(),
      expected: /ended by expiration/,
    },
    {
      name: "result ended",
      lease: ACTIVE_LEASE,
      extras: [resultComment(leasedResult(PASS_RESULT))],
      input: activeLeaseInput(),
      expected: /ended by Result/,
    },
  ];
  for (const scenario of cases) {
    await withFake(
      {
        comments: {
          [TASK_NUMBER]: [
            assignmentV2Comment(),
            leaseComment(scenario.lease),
            ...scenario.extras,
          ],
        },
      },
      async (fake) => {
        const response = await runTool(fake, IDS.result, "submit_task_result", {
          ...baseInput(),
          ...scenario.input,
          workResult: leasedResult(FAIL_RESULT, scenario.input.leaseId),
        });
        assert.equal(response.result.isError, true, scenario.name);
        assert.match(response.result.content[0].text, scenario.expected, scenario.name);
      },
    );
  }
});

test("Result rejects wrong Assignment/Result authors and task target", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          makeComment(
            formatAssignment("issue-validator", "issue-validation-01"),
            999,
            "IC_assignment",
            201,
          ),
          leaseComment(),
        ],
      },
    },
    async (fake) => {
      const response = await runTool(fake, IDS.result, "submit_task_result", {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: leasedResult(PASS_RESULT),
      });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /configured Assignment reporter/);
    },
  );
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          assignmentComment(),
          resultComment(PASS_RESULT, 999),
          leaseComment(),
        ],
      },
    },
    async (fake) => {
      const response = await runTool(fake, IDS.result, "submit_task_result", {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: leasedResult(PASS_RESULT),
      });
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /configured Result reporter/);
    },
  );
});

test("Result rejects wrong repository, type, and parent provenance", async () => {
  const cases = [
    {
      name: "repository",
      mutate(fake) {
        fake.state.tasks.get(TASK_NUMBER).repository_url =
          "https://api.github.com/repos/drasi-project/other";
      },
      expected: /fixed-repository/,
    },
    {
      name: "type",
      mutate(fake) {
        fake.state.tasks.get(TASK_NUMBER).type = {
          name: "Issue",
          node_id: "IT_other",
        };
      },
      expected: /exact WorkGraphTask type/,
    },
    {
      name: "parent",
      mutate(fake) {
        fake.state.parent.node_id = "I_other_parent";
      },
      expected: /native parent/,
    },
  ];
  for (const scenario of cases) {
    await withFake(
      {
        comments: {
          [TASK_NUMBER]: [assignmentV2Comment(), leaseComment()],
        },
      },
      async (fake) => {
        scenario.mutate(fake);
        const response = await runTool(fake, IDS.result, "submit_task_result", {
          ...baseInput(),
          ...activeLeaseInput(),
          workResult: leasedResult(PASS_RESULT),
        });
        assert.equal(response.result.isError, true, scenario.name);
        assert.match(response.result.content[0].text, scenario.expected, scenario.name);
      },
    );
  }
});

test("request-info posts one idempotent parent comment and submits typed Result", async () => {
  const validation = makeTask({ state: "closed" });
  const request = makeTask({
    number: 18,
    nodeId: "I_request",
    id: 118,
    taskType: "request-info",
    resultNode: "IC_result",
  });
  await withFake(
    {
      parentStatus: "status:awaiting-need-info",
      tasks: [validation, request],
      children: [17, 18],
      comments: {
        17: [
          assignmentComment(),
          resultComment(FAIL_RESULT),
          acceptanceComment(FAIL_RESULT),
        ],
        18: [
          assignmentV2Comment(
            "issue-info-requester",
            "issue-information-01",
            "IC_assignment_request",
          ),
          leaseComment(INFO_LEASE, "IC_lease_request"),
        ],
      },
    },
    async (fake) => {
      const infoInput = {
        ...baseInput(request),
        validationTaskIssueNumber: 17,
        validationTaskIssueNodeId: TASK_NODE,
        validationResultCommentNodeId: "IC_result",
        ...activeLeaseInput(INFO_LEASE, "IC_lease_request"),
      };
      const first = await runTool(
        fake,
        IDS.info,
        "post_parent_info_request",
        infoInput,
      );
      assert.equal(first.result.isError, false);
      assert.match(fake.state.comments.get(PARENT_NUMBER)[0].body, /@submitter/);
      assert.match(fake.state.comments.get(PARENT_NUMBER)[0].body, /The Issue body is present/);
      const duplicate = await runTool(
        fake,
        IDS.info,
        "post_parent_info_request",
        infoInput,
      );
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 1);

      const infoResult = {
        taskType: "request-info",
        leaseId: INFO_LEASE.leaseId,
        outcome: "succeeded",
        summary: "Requested the missing issue information.",
        result: {
          requestCommentNodeId:
            first.result.structuredContent.requestCommentNodeId,
        },
      };
      const submitted = await runTool(fake, IDS.result, "submit_task_result", {
        ...baseInput(request),
        ...activeLeaseInput(INFO_LEASE, "IC_lease_request"),
        workResult: infoResult,
      });
      assert.equal(submitted.result.isError, false);
      assert.equal(
        fake.state.comments.get(18).at(-1).body,
        formatTaskResult(infoResult),
      );
      assert.equal(request.state, "open");
    },
  );
});

test("Acceptance is idempotent and rejects stale digest, wrong author, and wrong target", async () => {
  const comments = [assignmentComment(), resultComment(PASS_RESULT)];
  await withFake(
    { comments: { [TASK_NUMBER]: comments } },
    async (fake) => {
      const correct = {
        ...baseInput(),
        resultCommentNodeId: "IC_result",
        resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
        summary: "Result is satisfactory.",
      };
      const first = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        correct,
      );
      assert.equal(first.result.isError, false);
      const duplicate = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        correct,
      );
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      const stale = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        { ...correct, resultBodyDigest: `sha256:${"0".repeat(64)}` },
      );
      assert.equal(stale.result.isError, true);
      assert.match(stale.result.content[0].text, /stale Result/);
      const wrongTarget = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        { ...correct, resultCommentNodeId: "IC_other" },
      );
      assert.equal(wrongTarget.result.isError, true);
    },
  );
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          assignmentComment(),
          resultComment(PASS_RESULT),
          acceptanceComment(PASS_RESULT, 999),
        ],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
          summary: "Result is satisfactory.",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /foreign/);
    },
  );
});

test("start transition rejects stale status and any open child", async () => {
  await withFake({}, async (fake) => {
    let response = await runTool(fake, IDS.orchestrator, "transition_issue", {
      parentIssueNumber: PARENT_NUMBER,
      parentIssueNodeId: PARENT_NODE,
      expectedStatus: "status:new",
      transition: "start-validation",
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /open child/);
    fake.state.parent.labels = [{ name: "status:awaiting-triage" }];
    response = await runTool(fake, IDS.orchestrator, "transition_issue", {
      parentIssueNumber: PARENT_NUMBER,
      parentIssueNodeId: PARENT_NODE,
      expectedStatus: "status:new",
      transition: "start-validation",
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /stale supplied parent status/);
  });
});

test("accepted validation pass advances to triage and failure creates request-info", async () => {
  for (const [result, expectedStatus] of [
    [PASS_RESULT, "status:awaiting-triage"],
    [FAIL_RESULT, "status:awaiting-need-info"],
  ]) {
    await withFake(
      {
        parentStatus: "status:awaiting-validation",
        tasks: [makeTask({ state: "closed" })],
        comments: {
          [TASK_NUMBER]: [
            assignmentComment(),
            resultComment(result),
            acceptanceComment(result),
          ],
        },
      },
      async (fake) => {
        const response = await runTool(
          fake,
          IDS.orchestrator,
          "transition_issue",
          {
            parentIssueNumber: PARENT_NUMBER,
            parentIssueNodeId: PARENT_NODE,
            expectedStatus: "status:awaiting-validation",
            transition: "advance-validation",
            taskIssueNumber: TASK_NUMBER,
            taskIssueNodeId: TASK_NODE,
            resultCommentNodeId: "IC_result",
          },
        );
        assert.equal(response.result.isError, false);
        assert.equal(response.result.structuredContent.status, expectedStatus);
        assert.equal(
          fake.state.parent.labels.some((label) => label.name === expectedStatus),
          true,
        );
        if (result === FAIL_RESULT) {
          const created = fake.state.tasks.get(30);
          assert.equal(parseTask(created.body).taskType, "request-info");
          assert.equal(
            parseTask(created.body).inputs.validationResultCommentNodeId,
            "IC_result",
          );
        }
      },
    );
  }
});

test("accepted request-info resumes only from a later human reply", async () => {
  const request = makeTask({
    state: "closed",
    taskType: "request-info",
    resultNode: "IC_validation",
  });
  const infoResult = {
    taskType: "request-info",
    outcome: "succeeded",
    summary: "Requested the missing issue information.",
    result: {
      requestCommentNodeId: "IC_info",
    },
  };
  const infoBody =
    "@submitter, please provide the missing issue information:\n\n" +
    "- The Issue body is present\n\n" +
    "<!-- WorkGraphInfoRequest/v1 validationResultCommentNodeId=IC_validation -->\n";
  await withFake(
    {
      parentStatus: "status:awaiting-need-info",
      tasks: [request],
      comments: {
        [TASK_NUMBER]: [
          assignmentComment("issue-info-requester"),
          resultComment(infoResult),
          acceptanceComment(infoResult),
        ],
      },
      parentComments: [
        makeComment(infoBody, IDS.info, "IC_info", 240, "2026-08-18T22:00:00Z"),
        makeComment(
          "Added the missing details.",
          IDS.human,
          "IC_human_reply",
          241,
          "2026-08-18T22:01:00Z",
        ),
      ],
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:awaiting-need-info",
          transition: "resume-after-human-reply",
          taskIssueNumber: TASK_NUMBER,
          taskIssueNodeId: TASK_NODE,
          requestCommentNodeId: "IC_info",
          humanReplyCommentNodeId: "IC_human_reply",
        },
      );
      assert.equal(response.result.isError, false);
      assert.equal(
        response.result.structuredContent.status,
        "status:awaiting-validation",
      );
      assert.equal(parseTask(fake.state.tasks.get(30).body).taskType, "validate-issue");
    },
  );
});

test("feedback is idempotent and queues the assigned worker for a new Lease", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      const input = {
        ...baseInput(),
        resultCommentNodeId: "IC_result",
        resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
        feedback: "Clarify the evidence for the body criterion.",
      };
      const first = await runTool(
        fake,
        IDS.redispatch,
        "feedback_and_redispatch",
        input,
      );
      assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
      assert.deepEqual(first.result.structuredContent.redispatch, {
        status: "queued-for-lease",
        agentProfile: "issue-validator",
        workerId: "issue-validation-01",
        taskIssueNumber: TASK_NUMBER,
      });
      const duplicate = await runTool(
        fake,
        IDS.redispatch,
        "feedback_and_redispatch",
        input,
      );
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      const stale = await runTool(
        fake,
        IDS.redispatch,
        "feedback_and_redispatch",
        {
          ...input,
          resultBodyDigest: `sha256:${"0".repeat(64)}`,
        },
      );
      assert.equal(stale.result.isError, true);
      assert.match(stale.result.content[0].text, /stale Result digest/);
    },
  );
});

test("transition rejects a stale closed task and every open sibling", async () => {
  const oldTask = makeTask({ state: "closed" });
  const latestTask = makeTask({
    number: 19,
    nodeId: "I_latest",
    id: 119,
    state: "closed",
  });
  const openSibling = makeTask({
    number: 18,
    nodeId: "I_open_request",
    id: 118,
    taskType: "request-info",
    resultNode: "IC_result",
  });
  await withFake(
    {
      parentStatus: "status:awaiting-validation",
      tasks: [oldTask, latestTask],
      children: [17, 19],
      comments: {
        17: [assignmentComment(), resultComment(), acceptanceComment()],
        19: [assignmentComment(), resultComment(), acceptanceComment()],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:awaiting-validation",
          transition: "advance-validation",
          taskIssueNumber: oldTask.number,
          taskIssueNodeId: oldTask.node_id,
          resultCommentNodeId: "IC_result",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /current latest validate-issue/);
    },
  );
  await withFake(
    {
      parentStatus: "status:awaiting-validation",
      tasks: [oldTask, openSibling],
      children: [17, 18],
      comments: {
        17: [assignmentComment(), resultComment(), acceptanceComment()],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:awaiting-validation",
          transition: "advance-validation",
          taskIssueNumber: oldTask.number,
          taskIssueNodeId: oldTask.node_id,
          resultCommentNodeId: "IC_result",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /open child\/sibling/);
    },
  );
});

test("transition rejects cross-repository native children", async () => {
  const task = makeTask({ state: "closed" });
  await withFake(
    {
      parentStatus: "status:awaiting-validation",
      tasks: [task],
      children: [task.number],
      comments: {
        [task.number]: [
          assignmentComment(),
          resultComment(),
          acceptanceComment(),
        ],
      },
    },
    async (fake) => {
      fake.state.subIssueRepositoryUrl =
        "https://api.github.com/repos/drasi-project/other";
      const response = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:awaiting-validation",
          transition: "advance-validation",
          taskIssueNumber: task.number,
          taskIssueNodeId: task.node_id,
          resultCommentNodeId: "IC_result",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /outside the fixed repository/);
    },
  );
});

test("transition retries reconcile partial create, attach, and status writes", async () => {
  for (const [operation, timing] of [
    ["create", "after"],
    ["attach", "after"],
    ["status", "after"],
  ]) {
    await withFake(
      {
        tasks: [],
        children: [],
        failures: { [operation]: timing },
      },
      async (fake) => {
        const input = {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:new",
          transition: "start-validation",
        };
        const first = await runTool(
          fake,
          IDS.orchestrator,
          "transition_issue",
          input,
        );
        assert.equal(first.result.isError, true, operation);
        const retry = await runTool(
          fake,
          IDS.orchestrator,
          "transition_issue",
          input,
        );
        assert.equal(retry.result.isError, false, operation);
        assert.equal(fake.state.tasks.size, 1, operation);
        assert.deepEqual(fake.state.children, [30], operation);
        assert.equal(
          fake.state.parent.labels.some(
            (label) => label.name === "status:awaiting-validation",
          ),
          true,
          operation,
        );
        assert.equal(
          fake.state.tasks.get(30).title,
          "WorkGraph: validate-issue parent #7 start-validation",
        );
      },
    );
  }
});

test("transition birth-types tasks and replaces an incorrectly typed creation", async () => {
  await withFake(
    {
      tasks: [],
      children: [],
      incorrectlyTypedCreates: 1,
    },
    async (fake) => {
      const input = {
        parentIssueNumber: PARENT_NUMBER,
        parentIssueNodeId: PARENT_NODE,
        expectedStatus: "status:new",
        transition: "start-validation",
      };
      const rejected = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        input,
      );
      assert.equal(rejected.result.isError, true);
      assert.match(rejected.result.content[0].text, /did not reconcile/);
      assert.equal(fake.state.tasks.get(30).type, null);
      assert.equal(fake.state.comments.get(30).length, 0);
      assert.deepEqual(fake.state.children, []);

      const replaced = await runTool(
        fake,
        IDS.orchestrator,
        "transition_issue",
        input,
      );
      assert.equal(replaced.result.isError, false);
      assert.equal(fake.state.tasks.get(30).type, null);
      assert.deepEqual(fake.state.tasks.get(31).type, {
        name: "WorkGraphTask",
        node_id: TYPE_ID,
      });
      assert.deepEqual(fake.state.children, [31]);
      assert.equal(fake.state.createPayloads.length, 2);
      assert.equal(
        fake.state.createPayloads.every(
          (payload) => payload.type === "WorkGraphTask",
        ),
        true,
      );
      assert.equal(
        fake.state.operations.some(
          (operation) => /^PATCH \/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(operation),
        ),
        false,
      );
    },
  );
});

test("status mutation re-reads expected status and preserves concurrent labels", async () => {
  await withFake({ tasks: [], children: [] }, async (fake) => {
    fake.state.hooks.beforeParentIssueRead = (count, state) => {
      if (count === 2) state.parent.labels.push({ name: "concurrent:keep" });
    };
    const response = await runTool(
      fake,
      IDS.orchestrator,
      "transition_issue",
      {
        parentIssueNumber: PARENT_NUMBER,
        parentIssueNodeId: PARENT_NODE,
        expectedStatus: "status:new",
        transition: "start-validation",
      },
    );
    assert.equal(response.result.isError, false);
    assert.deepEqual(
      fake.state.parent.labels.map((label) => label.name).sort(),
      ["concurrent:keep", "kind:demo", "status:awaiting-validation"],
    );
  });
  await withFake({ tasks: [], children: [] }, async (fake) => {
    fake.state.hooks.beforeParentIssueRead = (count, state) => {
      if (count === 2) {
        state.parent.labels = [{ name: "status:awaiting-triage" }];
      }
    };
    const response = await runTool(
      fake,
      IDS.orchestrator,
      "transition_issue",
      {
        parentIssueNumber: PARENT_NUMBER,
        parentIssueNodeId: PARENT_NODE,
        expectedStatus: "status:new",
        transition: "start-validation",
      },
    );
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /immediately before mutation/);
    assert.equal(
      fake.state.operations.some((operation) => operation.startsWith("PUT ")),
      false,
    );
  });
});

test("parent info request requires the current request task Assignment", async () => {
  const validation = makeTask({ state: "closed" });
  const request = makeTask({
    number: 18,
    nodeId: "I_request",
    id: 118,
    taskType: "request-info",
    resultNode: "IC_result",
  });
  await withFake(
    {
      parentStatus: "status:awaiting-need-info",
      tasks: [validation, request],
      children: [17, 18],
      comments: {
        17: [
          assignmentComment(),
          resultComment(FAIL_RESULT),
          acceptanceComment(FAIL_RESULT),
        ],
        18: [],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.info,
        "post_parent_info_request",
        {
          ...baseInput(request),
          validationTaskIssueNumber: 17,
          validationTaskIssueNodeId: TASK_NODE,
          validationResultCommentNodeId: "IC_result",
          ...activeLeaseInput(INFO_LEASE, "IC_lease_request"),
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /one canonical Assignment/);
      assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 0);
    },
  );
});

test("feedback revision requires and consumes a newly granted active Lease", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      const input = {
        ...baseInput(),
        resultCommentNodeId: "IC_result",
        resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
        feedback: "Clarify the evidence.",
      };
      const first = await runTool(
        fake,
        IDS.redispatch,
        "feedback_and_redispatch",
        input,
      );
      assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
      fake.state.comments.get(TASK_NUMBER).push(leaseComment());
      const revisedResult = leasedResult({
        ...PASS_RESULT,
        summary: "Revised result evidence.",
      });
      const feedback = fake.state.comments
        .get(TASK_NUMBER)
        .find((comment) => comment.node_id === first.result.structuredContent.feedbackCommentNodeId);
      const revisedResultResponse = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        {
          ...baseInput(),
          ...activeLeaseInput(),
          feedbackCommentNodeId: feedback.node_id,
          feedbackUpdatedAt: feedback.updated_at,
          resultCommentNodeId: "IC_result",
          resultBodyDigest: input.resultBodyDigest,
          workResult: revisedResult,
        },
      );
      assert.equal(revisedResultResponse.result.isError, false);
      assert.equal(
        revisedResultResponse.result.structuredContent.resultBodyDigest,
        resultDigest(formatTaskResult(revisedResult)),
      );
      assert.equal(revisedResultResponse.result.structuredContent.revised, true);
      assert.equal(
        fake.state.comments.get(TASK_NUMBER).find((comment) => comment.node_id === "IC_result").body,
        formatTaskResult(revisedResult),
      );
      assert.equal(
        fake.state.comments
          .get(TASK_NUMBER)
          .filter((comment) =>
            comment.body.includes("WorkGraphTaskFeedback/v1"),
          ).length,
        1,
      );
    },
  );
});

test("Result/Expiration and Result/Acceptance writes fail closed on races", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentV2Comment(), leaseComment()],
      },
    },
    async (fake) => {
      fake.state.hooks.afterPostComment = (_number, comment, state) => {
        if (comment.body.includes("WorkGraphTaskResult/v2")) {
          state.comments.get(TASK_NUMBER).push(
            makeComment(
              formatLeaseExpiration({
                leaseCommentNodeId: "IC_lease",
                leaseId: ACTIVE_LEASE.leaseId,
                expiredAt: "2026-08-19T00:00:00Z",
                reason: "Lease deadline reached.",
              }),
              IDS.leaseReporter,
              "IC_racing_expiration",
              250,
            ),
          );
        }
      };
      const response = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        {
          ...baseInput(),
          ...activeLeaseInput(),
          workResult: leasedResult(PASS_RESULT),
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /ended by expiration/);
    },
  );
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      fake.state.hooks.beforeGetComment = (_id, state) => {
        state.comments.get(TASK_NUMBER).find(
          (comment) => comment.node_id === "IC_result",
        ).body = formatTaskResult(FAIL_RESULT);
      };
      const response = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
          summary: "Result is satisfactory.",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /changed during reconciliation/);
      assert.equal(
        fake.state.comments
          .get(TASK_NUMBER)
          .some((comment) =>
            comment.body.includes("WorkGraphTaskResultAcceptance/v1"),
          ),
        false,
      );
    },
  );
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      fake.state.hooks.afterPostComment = (_number, comment, state) => {
        if (comment.body.includes("WorkGraphTaskResultAcceptance/v1")) {
          state.comments.get(TASK_NUMBER).find(
            (item) => item.node_id === "IC_result",
          ).body = formatTaskResult(FAIL_RESULT);
        }
      };
      const response = await runTool(
        fake,
        IDS.acceptance,
        "submit_result_acceptance",
        {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: resultDigest(formatTaskResult(PASS_RESULT)),
          summary: "Result is satisfactory.",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /inconsistent/);
    },
  );
});
