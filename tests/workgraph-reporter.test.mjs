import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { formatRuntimeTask } from "../.github/mcp/workgraph-v1-definition.mjs";
import {
  callTool,
  deriveWorkGraphRootIssueContentDigest,
  deriveWorkGraphRootTaskId,
  deriveWorkGraphTaskResultId,
  deriveWorkGraphWorkflowRunId,
  formatTaskDispatch,
  formatTaskResult,
  parseTaskResult,
  tools,
  validateLeaseValidationUrl,
} from "../.github/mcp/workgraph-reporter.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTER = path.join(ROOT, ".github/mcp/workgraph-reporter.mjs");
const OWNER = "drasi-project";
const REPO = "drasi-workgraph-demo";
const REPOSITORY_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TYPE_ID = "IT_workgraph";
const LAUNCHER_ID = 101;
const ASSIGNMENT_ID = 102;
const RESULT_ID = 103;
const REPOSITORY_NODE_ID = "R_demo";
const ROOT_ISSUE_ID = "I_root_issue";
const ROOT_ISSUE_NUMBER = 42;
const ROOT_TASK_NUMBER = 100;
const ROOT_TASK_NODE_ID = "I_root_task";
const CHILD_TASK_NUMBER = 101;
const CHILD_TASK_NODE_ID = "I_child_task";
const ADMISSION_ID = "admission-1";
const DEFINITION_DIGEST = `sha256:${"a".repeat(64)}`;
const ROOT_TITLE = "Validate this Issue";
const ROOT_BODY = "The body to validate.";

function fixture() {
  const contentDigest = deriveWorkGraphRootIssueContentDigest(
    ROOT_TITLE,
    ROOT_BODY,
  );
  const workflowRunId = deriveWorkGraphWorkflowRunId(
    REPOSITORY_NODE_ID,
    ROOT_ISSUE_ID,
    ADMISSION_ID,
    "demo-issue-lifecycle",
    "v1",
    DEFINITION_DIGEST,
  );
  const rootTaskId = deriveWorkGraphRootTaskId(
    workflowRunId,
    "demo-root-v1",
  );
  const rootTask = {
    taskId: rootTaskId,
    rootIssueId: ROOT_ISSUE_ID,
    workflowRunId,
    workflowDefinitionId: "demo-issue-lifecycle",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: DEFINITION_DIGEST,
    taskDefinitionId: "demo-root-v1",
    resolvedInputs: {
      proofMode: "isolated",
      rootIssue: {
        repositoryOwner: OWNER,
        repositoryName: REPO,
        repositoryNodeId: REPOSITORY_NODE_ID,
        issueNumber: ROOT_ISSUE_NUMBER,
        issueNodeId: ROOT_ISSUE_ID,
        admissionId: ADMISSION_ID,
        contentDigest,
      },
    },
  };
  const childTask = {
    taskId: "demo-validate-task",
    rootIssueId: ROOT_ISSUE_ID,
    workflowRunId,
    workflowDefinitionId: "demo-issue-lifecycle",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: DEFINITION_DIGEST,
    taskDefinitionId: "demo-validate-v1",
    resolvedInputs: { validationProfile: "new-issue-default" },
  };
  const identity = (task) => ({
    taskId: task.taskId,
    workflowRunId: task.workflowRunId,
    workflowDefinitionId: task.workflowDefinitionId,
    workflowDefinitionVersion: task.workflowDefinitionVersion,
    workflowDefinitionDigest: task.workflowDefinitionDigest,
    taskDefinitionId: task.taskDefinitionId,
  });
  const dispatch = (task, executorId) => ({
    dispatchId: `dispatch-${task.taskId}`,
    launchId: `launch-${task.taskId}`,
    task: identity(task),
    lease: {
      leaseId: `lease-${task.taskId}`,
      assignmentId: `assignment-${task.taskId}`,
      executorId,
      slotId: `${executorId}-slot-1`,
    },
  });
  return {
    contentDigest,
    workflowRunId,
    rootTask,
    childTask,
    rootDispatch: dispatch(rootTask, "demo-orchestrator"),
    childDispatch: dispatch(childTask, "issue-validator"),
  };
}

function taskIssue(number, nodeId, task) {
  return {
    number,
    node_id: nodeId,
    repository_url: REPOSITORY_URL,
    state: "open",
    title: `Task ${number}`,
    body: formatRuntimeTask(task),
    type: { name: "WorkGraphTask", node_id: TYPE_ID },
    user: { id: LAUNCHER_ID, login: "launcher" },
  };
}

function rootIssue({ stale = false } = {}) {
  return {
    number: ROOT_ISSUE_NUMBER,
    node_id: ROOT_ISSUE_ID,
    repository_url: REPOSITORY_URL,
    state: "open",
    title: stale ? `${ROOT_TITLE} changed` : ROOT_TITLE,
    body: ROOT_BODY,
    labels: [{ name: "workgraph" }],
    type: null,
    user: { id: 999, login: "author" },
  };
}

async function requestBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : null;
}

async function withFakeRuntime(options, callback) {
  const data = fixture();
  const root = rootIssue({ stale: options.staleRootIssue === true });
  if (options.rootAdmitted === false) root.labels = [];
  const rootTask = taskIssue(
    ROOT_TASK_NUMBER,
    ROOT_TASK_NODE_ID,
    data.rootTask,
  );
  if (options.rootTaskClosed === true) rootTask.state = "closed";
  const childTask = taskIssue(
    CHILD_TASK_NUMBER,
    CHILD_TASK_NODE_ID,
    data.childTask,
  );
  if (options.childTaskClosed === true) childTask.state = "closed";
  const issues = new Map([
    [ROOT_ISSUE_NUMBER, root],
    [ROOT_TASK_NUMBER, rootTask],
    [CHILD_TASK_NUMBER, childTask],
  ]);
  const comments = new Map([
    [
      ROOT_TASK_NUMBER,
      [
        {
          id: 200,
          node_id: "IC_root_dispatch",
          body: formatTaskDispatch(data.rootDispatch),
          user: { id: ASSIGNMENT_ID, login: "assigner" },
          created_at: "2026-08-29T20:00:00Z",
          updated_at: "2026-08-29T20:00:00Z",
        },
      ],
    ],
    [
      CHILD_TASK_NUMBER,
      [
        ...(options.staleDispatch === true
          ? [
              {
                id: 199,
                node_id: "IC_stale_child_dispatch",
                body: formatTaskDispatch({
                  ...data.childDispatch,
                  dispatchId: "dispatch-stale",
                  launchId: "launch-stale",
                  lease: {
                    ...data.childDispatch.lease,
                    leaseId: "lease-stale",
                  },
                }),
                user: { id: ASSIGNMENT_ID, login: "assigner" },
                created_at: "2026-08-29T20:00:00Z",
                updated_at: "2026-08-29T20:00:00Z",
              },
            ]
          : []),
        {
          id: 201,
          node_id: "IC_child_dispatch",
          body: formatTaskDispatch(data.childDispatch),
          user: { id: ASSIGNMENT_ID, login: "assigner" },
          created_at: "2026-08-29T20:00:00Z",
          updated_at:
            options.editedDispatch === true
              ? "2026-08-29T20:01:00Z"
              : "2026-08-29T20:00:00Z",
        },
      ],
    ],
  ]);
  if (options.historicalResult === true) {
    const historicalDispatch = {
      ...data.childDispatch,
      dispatchId: "dispatch-stale",
      launchId: "launch-stale",
      lease: {
        ...data.childDispatch.lease,
        leaseId: "lease-stale",
      },
    };
    comments.get(CHILD_TASK_NUMBER).push({
      id: 198,
      node_id: "IC_stale_child_result",
      body: formatTaskResult({
        resultId: deriveWorkGraphTaskResultId(
          data.childTask.taskId,
          historicalDispatch.dispatchId,
          historicalDispatch.lease.leaseId,
        ),
        taskId: data.childTask.taskId,
        dispatchId: historicalDispatch.dispatchId,
        leaseId: historicalDispatch.lease.leaseId,
        outcome: "cancelled",
        output: { summary: "expired attempt" },
      }),
      user: { id: RESULT_ID, login: "result-reporter" },
      created_at: "2026-08-29T20:30:00Z",
      updated_at: "2026-08-29T20:30:00Z",
    });
  }
  const state = { claims: new Map(), leaseRequests: [], writes: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/user") {
      return send(200, { id: RESULT_ID, login: "result-reporter" });
    }
    if (
      request.method === "GET" &&
      url.pathname === `/repos/${OWNER}/${REPO}`
    ) {
      return send(200, {
        name: REPO,
        owner: { login: OWNER },
        node_id: REPOSITORY_NODE_ID,
      });
    }
    const issueMatch = url.pathname.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/issues/(\\d+)$`),
    );
    if (request.method === "GET" && issueMatch) {
      return send(200, issues.get(Number(issueMatch[1])));
    }
    const parentMatch = url.pathname.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/issues/(\\d+)/parent$`),
    );
    if (request.method === "GET" && parentMatch) {
      const number = Number(parentMatch[1]);
      const parent =
        number === CHILD_TASK_NUMBER
          ? issues.get(ROOT_TASK_NUMBER)
          : number === ROOT_TASK_NUMBER
            ? issues.get(ROOT_ISSUE_NUMBER)
            : null;
      return parent ? send(200, parent) : send(404, { message: "Not Found" });
    }
    const commentsMatch = url.pathname.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/issues/(\\d+)/comments$`),
    );
    if (request.method === "GET" && commentsMatch) {
      return send(200, comments.get(Number(commentsMatch[1])) ?? []);
    }
    if (request.method === "POST" && commentsMatch) {
      const number = Number(commentsMatch[1]);
      const { body } = await requestBody(request);
      const comment = {
        id: 300 + state.writes.length,
        node_id: `IC_result_${state.writes.length + 1}`,
        body,
        user: { id: RESULT_ID, login: "result-reporter" },
        created_at: "2026-08-29T21:00:00Z",
        updated_at: "2026-08-29T21:00:00Z",
      };
      comments.get(number).push(comment);
      state.writes.push({ number, body });
      return send(201, comment);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/github/workgraph-v1/lease/validate"
    ) {
      const value = await requestBody(request);
      state.leaseRequests.push({
        authorization: request.headers.authorization,
        value,
      });
      const existingClaim = state.claims.get(value.leaseId);
      if (existingClaim && existingClaim !== value.claimId) {
        return send(409, { error: "lease already claimed" });
      }
      state.claims.set(value.leaseId, value.claimId);
      return send(200, {
        ...value,
        ...(options.leaseResponse ?? {}),
        acquiredAt: "2026-08-29T20:00:00Z",
        expiresAt: "2026-08-29T22:00:00Z",
      });
    }
    return send(404, { message: `Unhandled ${request.method} ${url.pathname}` });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    WORKGRAPH_TEST_NOW: "2026-08-29T21:00:00Z",
    WORKGRAPH_TEST_GITHUB_API_URL: origin,
    COPILOT_MCP_WORKGRAPH_TOKEN: "github-token",
    COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: TYPE_ID,
    COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID: String(LAUNCHER_ID),
    COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID: String(ASSIGNMENT_ID),
    COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID: String(RESULT_ID),
    COPILOT_MCP_WORKGRAPH_EXECUTOR_ID:
      options.executorId ?? "issue-validator",
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL:
      `${origin}/github/workgraph-v1/lease/validate`,
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN: "lease-token",
  });
  try {
    await callback({ data, state });
  } finally {
    process.env = previous;
    server.close();
    await once(server, "close");
  }
}

function childLocator() {
  return {
    repositoryOwner: OWNER,
    repositoryName: REPO,
    repositoryNodeId: REPOSITORY_NODE_ID,
    issueNumber: CHILD_TASK_NUMBER,
    issueNodeId: CHILD_TASK_NODE_ID,
    parentIssueNumber: ROOT_TASK_NUMBER,
    parentIssueNodeId: ROOT_TASK_NODE_ID,
  };
}

function rootLocator() {
  return {
    repositoryOwner: OWNER,
    repositoryName: REPO,
    repositoryNodeId: REPOSITORY_NODE_ID,
    issueNumber: ROOT_TASK_NUMBER,
    issueNodeId: ROOT_TASK_NODE_ID,
    parentIssueNumber: ROOT_ISSUE_NUMBER,
    parentIssueNodeId: ROOT_ISSUE_ID,
  };
}

function resultInput(task, dispatch, locator) {
  return {
    taskLocator: locator,
    taskId: task.taskId,
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.lease.leaseId,
    outcome: "succeeded",
    output: { summary: "done", details: { ok: true } },
  };
}

test("v1 Result identity and body match the kernel vector", () => {
  const resultId = deriveWorkGraphTaskResultId(
    "task-1",
    "dispatch-1",
    "lease-1",
  );
  assert.equal(
    resultId,
    "workgraph-v1:result:sha256:4fcd8917e2144ba5787b5b224c1ab293ac7b1027b52a946cbf188a97a0696755",
  );
  const body = formatTaskResult({
    resultId,
    taskId: "task-1",
    dispatchId: "dispatch-1",
    leaseId: "lease-1",
    outcome: "succeeded",
    output: { z: 1, a: true },
  });
  assert.deepEqual(parseTaskResult(body), {
    resultId,
    taskId: "task-1",
    dispatchId: "dispatch-1",
    leaseId: "lease-1",
    outcome: "succeeded",
    output: { a: true, z: 1 },
  });
  assert.equal(parseTaskResult(body.replace('  "taskId"', ' "taskId"')), null);
  assert.equal(parseTaskResult(body.replace("/v1", "/v2")), null);
});

test("Result output enforces the kernel JSON data domain", () => {
  const base = {
    resultId: deriveWorkGraphTaskResultId("task-1", "dispatch-1", "lease-1"),
    taskId: "task-1",
    dispatchId: "dispatch-1",
    leaseId: "lease-1",
    outcome: "succeeded",
  };
  let tooDeep = null;
  for (let depth = 0; depth < 33; depth += 1) tooDeep = [tooDeep];
  assert.doesNotThrow(() =>
    formatTaskResult({
      ...base,
      output: { value: Number.MAX_SAFE_INTEGER },
    }),
  );
  for (const output of [
    { value: -0 },
    { value: Number.MAX_SAFE_INTEGER + 1 },
    { "": true },
    { value: "carriage\rreturn" },
    { value: "reserved ``` fence" },
    tooDeep,
  ]) {
    assert.throws(() => formatTaskResult({ ...base, output }));
  }
});

test("only the exact v1 lease endpoint is accepted", () => {
  process.env.NODE_ENV = "test";
  assert.equal(
    validateLeaseValidationUrl(
      "http://127.0.0.1:9100/github/workgraph-v1/lease/validate",
    ),
    "http://127.0.0.1:9100/github/workgraph-v1/lease/validate",
  );
  assert.throws(
    () =>
      validateLeaseValidationUrl(
        "http://127.0.0.1:9100/github/workgraph/lease/validate",
      ),
    /workgraph-v1/,
  );
});

test("MCP exposes only the Root Issue reader and Result writer", async () => {
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["get_root_issue", "submit_task_result"],
  );
  const child = spawn(process.execPath, [REPORTER], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  child.stdin.end();
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.deepEqual(
    responses[1].result.tools.map(({ name }) => name),
    ["get_root_issue", "submit_task_result"],
  );
});

test("get_root_issue verifies child, Root Task, admission, and Root Issue", async () => {
  await withFakeRuntime({}, async ({ data }) => {
    const result = await callTool("get_root_issue", {
      taskLocator: childLocator(),
      taskId: data.childTask.taskId,
    });
    assert.equal(result.taskId, data.childTask.taskId);
    assert.equal(result.rootTaskId, data.rootTask.taskId);
    assert.equal(result.rootIssueId, ROOT_ISSUE_ID);
    assert.equal(result.workflowRunId, data.workflowRunId);
    assert.deepEqual(result.rootIssue, {
      repositoryOwner: OWNER,
      repositoryName: REPO,
      repositoryNodeId: REPOSITORY_NODE_ID,
      issueNumber: ROOT_ISSUE_NUMBER,
      issueNodeId: ROOT_ISSUE_ID,
      admissionId: ADMISSION_ID,
      contentDigest: data.contentDigest,
      title: ROOT_TITLE,
      body: ROOT_BODY,
    });
  });
});

test("Root Issue admission label is required on every read and Result", async () => {
  await withFakeRuntime(
    { rootAdmitted: false },
    async ({ data, state }) => {
      await assert.rejects(
        callTool("get_root_issue", {
          taskLocator: childLocator(),
          taskId: data.childTask.taskId,
        }),
        /Root Issue is missing, stale/,
      );
      await assert.rejects(
        callTool(
          "submit_task_result",
          resultInput(data.childTask, data.childDispatch, childLocator()),
        ),
        /Root Issue is missing, stale/,
      );
      assert.equal(state.writes.length, 0);
      assert.equal(state.leaseRequests.length, 0);
    },
  );
});

test("get_root_issue requires open validator and Root Task Issues", async () => {
  for (const options of [{ childTaskClosed: true }, { rootTaskClosed: true }]) {
    await withFakeRuntime(options, async ({ data }) => {
      await assert.rejects(
        callTool("get_root_issue", {
          taskLocator: childLocator(),
          taskId: data.childTask.taskId,
        }),
        /requires open validator and Root Task Issues/,
      );
    });
  }
});

test("a new Result requires an open Root Task", async () => {
  await withFakeRuntime(
    { rootTaskClosed: true },
    async ({ data, state }) => {
      await assert.rejects(
        callTool(
          "submit_task_result",
          resultInput(data.childTask, data.childDispatch, childLocator()),
        ),
        /requires open task and Root Task Issues/,
      );
      assert.equal(state.writes.length, 0);
      assert.equal(state.leaseRequests.length, 0);
    },
  );
});

test("submit_task_result validates the exact active lease and reconciles", async () => {
  await withFakeRuntime({}, async ({ data, state }) => {
    const input = resultInput(
      data.childTask,
      data.childDispatch,
      childLocator(),
    );
    const created = await callTool("submit_task_result", input);
    assert.equal(created.reconciled, false);
    assert.equal(state.writes.length, 1);
    assert.match(state.leaseRequests[0].value.claimId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(state.leaseRequests, [
      {
        authorization: "Bearer lease-token",
        value: {
          claimId: state.leaseRequests[0].value.claimId,
          taskId: data.childTask.taskId,
          leaseId: data.childDispatch.lease.leaseId,
          assignmentId: data.childDispatch.lease.assignmentId,
          executorId: "issue-validator",
          slotId: "issue-validator-slot-1",
        },
      },
    ]);
    const retried = await callTool("submit_task_result", input);
    assert.equal(retried.reconciled, true);
    assert.equal(retried.commentNodeId, created.commentNodeId);
    assert.equal(state.writes.length, 1);
    assert.equal(state.leaseRequests.length, 1);
  });
});

test("concurrent Result submissions create at most one comment", async () => {
  await withFakeRuntime({}, async ({ data, state }) => {
    const input = resultInput(
      data.childTask,
      data.childDispatch,
      childLocator(),
    );
    const attempts = await Promise.allSettled([
      callTool("submit_task_result", input),
      callTool("submit_task_result", input),
    ]);
    assert.equal(state.writes.length, 1);
    assert.equal(
      attempts.filter(({ status }) => status === "fulfilled").length >= 1,
      true,
    );
  });
});

test("submit_task_result selects the current Dispatch after an expired attempt", async () => {
  await withFakeRuntime({ staleDispatch: true }, async ({ data, state }) => {
    const created = await callTool(
      "submit_task_result",
      resultInput(data.childTask, data.childDispatch, childLocator()),
    );
    assert.equal(created.reconciled, false);
    assert.equal(state.writes.length, 1);
    assert.equal(
      state.leaseRequests[0].value.leaseId,
      data.childDispatch.lease.leaseId,
    );
  });
});

test("submit_task_result ignores a valid historical Result from an expired attempt", async () => {
  await withFakeRuntime(
    { staleDispatch: true, historicalResult: true },
    async ({ data, state }) => {
      const input = resultInput(
        data.childTask,
        data.childDispatch,
        childLocator(),
      );
      const created = await callTool("submit_task_result", input);
      assert.equal(created.reconciled, false);
      assert.equal(state.writes.length, 1);

      const retried = await callTool("submit_task_result", input);
      assert.equal(retried.reconciled, true);
      assert.equal(retried.commentNodeId, created.commentNodeId);
      assert.equal(state.writes.length, 1);
    },
  );
});

test("Result submission is bound to the configured executor profile", async () => {
  await withFakeRuntime({}, async ({ data, state }) => {
    await assert.rejects(
      callTool(
        "submit_task_result",
        resultInput(data.rootTask, data.rootDispatch, rootLocator()),
      ),
      /executor profile is not authorized/,
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.leaseRequests.length, 0);
  });
});

test("edited Dispatch comments are rejected before lease validation", async () => {
  await withFakeRuntime({ editedDispatch: true }, async ({ data, state }) => {
    await assert.rejects(
      callTool(
        "submit_task_result",
        resultInput(data.childTask, data.childDispatch, childLocator()),
      ),
      /comment is edited/,
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.leaseRequests.length, 0);
  });
});

test("the Root Task reports through the same v1 Result contract", async () => {
  await withFakeRuntime(
    { executorId: "demo-orchestrator" },
    async ({ data, state }) => {
    const result = await callTool(
      "submit_task_result",
      resultInput(data.rootTask, data.rootDispatch, rootLocator()),
    );
    assert.equal(result.reconciled, false);
    assert.equal(state.writes[0].number, ROOT_TASK_NUMBER);
    assert.equal(state.leaseRequests[0].value.executorId, "demo-orchestrator");
    },
  );
});

test("a changed Root Issue is rejected before any write", async () => {
  await withFakeRuntime({ staleRootIssue: true }, async ({ data, state }) => {
    await assert.rejects(
      callTool("get_root_issue", {
        taskLocator: childLocator(),
        taskId: data.childTask.taskId,
      }),
      /changed after admission/,
    );
    assert.equal(state.writes.length, 0);
  });
});

test("a mismatched lease response is rejected before any Result write", async () => {
  await withFakeRuntime(
    { leaseResponse: { assignmentId: "wrong-assignment" } },
    async ({ data, state }) => {
      await assert.rejects(
        callTool(
          "submit_task_result",
          resultInput(data.childTask, data.childDispatch, childLocator()),
        ),
        /does not match the Dispatch/,
      );
      assert.equal(state.writes.length, 0);
    },
  );
});

test("alternate Result fields are rejected before GitHub reads", async () => {
  await withFakeRuntime({}, async ({ data, state }) => {
    await assert.rejects(
      callTool("submit_task_result", {
        ...resultInput(data.childTask, data.childDispatch, childLocator()),
        resultId: "caller-supplied",
      }),
      /properties must be exactly/,
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.leaseRequests.length, 0);
  });
});

test("Result output rejects graph-lossy JSON numbers", async () => {
  await withFakeRuntime({}, async ({ data, state }) => {
    await assert.rejects(
      callTool("submit_task_result", {
        ...resultInput(data.childTask, data.childDispatch, childLocator()),
        output: { value: 1.5 },
      }),
      /JavaScript-safe integers/,
    );
    assert.equal(state.writes.length, 0);
    assert.equal(state.leaseRequests.length, 0);
  });
});
