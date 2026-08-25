import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  formatAcceptance,
  formatAssignment,
  formatFeedback,
  parseAgentsYaml,
  formatTask,
  formatTaskResult,
  parseTask,
  resultDigest,
} from "../.github/mcp/workgraph-reporter.mjs";
import {
  formatWorkflowAssignment,
  formatWorkflowResult,
  formatWorkflowTask,
} from "../.github/mcp/workgraph-v2-protocol.mjs";

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
  feedback: 16,
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
const AGENTS_YAML =
  "version: 1\nagents:\n" +
  "  - agentId: issue-validator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n" +
  "  - agentId: issue-info-requester\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n" +
  "  - agentId: issue-title-validator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n" +
  "  - agentId: issue-body-validator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n" +
  "  - agentId: issue-validation-evaluator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT30M\n";
const ACTIVE_LEASE = {
  leaseId: "lease-001",
  assignmentCommentNodeId: "IC_assignment",
  agentId: "issue-validator",
  slotId: "issue-validator/1",
  acquiredAt: "2026-08-18T23:30:00.479Z",
  expiresAt: "2026-08-19T00:30:00.479Z",
};
const INFO_LEASE = {
  leaseId: "lease-info-001",
  assignmentCommentNodeId: "IC_assignment_request",
  agentId: "issue-info-requester",
  slotId: "issue-info-requester/1",
  acquiredAt: "2026-08-18T23:30:00Z",
  expiresAt: "2026-08-19T00:30:00Z",
};
const WORKFLOW_LEASE = {
  leaseId: "lease-workflow-001",
  assignmentCommentNodeId: "IC_workflow_assignment",
  agentId: "issue-title-validator",
  slotId: "issue-title-validator/1",
  acquiredAt: "2026-08-18T23:30:00Z",
  expiresAt: "2026-08-19T00:30:00Z",
};
const WORKFLOW_COMMON = {
  workflowId: "issue-lifecycle",
  workflowRunId: "run-001",
  stepId: "parallel-validation",
  definitionCommit: "a".repeat(40),
  definitionDigest: `sha256:${"0".repeat(64)}`,
  generation: 1,
};
const WORKFLOW_CHILDREN = [
  {
    branchId: "title",
    operation: "validate-title",
    agent: "issue-title-validator",
    inputs: { field: "title", rule: "non-empty" },
  },
  {
    branchId: "body",
    operation: "validate-body",
    agent: "issue-body-validator",
    inputs: { field: "body", rule: "non-empty" },
  },
];
const WORKFLOW_PARENT_PAYLOAD = {
  taskType: "workflow-task",
  inputs: {
    ...WORKFLOW_COMMON,
    operation: "evaluate-validation",
    agent: "issue-validation-evaluator",
    inputs: { issueNodeId: "I_business" },
    join: "all",
    expectedChildCount: 2,
    children: WORKFLOW_CHILDREN,
  },
};
const WORKFLOW_TITLE_PAYLOAD = {
  taskType: "workflow-task",
  inputs: {
    ...WORKFLOW_COMMON,
    operation: "validate-title",
    agent: "issue-title-validator",
    inputs: { field: "title", rule: "non-empty" },
    branchId: "title",
  },
};
const PASS_RESULT = {
  taskType: "validate-issue",
  leaseId: ACTIVE_LEASE.leaseId,
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

function leasedResult(result, leaseId = ACTIVE_LEASE.leaseId) {
  return {
    taskType: result.taskType,
    leaseId,
    outcome: result.outcome,
    summary: result.summary,
    result: structuredClone(result.result),
  };
}

function activeLeaseInput(lease = ACTIVE_LEASE) {
  return {
    leaseId: lease.leaseId,
    assignmentCommentNodeId: lease.assignmentCommentNodeId,
    agentId: lease.agentId,
    slotId: lease.slotId,
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

function makeWorkflowTask(
  payload,
  {
    number = TASK_NUMBER,
    nodeId = TASK_NODE,
    id = 117,
    state = "open",
    authorId = IDS.launcher,
  } = {},
) {
  return {
    id,
    number,
    node_id: nodeId,
    state,
    title: `WorkGraph: ${payload.inputs.operation}`,
    body: formatWorkflowTask(payload),
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

function assignmentComment(
  agentId = "issue-validator",
  nodeId = "IC_assignment",
  author = IDS.assignment,
) {
  return makeComment(
    formatAssignment(agentId),
    author,
    nodeId,
    201,
  );
}

function workflowAssignmentComment(
  agentId = "issue-title-validator",
  nodeId = "IC_workflow_assignment",
  author = IDS.assignment,
) {
  return makeComment(
    formatWorkflowAssignment(agentId),
    author,
    nodeId,
    211,
  );
}

function resultComment(result = PASS_RESULT, author = IDS.result, nodeId = "IC_result") {
  const current = result.leaseId ? result : leasedResult(result);
  return makeComment(formatTaskResult(current), author, nodeId, 202);
}

function acceptanceComment(result = PASS_RESULT, author = IDS.acceptance) {
  const body = formatTaskResult(result.leaseId ? result : leasedResult(result));
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
  agentConfig = AGENTS_YAML,
  activeLease = {
    ...ACTIVE_LEASE,
    taskNodeId: TASK_NODE,
    taskType: "validate-issue",
  },
  leaseValidationStatus = 200,
  leaseValidationResponse = null,
  parentIssue = null,
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
    agentConfig,
    activeLease,
    leaseValidationStatus,
    leaseValidationResponse,
    hooks: {},
    subIssueRepositoryUrl:
      "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
    parentIssueReads: 0,
    parent: structuredClone(
      parentIssue ?? {
        id: 107,
        number: PARENT_NUMBER,
        node_id: PARENT_NODE,
        state: "open",
        title: "Parent title",
        body: "Parent body",
        labels: [{ name: parentStatus }, { name: "kind:demo" }],
        user: { id: IDS.submitter, login: "submitter", type: "User" },
        repository_url:
          "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
      },
    ),
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
    if (request.method === "POST" && route === "/lease/validate") {
      if (request.headers.authorization !== "Bearer source-token") {
        send(response, 401, { message: "bad lease token" });
        return;
      }
      const payload = await jsonBody(request);
      state.hooks.beforeLeaseValidation?.(payload, state);
      const expected = {
        taskNodeId: state.activeLease.taskNodeId,
        leaseId: state.activeLease.leaseId,
        assignmentCommentNodeId: state.activeLease.assignmentCommentNodeId,
        agentId: state.activeLease.agentId,
        slotId: state.activeLease.slotId,
      };
      if (state.leaseValidationStatus !== 200 || !isDeepStrictEqual(payload, expected)) {
        send(response, state.leaseValidationStatus === 200 ? 409 : state.leaseValidationStatus, {});
        return;
      }
      send(response, 200, state.leaseValidationResponse ?? state.activeLease);
      return;
    }
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
        "/repos/drasi-project/drasi-workgraph-demo/contents/.github/workgraph/agents.yaml"
    ) {
      send(response, 200, {
        path: ".github/workgraph/agents.yaml",
        encoding: "base64",
        content: Buffer.from(state.agentConfig, "utf8").toString("base64"),
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

async function runTool(fake, actorId, name, input, { unsetEnv = [] } = {}) {
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
  const env = {
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
    COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID: String(IDS.feedback),
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL: `${fake.api}/lease/validate`,
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN: "source-token",
    WORKGRAPH_TEST_NOW: "2026-08-19T00:00:00Z",
  };
  for (const key of unsetEnv) delete env[key];
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env,
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
    formatAssignment("issue-validator"),
    'WorkGraphTaskAssignment/v1\n\n```json\n{\n  "agentId": "issue-validator"\n}\n```\n',
  );
  for (const result of [PASS_RESULT, FAIL_RESULT]) {
    const body = formatTaskResult(leasedResult(result));
    assert.equal(body.startsWith("WorkGraphTaskResult/v1\n\n```json\n{\n"), true);
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
  const feedback = formatFeedback(
    "IC_result",
    resultDigest(formatTaskResult(PASS_RESULT)),
    "Clarify the evidence.",
  );

  test("agent config is strict and uses canonical agent IDs", () => {
    assert.deepEqual(parseAgentsYaml(AGENTS_YAML), [
      {
        agentId: "issue-validator",
        slots: 1,
        leaseDuration: "PT30M",
      },
      {
        agentId: "issue-info-requester",
        slots: 1,
        leaseDuration: "PT30M",
      },
      {
        agentId: "issue-title-validator",
        slots: 1,
        leaseDuration: "PT30M",
      },
      {
        agentId: "issue-body-validator",
        slots: 1,
        leaseDuration: "PT30M",
      },
      {
        agentId: "issue-validation-evaluator",
        slots: 1,
        leaseDuration: "PT30M",
      },
    ]);
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace("slots: 1", "slots: 0")),
      /slots/,
    );
    const configWith = (agentIds) =>
      "version: 1\nagents:\n" +
      agentIds
        .map(
          (agentId) =>
            `  - agentId: ${agentId}\n` +
            "    slots: 1\n" +
            "    leaseDuration: PT1S\n",
        )
        .join("");
    assert.equal(
      parseAgentsYaml(
        configWith(Array.from({ length: 64 }, (_, index) => `Agent.${index}`)),
      ).length,
      64,
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          configWith(Array.from({ length: 65 }, (_, index) => `Agent.${index}`)),
        ),
      /malformed/,
    );
    assert.deepEqual(
      parseAgentsYaml(configWith(["Agent", "agent"])).map(
        (agent) => agent.agentId,
      ),
      ["Agent", "agent"],
    );
    assert.equal(
      parseAgentsYaml(configWith(["A".repeat(64)]))[0].agentId.length,
      64,
    );
    assert.throws(
      () => parseAgentsYaml(configWith(["A".repeat(65)])),
      /malformed/,
    );
    assert.deepEqual(
      parseAgentsYaml(
        "version: 1\nagents:\n" +
          "  - agentId: Agent_1.test-name\n" +
          "    slots: 16\n" +
          "    leaseDuration: PT24H\n",
      ),
      [
        {
          agentId: "Agent_1.test-name",
          slots: 16,
          leaseDuration: "PT24H",
        },
      ],
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          AGENTS_YAML.replace(
            "agentId: issue-validator",
            "agentId: invalid/agent",
          ),
        ),
      /malformed/,
    );
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace("leaseDuration: PT30M", "leaseDuration: P1Y")),
      /malformed|duration/,
    );
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace("leaseDuration: PT30M", "leaseDuration: P1DT")),
      /duration/,
    );
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace("slots: 1", "slots: 17")),
      /slots/,
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          AGENTS_YAML.replace("leaseDuration: PT30M", "leaseDuration: PT86401S"),
        ),
      /24 hours/,
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          AGENTS_YAML.replace(
            "agentId: issue-info-requester",
            "agentId: issue-validator",
          ),
        ),
      /unique/,
    );
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace("agents:", "workers:")),
      /agents list/,
    );
    assert.throws(
      () => parseAgentsYaml(AGENTS_YAML.replace(/\n/g, "\r\n")),
      /bounded LF UTF-8/,
    );
    assert.throws(
      () => parseAgentsYaml("x".repeat(256 * 1024 + 1)),
      /bounded LF UTF-8/,
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          AGENTS_YAML.replace("    slots: 1\n", "    extra: no\n    slots: 1\n"),
        ),
      /malformed/,
    );
    assert.throws(
      () =>
        parseAgentsYaml(
          AGENTS_YAML.replace(
            "agentId: issue-validator",
            "agentProfile: issue-validator\n    workerId: legacy",
          ),
        ),
      /malformed/,
    );
    assert.match(
      formatTaskResult(leasedResult(PASS_RESULT, "lease:attempt.01")),
      /"leaseId": "lease:attempt\.01"/,
    );
  });
  assert.match(acceptance, /^WorkGraphTaskResultAcceptance\/v1/);
  assert.equal(
    feedback,
    `WorkGraphTaskFeedback/v1

\`\`\`json
{
  "resultCommentNodeId": "IC_result",
  "resultBodyDigest": "${resultDigest(formatTaskResult(PASS_RESULT))}",
  "feedback": "Clarify the evidence."
}
\`\`\`
`,
  );
});

test("exposes only nine narrow tools and ignores MCP notifications", async () => {
  await withFake({}, async (fake) => {
    const { tools } = await runTool(fake, IDS.assignment, "submit_task_assignment", {
      ...baseInput(),
      agentId: "issue-validator",
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "get_result_snapshot",
        "submit_task_assignment",
        "submit_task_result",
        "submit_workflow_task_assignment",
        "submit_workflow_task_result",
        "submit_result_acceptance",
        "transition_issue",
        "post_parent_info_request",
        "submit_task_feedback",
      ],
    );
    tools.forEach((tool) =>
      assert.equal(tool.inputSchema.additionalProperties, false),
    );
    const resultTool = tools.find((tool) => tool.name === "submit_task_result");
    const assignmentTool = tools.find(
      (tool) => tool.name === "submit_task_assignment",
    );
    const workflowResultTool = tools.find(
      (tool) => tool.name === "submit_workflow_task_result",
    );
    assert.deepEqual(
      Object.keys(assignmentTool.inputSchema.properties).sort(),
      [...Object.keys(baseInput()), "agentId"].sort(),
    );
    assert.deepEqual(
      [...assignmentTool.inputSchema.required].sort(),
      [...Object.keys(baseInput()), "agentId"].sort(),
    );
    assert.deepEqual(
      [...resultTool.inputSchema.required].sort(),
      [
        "assignmentCommentNodeId",
        "leaseId",
        "parentIssueNodeId",
        "parentIssueNumber",
        "slotId",
        "taskIssueNodeId",
        "taskIssueNumber",
        "workResult",
        "agentId",
      ].sort(),
    );
    for (const optional of [
      "feedbackCommentNodeId",
      "feedbackUpdatedAt",
      "resultCommentNodeId",
      "resultBodyDigest",
    ]) {
      assert.equal(resultTool.inputSchema.required.includes(optional), false);
    }
    assert.equal("acquiredAt" in resultTool.inputSchema.properties, false);
    assert.equal("expiresAt" in resultTool.inputSchema.properties, false);
    assert.deepEqual(
      [...workflowResultTool.inputSchema.required].sort(),
      [
        ...Object.keys(baseInput()),
        "workResult",
        ...Object.keys(activeLeaseInput()),
      ].sort(),
    );
    assert.equal(
      "feedbackCommentNodeId" in workflowResultTool.inputSchema.properties,
      false,
    );
  });
});

test("verified Result snapshot supplies the acceptor digest", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment(), resultComment(PASS_RESULT)],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.acceptance,
        "get_result_snapshot",
        baseInput(),
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
          ],
        },
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

test("Acceptance reviews and digest-binds the lease-bound Result/v1", async () => {
  const result = leasedResult(PASS_RESULT);
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          assignmentComment(),
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
      agentId: "issue-validator",
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
      formatAssignment("issue-validator"),
    );
    assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 0);
  });
});

test("workflow Assignment validates the nested manifest and is idempotent", async () => {
  const child = makeWorkflowTask(WORKFLOW_TITLE_PAYLOAD);
  const parent = makeWorkflowTask(WORKFLOW_PARENT_PAYLOAD, {
    number: PARENT_NUMBER,
    nodeId: PARENT_NODE,
    id: 107,
  });
  await withFake(
    { tasks: [child], parentIssue: parent },
    async (fake) => {
      const input = {
        ...baseInput(child),
        agentId: "issue-title-validator",
      };
      const first = await runTool(
        fake,
        IDS.assignment,
        "submit_workflow_task_assignment",
        input,
      );
      assert.equal(first.result.isError, false);
      const second = await runTool(
        fake,
        IDS.assignment,
        "submit_workflow_task_assignment",
        input,
      );
      assert.equal(second.result.structuredContent.reconciled, true);
      assert.equal(
        fake.state.comments.get(TASK_NUMBER)[0].body,
        formatWorkflowAssignment("issue-title-validator"),
      );
      assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 0);
    },
  );
});

test("workflow Assignment accepts a composite evaluator under a principal Issue", async () => {
  const composite = makeWorkflowTask(WORKFLOW_PARENT_PAYLOAD);
  await withFake({ tasks: [composite] }, async (fake) => {
    const response = await runTool(
      fake,
      IDS.assignment,
      "submit_workflow_task_assignment",
      {
        ...baseInput(composite),
        agentId: "issue-validation-evaluator",
      },
    );
    assert.equal(response.result.isError, false);
    assert.equal(
      fake.state.comments.get(TASK_NUMBER)[0].body,
      formatWorkflowAssignment("issue-validation-evaluator"),
    );
  });
});

test("workflow Assignment rejects stale children and manifest agent changes", async () => {
  const parent = makeWorkflowTask(WORKFLOW_PARENT_PAYLOAD, {
    number: PARENT_NUMBER,
    nodeId: PARENT_NODE,
    id: 107,
  });
  const staleChild = makeWorkflowTask({
    ...WORKFLOW_TITLE_PAYLOAD,
    inputs: { ...WORKFLOW_TITLE_PAYLOAD.inputs, generation: 2 },
  });
  await withFake(
    { tasks: [staleChild], parentIssue: parent },
    async (fake) => {
      const stale = await runTool(
        fake,
        IDS.assignment,
        "submit_workflow_task_assignment",
        {
          ...baseInput(staleChild),
          agentId: "issue-title-validator",
        },
      );
      assert.equal(stale.result.isError, true);
      assert.match(stale.result.content[0].text, /generation must match/);
      assert.equal(fake.state.comments.get(TASK_NUMBER).length, 0);
    },
  );

  const child = makeWorkflowTask(WORKFLOW_TITLE_PAYLOAD);
  await withFake(
    { tasks: [child], parentIssue: parent },
    async (fake) => {
      const wrongAgent = await runTool(
        fake,
        IDS.assignment,
        "submit_workflow_task_assignment",
        {
          ...baseInput(child),
          agentId: "issue-body-validator",
        },
      );
      assert.equal(wrongAgent.result.isError, true);
      assert.match(wrongAgent.result.content[0].text, /does not match/);
      assert.equal(fake.state.comments.get(TASK_NUMBER).length, 0);
    },
  );
});

test("assignment config requires only its shared actors", async () => {
  const input = {
    ...baseInput(),
    agentId: "issue-validator",
  };
  const unrelated = [
    "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
    "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
  ];
  await withFake({}, async (fake) => {
    const first = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      input,
      { unsetEnv: unrelated },
    );
    assert.equal(first.result.isError, false);
    const second = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      input,
      { unsetEnv: unrelated },
    );
    assert.equal(second.result.structuredContent.reconciled, true);
    assert.equal(
      fake.state.comments.get(TASK_NUMBER)[0].body,
      formatAssignment("issue-validator"),
    );
  });
  for (const key of [
    "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
    "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
  ]) {
    await withFake({}, async (fake) => {
      const response = await runTool(
        fake,
        IDS.assignment,
        "submit_task_assignment",
        input,
        { unsetEnv: [key] },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, new RegExp(key));
      assert.equal(fake.state.comments.get(TASK_NUMBER).length, 0);
    });
  }
});

test("each reporter path fails closed when any required config value is missing", async () => {
    const common = [
      "COPILOT_MCP_WORKGRAPH_TOKEN",
      "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID",
      "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
    ];
    const assignment = "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID";
    const result = "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID";
    const acceptance = "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID";
    const orchestrator = "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID";
    const info = "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID";
    const feedback = "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID";
    const lease = [
      "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
      "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
    ];
    const resultInput = {
      ...baseInput(),
      ...activeLeaseInput(),
      workResult: leasedResult(PASS_RESULT),
    };
    const cases = [
      {
        name: "Assignment",
        actor: IDS.assignment,
        tool: "submit_task_assignment",
        input: {
          ...baseInput(),
          agentId: "issue-validator",
        },
        required: [...common, assignment],
      },
      {
        name: "workflow Assignment",
        actor: IDS.assignment,
        tool: "submit_workflow_task_assignment",
        input: {
          ...baseInput(),
          agentId: "issue-title-validator",
        },
        required: [...common, assignment],
      },
      {
        name: "Result snapshot",
        actor: IDS.acceptance,
        tool: "get_result_snapshot",
        input: baseInput(),
        required: [...common, assignment, result, acceptance],
      },
      {
        name: "Acceptance",
        actor: IDS.acceptance,
        tool: "submit_result_acceptance",
        input: {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: `sha256:${"0".repeat(64)}`,
          summary: "Reviewed.",
        },
        required: [...common, assignment, result, acceptance],
      },
      {
        name: "Feedback",
        actor: IDS.feedback,
        tool: "submit_task_feedback",
        input: {
          ...baseInput(),
          resultCommentNodeId: "IC_result",
          resultBodyDigest: `sha256:${"0".repeat(64)}`,
          feedback: "Revise.",
        },
        required: [...common, assignment, result, feedback],
      },
      {
        name: "Result",
        actor: IDS.result,
        tool: "submit_task_result",
        input: resultInput,
        required: [...common, assignment, result, ...lease],
      },
      {
        name: "workflow Result",
        actor: IDS.result,
        tool: "submit_workflow_task_result",
        input: {
          ...baseInput(),
          ...activeLeaseInput(WORKFLOW_LEASE),
          workResult: {
            taskType: "workflow-task",
            leaseId: WORKFLOW_LEASE.leaseId,
            outcome: "succeeded",
            summary: "Title validation completed.",
            result: { passed: true },
          },
        },
        required: [...common, assignment, result, ...lease],
      },
      {
        name: "feedback Result revision",
        actor: IDS.result,
        tool: "submit_task_result",
        input: {
          ...resultInput,
          feedbackCommentNodeId: "IC_feedback",
          feedbackUpdatedAt: "2026-08-18T23:00:00Z",
          resultCommentNodeId: "IC_result",
          resultBodyDigest: `sha256:${"0".repeat(64)}`,
        },
        required: [...common, assignment, result, feedback, ...lease],
      },
      {
        name: "request-info Result",
        actor: IDS.result,
        tool: "submit_task_result",
        input: {
          ...resultInput,
          workResult: {
            taskType: "request-info",
            leaseId: INFO_LEASE.leaseId,
            outcome: "succeeded",
            summary: "Requested information.",
            result: { requestCommentNodeId: "IC_info" },
          },
        },
        required: [...common, assignment, result, info, ...lease],
      },
      {
        name: "parent info request",
        actor: IDS.info,
        tool: "post_parent_info_request",
        input: {
          ...baseInput(),
          validationTaskIssueNumber: 18,
          validationTaskIssueNodeId: "I_validation",
          validationResultCommentNodeId: "IC_result",
          ...activeLeaseInput(),
        },
        required: [
          ...common,
          assignment,
          result,
          acceptance,
          info,
          ...lease,
        ],
      },
      {
        name: "transition",
        actor: IDS.orchestrator,
        tool: "transition_issue",
        input: {
          parentIssueNumber: PARENT_NUMBER,
          parentIssueNodeId: PARENT_NODE,
          expectedStatus: "status:new",
          transition: "start-validation",
        },
        required: [
          ...common,
          assignment,
          result,
          acceptance,
          orchestrator,
          info,
          feedback,
        ],
      },
    ];
    for (const scenario of cases) {
      for (const key of scenario.required) {
        await withFake({}, async (fake) => {
          const response = await runTool(
            fake,
            scenario.actor,
            scenario.tool,
            scenario.input,
            { unsetEnv: [key] },
          );
          assert.equal(response.result.isError, true, `${scenario.name}: ${key}`);
          assert.match(
            response.result.content[0].text,
            new RegExp(key),
            `${scenario.name}: ${key}`,
          );
          assert.deepEqual(fake.state.operations, []);
        });
      }
    }
});

test("Result Lease and feedback bindings are exact and fail before GitHub reads", async () => {
    const complete = {
      ...baseInput(),
      ...activeLeaseInput(),
      workResult: leasedResult(PASS_RESULT),
    };
    for (const key of [
      "assignmentCommentNodeId",
      "leaseId",
      "agentId",
      "slotId",
    ]) {
      await withFake({}, async (fake) => {
        const input = { ...complete };
        delete input[key];
        const response = await runTool(
          fake,
          IDS.result,
          "submit_task_result",
          input,
        );
        assert.equal(response.result.isError, true, key);
        assert.match(response.result.content[0].text, /properties must be exactly/);
        assert.deepEqual(fake.state.operations, []);
      });
    }
    await withFake({}, async (fake) => {
      const response = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        { ...complete, unexpectedLeaseField: "nope" },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /properties must be exactly/);
      assert.deepEqual(fake.state.operations, []);
    });
    await withFake({}, async (fake) => {
      const response = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        { ...complete, feedbackCommentNodeId: "IC_feedback" },
      );
      assert.equal(response.result.isError, true);
      assert.match(
        response.result.content[0].text,
        /feedback dispatch fields must be supplied together/,
      );
      assert.deepEqual(fake.state.operations, []);
    });
});

test("assignment rejects wrong target mapping and foreign author", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          makeComment(
            formatAssignment("issue-validator"),
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
          agentId: "issue-validator",
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
          agentId: "issue-info-requester",
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /does not match taskType/);
    },
  );
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [
          makeComment(
            'WorkGraphTaskAssignment/v1\n\n```json\n{\n  "agentProfile": "issue-validator",\n  "workerId": "legacy"\n}\n```\n',
            IDS.assignment,
            "IC_assignment",
            201,
          ),
        ],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.assignment,
        "submit_task_assignment",
        { ...baseInput(), agentId: "issue-validator" },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /malformed|conflicting/);
    },
  );
});

test("assignment rejects absent agents and malformed authoritative config", async () => {
  await withFake(
    {
      agentConfig:
        "version: 1\nagents:\n" +
        "  - agentId: issue-info-requester\n" +
        "    slots: 1\n" +
        "    leaseDuration: PT30M\n",
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.assignment,
        "submit_task_assignment",
        { ...baseInput(), agentId: "issue-validator" },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /absent from authoritative config/);
    },
  );
  await withFake({ agentConfig: "version: 1\nagents: []\n" }, async (fake) => {
    const response = await runTool(
      fake,
      IDS.assignment,
      "submit_task_assignment",
      { ...baseInput(), agentId: "issue-validator" },
    );
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /agent config/);
  });
});

test("workflow Result validates nested context and the active Source Lease", async () => {
  const child = makeWorkflowTask(WORKFLOW_TITLE_PAYLOAD);
  const parent = makeWorkflowTask(WORKFLOW_PARENT_PAYLOAD, {
    number: PARENT_NUMBER,
    nodeId: PARENT_NODE,
    id: 107,
  });
  const workResult = {
    taskType: "workflow-task",
    leaseId: WORKFLOW_LEASE.leaseId,
    outcome: "succeeded",
    summary: "Title validation completed.",
    result: {
      field: "title",
      passed: true,
      evidence: "The title is non-empty.",
    },
  };
  await withFake(
    {
      tasks: [child],
      parentIssue: parent,
      comments: {
        [TASK_NUMBER]: [workflowAssignmentComment()],
      },
      activeLease: {
        ...WORKFLOW_LEASE,
        taskNodeId: TASK_NODE,
        taskType: "workflow-task",
      },
    },
    async (fake) => {
      const input = {
        ...baseInput(child),
        ...activeLeaseInput(WORKFLOW_LEASE),
        workResult,
      };
      const first = await runTool(
        fake,
        IDS.result,
        "submit_workflow_task_result",
        input,
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
          ],
        },
      );
      assert.equal(first.result.isError, false);
      assert.equal(
        fake.state.comments.get(TASK_NUMBER).at(-1).body,
        formatWorkflowResult(workResult),
      );
      const write = fake.state.operations.findIndex(
        (operation) =>
          operation ===
          "POST /repos/drasi-project/drasi-workgraph-demo/issues/17/comments",
      );
      assert.equal(fake.state.operations[write - 1], "POST /lease/validate");

      const duplicate = await runTool(
        fake,
        IDS.result,
        "submit_workflow_task_result",
        input,
      );
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      assert.equal(
        fake.state.operations.filter(
          (operation) => operation === "POST /lease/validate",
        ).length,
        1,
      );

      const conflicting = await runTool(
        fake,
        IDS.result,
        "submit_workflow_task_result",
        {
          ...input,
          workResult: {
            ...workResult,
            summary: "A conflicting result.",
          },
        },
      );
      assert.equal(conflicting.result.isError, true);
      assert.match(conflicting.result.content[0].text, /conflicting Result/);
    },
  );
});

test("Result/v1 validates the Source Lease immediately before write and reconciles retries", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment()],
      },
    },
    async (fake) => {
      const result = leasedResult(FAIL_RESULT);
      const input = {
        ...baseInput(),
        ...activeLeaseInput(),
        workResult: result,
      };
      const first = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        input,
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
          ],
        },
      );
      assert.equal(first.result.isError, false);
      assert.equal(first.result.structuredContent.revised, false);
      const write = fake.state.operations.findIndex(
        (operation) => operation === "POST /repos/drasi-project/drasi-workgraph-demo/issues/17/comments",
      );
      assert.equal(fake.state.operations[write - 1], "POST /lease/validate");
      const duplicate = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      assert.equal(
        fake.state.operations.filter((operation) => operation === "POST /lease/validate").length,
        1,
      );
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
      assert.match(revised.result.content[0].text, /only after feedback/);
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
        [TASK_NUMBER]: [assignmentComment()],
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

test("Result rejects expired and Source-rejected Leases without writing", async () => {
  const expiredLease = {
    ...ACTIVE_LEASE,
    acquiredAt: "2026-08-18T23:00:00Z",
    expiresAt: "2026-08-18T23:59:59Z",
  };
  const cases = [
    {
      name: "expired",
      input: activeLeaseInput(),
      options: {
        leaseValidationResponse: {
          ...expiredLease,
          taskNodeId: TASK_NODE,
          taskType: "validate-issue",
        },
      },
      expected: /expired/,
      validates: true,
    },
    {
      name: "Source mismatch",
      input: { ...activeLeaseInput(), slotId: "issue-validator/2" },
      options: {},
      expected: /HTTP 409/,
      validates: true,
    },
    {
      name: "wrong assignment",
      input: {
        ...activeLeaseInput(),
        assignmentCommentNodeId: "IC_other_assignment",
      },
      options: {},
      expected: /exact Assignment\/v1/,
      validates: false,
    },
    {
      name: "Source unauthorized",
      input: activeLeaseInput(),
      options: { leaseValidationStatus: 401 },
      expected: /HTTP 401/,
      validates: true,
    },
    {
      name: "Source unavailable",
      input: activeLeaseInput(),
      options: { leaseValidationStatus: 503 },
      expected: /HTTP 503/,
      validates: true,
    },
    {
      name: "Source response mismatch",
      input: activeLeaseInput(),
      options: {
        leaseValidationResponse: {
          ...ACTIVE_LEASE,
          taskNodeId: TASK_NODE,
          taskType: "request-info",
        },
      },
      expected: /does not match the dispatch/,
      validates: true,
    },
    {
      name: "Source response extra field",
      input: activeLeaseInput(),
      options: {
        leaseValidationResponse: {
          ...ACTIVE_LEASE,
          taskNodeId: TASK_NODE,
          taskType: "validate-issue",
          internalSlotNumber: 1,
        },
      },
      expected: /properties must be exactly/,
      validates: true,
    },
  ];
  for (const scenario of cases) {
    await withFake(
      {
        ...scenario.options,
        comments: {
          [TASK_NUMBER]: [assignmentComment()],
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
        assert.equal(fake.state.comments.get(TASK_NUMBER).length, 1);
        assert.equal(
          fake.state.operations.includes("POST /lease/validate"),
          scenario.validates,
          scenario.name,
        );
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
            formatAssignment("issue-validator"),
            999,
            "IC_assignment",
            201,
          ),
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
          [TASK_NUMBER]: [assignmentComment()],
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
      activeLease: {
        ...INFO_LEASE,
        taskNodeId: "I_request",
        taskType: "request-info",
      },
      comments: {
        17: [
          assignmentComment(),
          resultComment(FAIL_RESULT),
          acceptanceComment(FAIL_RESULT),
        ],
        18: [
          assignmentComment(
            "issue-info-requester",
            "IC_assignment_request",
          ),
        ],
      },
    },
    async (fake) => {
      const infoInput = {
        ...baseInput(request),
        validationTaskIssueNumber: 17,
        validationTaskIssueNodeId: TASK_NODE,
        validationResultCommentNodeId: "IC_result",
        ...activeLeaseInput(INFO_LEASE),
      };
      const first = await runTool(
        fake,
        IDS.info,
        "post_parent_info_request",
        infoInput,
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
          ],
        },
      );
      assert.equal(first.result.isError, false);
      const parentWrite = fake.state.operations.findIndex(
        (operation) => operation ===
          "POST /repos/drasi-project/drasi-workgraph-demo/issues/7/comments",
      );
      assert.equal(fake.state.operations[parentWrite - 1], "POST /lease/validate");
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
      assert.equal(
        fake.state.operations.filter((operation) => operation === "POST /lease/validate").length,
        1,
      );

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
      const submitted = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        {
          ...baseInput(request),
          ...activeLeaseInput(INFO_LEASE),
          workResult: infoResult,
        },
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
          ],
        },
      );
      assert.equal(submitted.result.isError, false);
      const resultWrite = fake.state.operations.findLastIndex(
        (operation) => operation ===
          "POST /repos/drasi-project/drasi-workgraph-demo/issues/18/comments",
      );
      assert.equal(fake.state.operations[resultWrite - 1], "POST /lease/validate");
      assert.equal(
        fake.state.operations.filter((operation) => operation === "POST /lease/validate").length,
        2,
      );
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
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
          ],
        },
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
          {
            unsetEnv: [
              "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
              "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
            ],
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

test("feedback is idempotent and does not allocate a Lease", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment(), resultComment(PASS_RESULT)],
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
        IDS.feedback,
        "submit_task_feedback",
        input,
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
            "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
          ],
        },
      );
      assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
      assert.deepEqual(Object.keys(first.result.structuredContent).sort(), [
        "feedbackCommentNodeId",
        "reconciled",
        "resultBodyDigest",
        "revised",
      ]);
      const duplicate = await runTool(
        fake,
        IDS.feedback,
        "submit_task_feedback",
        input,
      );
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      const stale = await runTool(
        fake,
        IDS.feedback,
        "submit_task_feedback",
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
          ...activeLeaseInput(INFO_LEASE),
        },
      );
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /one canonical Assignment/);
      assert.equal(fake.state.comments.get(PARENT_NUMBER).length, 0);
    },
  );
});

test("feedback revision requires a newly Source-validated active Lease", async () => {
  await withFake(
    {
      comments: {
        [TASK_NUMBER]: [assignmentComment(), resultComment(PASS_RESULT)],
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
        IDS.feedback,
        "submit_task_feedback",
        input,
      );
      assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
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
        {
          unsetEnv: [
            "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
            "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
            "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
          ],
        },
      );
      assert.equal(revisedResultResponse.result.isError, false);
      const patch = fake.state.operations.findLastIndex(
        (operation) => operation ===
          "PATCH /repos/drasi-project/drasi-workgraph-demo/issues/comments/202",
      );
      assert.equal(fake.state.operations[patch - 1], "POST /lease/validate");
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

test("Result/Acceptance writes fail closed on races", async () => {
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
