import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  formatRuntimeTask,
  formatTaskEvaluation,
  formatTaskRoute,
  parseTaskEvaluation,
  parseTaskRoute,
  deriveWorkGraphProtocolId,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import {
  canonicalTaskResultEnvelopeJson,
  callTool,
  deriveWorkGraphRootIssueContentDigest,
  deriveWorkGraphRootTaskId,
  deriveWorkGraphTaskErrorId,
  deriveWorkGraphTaskEvaluationId,
  deriveWorkGraphTaskResultId,
  deriveWorkGraphTaskRouteId,
  deriveWorkGraphWorkflowRunId,
  formatTaskDispatch,
  formatTaskError,
  formatTaskResult,
  parseTaskDispatch,
  parseTaskError,
  parseTaskResult,
  taskResultDigest,
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
const EVALUATION_ID = 104;
const ROUTE_ID = 105;
const REPOSITORY_NODE_ID = "R_workgraph_testbed";
const ROOT_ISSUE_ID = "I_root_issue";
const ROOT_ISSUE_NUMBER = 42;
const ROOT_TASK_NUMBER = 100;
const ROOT_TASK_NODE_ID = "I_root_task";
const CHILD_TASK_NUMBER = 101;
const CHILD_TASK_NODE_ID = "I_child_task";
const RECURSIVE_TASK_NUMBER = 102;
const RECURSIVE_TASK_NODE_ID = "I_recursive_task";
const ADMISSION_ID = deriveWorkGraphProtocolId("admission", [
  ROOT_ISSUE_ID,
  "delivery-1",
]);
const DEFINITION_DIGEST = `sha256:${"a".repeat(64)}`;
const ROOT_TITLE = "Validate this Issue";
const ROOT_BODY = "The body to validate.";
const VECTOR_TASK_ID = deriveWorkGraphProtocolId("task", ["task-1"]);
const fixtureTaskId = (...parts) => deriveWorkGraphProtocolId("task", parts);
const protocolId = (type, seed) => deriveWorkGraphProtocolId(type, [seed]);
const VECTOR_RUN_ID = protocolId("workflow-run", "run-1");
const VECTOR_DISPATCH_ID = protocolId("dispatch", "dispatch-1");
const VECTOR_LEASE_ID = protocolId("lease", "lease-1");
const ROOT_TASK_DEFINITION_ID = protocolId("task-definition", "root-v1");
const CHILD_TASK_DEFINITION_ID = protocolId("task-definition", "validate-v1");
const VECTOR_TASK_DEFINITION_ID = protocolId("task-definition", "task-definition");
const RUST_TASK_ID =
  `urn:drasi:workgraph:id:v1:task:sha256:${"1".repeat(64)}`;
const RUST_RUN_ID =
  `urn:drasi:workgraph:id:v1:workflow-run:sha256:${"1".repeat(64)}`;
const RUST_TASK_DEFINITION_ID =
  `urn:drasi:workgraph:id:v1:task-definition:sha256:${"1".repeat(64)}`;
const RUST_DISPATCH_ID =
  `urn:drasi:workgraph:id:v1:dispatch:sha256:${"b".repeat(64)}`;
const RUST_LEASE_ID =
  `urn:drasi:workgraph:id:v1:lease:sha256:${"d".repeat(64)}`;
const COMPILED = JSON.parse(
  readFileSync(
    new URL(
      "../.github/workgraph/fixtures/v1/issue-lifecycle.expected.json",
      import.meta.url,
    ),
    "utf8",
  ),
).workgraphDefinition;

function fixture() {
  const contentDigest = deriveWorkGraphRootIssueContentDigest(
    ROOT_TITLE,
    ROOT_BODY,
  );
  const workflowRunId = deriveWorkGraphWorkflowRunId(
    REPOSITORY_NODE_ID,
    ROOT_ISSUE_ID,
    ADMISSION_ID,
    "issue-lifecycle",
    "v1",
    DEFINITION_DIGEST,
  );
  const rootTaskId = deriveWorkGraphRootTaskId(
    workflowRunId,
    ROOT_TASK_DEFINITION_ID,
  );
  const rootTask = {
    taskId: rootTaskId,
    rootIssueId: ROOT_ISSUE_ID,
    workflowRunId,
    workflowDefinitionId: "issue-lifecycle",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: DEFINITION_DIGEST,
    taskDefinitionId: ROOT_TASK_DEFINITION_ID,
    taskKey: "root",
    operation: "coordinate-issue",
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
    taskId: fixtureTaskId(
      workflowRunId,
      rootTaskId,
      CHILD_TASK_DEFINITION_ID,
    ),
    rootIssueId: ROOT_ISSUE_ID,
    workflowRunId,
    workflowDefinitionId: "issue-lifecycle",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: DEFINITION_DIGEST,
    taskDefinitionId: CHILD_TASK_DEFINITION_ID,
    taskKey: "validate",
    operation: "validate-issue",
    resolvedInputs: { validationProfile: "new-issue-default" },
  };
  const identity = (task) => ({
    taskId: task.taskId,
    workflowRunId: task.workflowRunId,
    workflowDefinitionId: task.workflowDefinitionId,
    workflowDefinitionVersion: task.workflowDefinitionVersion,
    workflowDefinitionDigest: task.workflowDefinitionDigest,
    taskDefinitionId: task.taskDefinitionId,
    taskKey: task.taskKey,
    operation: task.operation,
  });
  const dispatch = (task, executorId) => ({
    dispatchId: protocolId("dispatch", task.taskId),
    launchId: protocolId("dispatch-launch", task.taskId),
    rootIssueId: task.rootIssueId,
    workflowRunId: task.workflowRunId,
    taskId: task.taskId,
    task: identity(task),
    lease: {
      leaseId: protocolId("lease", task.taskId),
      assignmentId: protocolId("assignment", task.taskId),
      executorId,
      slotId: `${executorId}-slot-1`,
    },
  });
  return {
    contentDigest,
    workflowRunId,
    rootTask,
    childTask,
    rootDispatch: dispatch(rootTask, "issue-coordinator"),
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
                  dispatchId: protocolId("dispatch", "stale"),
                  launchId: protocolId("dispatch-launch", "stale"),
                  lease: {
                    ...data.childDispatch.lease,
                    leaseId: protocolId("lease", "stale"),
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
      dispatchId: protocolId("dispatch", "stale"),
      launchId: protocolId("dispatch-launch", "stale"),
      lease: {
        ...data.childDispatch.lease,
        leaseId: protocolId("lease", "stale"),
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
        rootIssueId: data.childTask.rootIssueId,
        workflowRunId: data.childTask.workflowRunId,
        taskId: data.childTask.taskId,
        task: {
          taskId: data.childTask.taskId,
          workflowRunId: data.childTask.workflowRunId,
          workflowDefinitionId: data.childTask.workflowDefinitionId,
          workflowDefinitionVersion: data.childTask.workflowDefinitionVersion,
          workflowDefinitionDigest: data.childTask.workflowDefinitionDigest,
          taskDefinitionId: data.childTask.taskDefinitionId,
          taskKey: data.childTask.taskKey,
          operation: data.childTask.operation,
        },
        dispatchId: historicalDispatch.dispatchId,
        leaseId: historicalDispatch.lease.leaseId,
        attempt: 1,
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
      const snapshot = {
        ...value,
        attempt:
          options.leaseAttempt ?? (options.staleDispatch === true ? 2 : 1),
        ...(options.leaseResponse ?? {}),
        acquiredAt: "2026-08-29T20:00:00Z",
        expiresAt: "2026-08-29T22:00:00Z",
      };
      if (options.omitLeaseAttempt === true) delete snapshot.attempt;
      return send(200, snapshot);
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

function formatWithClaimedEnvelopeId(format, payload, idKey, canonicalId) {
  const claimedId = payload[idKey];
  const body = format({ ...payload, [idKey]: canonicalId });
  return claimedId === canonicalId
    ? body
    : body.replace(
        `"id": ${JSON.stringify(canonicalId)}`,
        `"id": ${JSON.stringify(claimedId)}`,
      );
}

function lifecycleFixture({
  stepId = "c",
  childKey = null,
  attempt = 1,
  dispatchCount = attempt,
  verdict = null,
  route = null,
  conflictingEvaluation = false,
  staleEvaluation = false,
  persistedEvaluationId = null,
  resultAttempt = attempt,
} = {}) {
  const rootIssueId = ROOT_ISSUE_ID;
  const contentDigest = deriveWorkGraphRootIssueContentDigest(
    ROOT_TITLE,
    ROOT_BODY,
  );
  const workflowRunId = deriveWorkGraphWorkflowRunId(
    REPOSITORY_NODE_ID,
    rootIssueId,
    ADMISSION_ID,
    COMPILED.workflowDefinitionId,
    COMPILED.version,
    COMPILED.digest,
  );
  const rootDefinition = COMPILED.root.taskDefinitionId;
  const sourceDefinition = COMPILED.steps[stepId].taskDefinition;
  const childDefinition = childKey
    ? sourceDefinition.children.find(({ taskKey }) => taskKey === childKey)
    : null;
  const taskDefinition = childDefinition?.taskDefinitionId ??
    sourceDefinition.taskDefinitionId;
  const identity = (taskId, taskDefinitionId) => ({
    taskId,
    workflowRunId,
    workflowDefinitionId: COMPILED.workflowDefinitionId,
    workflowDefinitionVersion: COMPILED.version,
    workflowDefinitionDigest: COMPILED.digest,
    taskDefinitionId,
  });
  const runtimeIdentity = (taskId, definition) => ({
    ...identity(taskId, definition.taskDefinitionId),
    taskKey: definition.taskKey,
    operation: definition.operation,
  });
  const rootTask = {
    ...runtimeIdentity(
      deriveWorkGraphRootTaskId(workflowRunId, rootDefinition),
      COMPILED.root,
    ),
    rootIssueId,
    resolvedInputs: {
      rootIssue: {
        repositoryOwner: OWNER,
        repositoryName: REPO,
        repositoryNodeId: REPOSITORY_NODE_ID,
        issueNumber: ROOT_ISSUE_NUMBER,
        issueNodeId: rootIssueId,
        admissionId: ADMISSION_ID,
        contentDigest,
      },
    },
  };
  const effectiveDefinition = childDefinition ?? sourceDefinition;
  const sourceTaskId = fixtureTaskId(
    workflowRunId,
    rootTask.taskId,
    sourceDefinition.taskDefinitionId,
  );
  const task = {
    ...runtimeIdentity(
      childKey
        ? fixtureTaskId(workflowRunId, sourceTaskId, taskDefinition)
        : sourceTaskId,
      effectiveDefinition,
    ),
    rootIssueId,
    resolvedInputs: structuredClone(
      childDefinition?.staticInputs ?? sourceDefinition.staticInputs,
    ),
  };
  const parentTask = childKey
    ? {
      ...runtimeIdentity(sourceTaskId, sourceDefinition),
        rootIssueId,
        resolvedInputs: structuredClone(sourceDefinition.staticInputs),
      }
    : null;
  const policy = COMPILED.steps[stepId].executionPolicies[taskDefinition];
  const dispatches = Array.from({ length: dispatchCount }, (_, index) => ({
    dispatchId: protocolId("dispatch", `${stepId}-${index}`),
    launchId: protocolId("dispatch-launch", `${stepId}-${index}`),
    rootIssueId,
    workflowRunId,
    taskId: task.taskId,
    task: runtimeIdentity(task.taskId, effectiveDefinition),
    lease: {
      leaseId: protocolId("lease", `${stepId}-${index}`),
      assignmentId: protocolId("assignment", stepId),
      executorId: policy.workerId,
      slotId: `${policy.workerId}-slot-1`,
    },
  }));
  const dispatch = dispatches.at(-1);
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      task.taskId,
      dispatch.dispatchId,
      dispatch.lease.leaseId,
    ),
    rootIssueId,
    workflowRunId,
    taskId: task.taskId,
    task: runtimeIdentity(task.taskId, effectiveDefinition),
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.lease.leaseId,
    attempt: resultAttempt,
    outcome: "succeeded",
    output: { summary: "done" },
  };
  const resultBody = formatTaskResult(result);
  const resultDigest = staleEvaluation
    ? `sha256:${"f".repeat(64)}`
    : taskResultDigest(result);
  const evaluationResultId = staleEvaluation
    ? protocolId("result", "stale")
    : result.resultId;
  const canonicalEvaluationId = deriveWorkGraphTaskEvaluationId(
    task.taskId,
    evaluationResultId,
    resultDigest,
  );
  const evaluation = verdict
    ? {
        evaluationId:
          persistedEvaluationId ?? canonicalEvaluationId,
        rootIssueId,
        workflowRunId,
        taskId: task.taskId,
        task: runtimeIdentity(task.taskId, effectiveDefinition),
        resultId: evaluationResultId,
        resultDigest,
        evaluatorId: policy.evaluatorId,
        attempt,
        verdict,
        summary: verdict === "accepted" ? "Accepted." : "Rejected.",
        feedback: verdict === "accepted" ? "" : "Fix the missing evidence.",
      }
    : null;
  const comments = [
    ...dispatches.map((payload, index) => ({
      id: 200 + index,
      node_id: `IC_dispatch_${index}`,
      body: formatTaskDispatch(payload),
      user: { id: ASSIGNMENT_ID, login: "assigner" },
      created_at: `2026-08-29T20:${String(index).padStart(2, "0")}:00Z`,
      updated_at: `2026-08-29T20:${String(index).padStart(2, "0")}:00Z`,
    })),
    {
      id: 230,
      node_id: "IC_result",
      body: resultBody,
      user: { id: RESULT_ID, login: "result-reporter" },
      created_at: "2026-08-29T20:30:00Z",
      updated_at: "2026-08-29T20:30:00Z",
    },
  ];
  if (evaluation && !staleEvaluation) {
    comments.push({
      id: 240,
      node_id: "IC_evaluation",
      body: formatWithClaimedEnvelopeId(
        formatTaskEvaluation,
        evaluation,
        "evaluationId",
        canonicalEvaluationId,
      ),
      user: { id: EVALUATION_ID, login: "evaluation-reporter" },
      created_at: "2026-08-29T20:40:00Z",
      updated_at: "2026-08-29T20:40:00Z",
    });
    if (conflictingEvaluation) {
      comments.push({
        id: 241,
        node_id: "IC_evaluation_conflict",
        body: formatTaskEvaluation({
          ...evaluation,
          evaluationId: canonicalEvaluationId,
        }),
        user: { id: EVALUATION_ID, login: "evaluation-reporter" },
        created_at: "2026-08-29T20:41:00Z",
        updated_at: "2026-08-29T20:41:00Z",
      });
    }
  }
  if (route) {
    const routeWithTask = {
      ...route,
      task: runtimeIdentity(task.taskId, effectiveDefinition),
    };
    comments.push({
      id: 250,
      node_id: "IC_route",
      body: formatWithClaimedEnvelopeId(
        formatTaskRoute,
        routeWithTask,
        "routeId",
        deriveWorkGraphTaskRouteId(
          routeWithTask.taskId,
          routeWithTask.evaluationId,
        ),
      ),
      user: { id: ROUTE_ID, login: "route-reporter" },
      created_at: "2026-08-29T20:50:00Z",
      updated_at: "2026-08-29T20:50:00Z",
    });
  }
  return {
    rootTask,
    task,
    policy,
    dispatch,
    result,
    resultBody,
    evaluation,
    comments,
    parentTask,
    input: {
      taskLocator: childKey
        ? {
            repositoryOwner: OWNER,
            repositoryName: REPO,
            repositoryNodeId: REPOSITORY_NODE_ID,
            issueNumber: RECURSIVE_TASK_NUMBER,
            issueNodeId: RECURSIVE_TASK_NODE_ID,
            parentIssueNumber: CHILD_TASK_NUMBER,
            parentIssueNodeId: CHILD_TASK_NODE_ID,
          }
        : {
            repositoryOwner: OWNER,
            repositoryName: REPO,
            repositoryNodeId: REPOSITORY_NODE_ID,
            issueNumber: CHILD_TASK_NUMBER,
            issueNodeId: CHILD_TASK_NODE_ID,
            parentIssueNumber: ROOT_ISSUE_NUMBER,
            parentIssueNodeId: ROOT_ISSUE_ID,
          },
      rootIssueId,
      workflowRunId,
      taskId: task.taskId,
      dispatchId: dispatch.dispatchId,
      leaseId: dispatch.lease.leaseId,
      resultId: result.resultId,
      attempt,
    },
  };
}

async function withFakeLifecycle(options, callback) {
  const data = lifecycleFixture(options);
  if (options.taskMetadataDrift === true) {
    data.task.operation = "different-operation";
  }
  if (options.rootTaskMetadataDrift === true) {
    data.rootTask.operation = "different-operation";
  }
  if (options.omitResult === true) {
    data.comments = data.comments.filter(
      ({ body }) => !body.startsWith("WorkGraphTaskResult/v1\n"),
    );
  }
  if (options.topLevelParentIsInitial === true && !data.parentTask) {
    data.input.taskLocator.parentIssueNumber = ROOT_TASK_NUMBER;
    data.input.taskLocator.parentIssueNodeId = ROOT_TASK_NODE_ID;
  }
  if (options.dispatchIdentityDrift === true) {
    const entry = data.comments.find(({ body }) =>
      body.startsWith("WorkGraphTaskDispatch/v1\n"),
    );
    const dispatch = parseTaskDispatch(entry.body);
    entry.body = formatTaskDispatch({
      ...dispatch,
      rootIssueId: "I_wrong_root",
    });
  }
  const root = rootIssue({ stale: options.staleRootIssue === true });
  if (options.rootAdmitted === false) root.labels = [];
  const rootTask = taskIssue(ROOT_TASK_NUMBER, ROOT_TASK_NODE_ID, data.rootTask);
  const parentTask = data.parentTask
    ? taskIssue(CHILD_TASK_NUMBER, CHILD_TASK_NODE_ID, data.parentTask)
    : null;
  const task = taskIssue(
    data.parentTask ? RECURSIVE_TASK_NUMBER : CHILD_TASK_NUMBER,
    data.parentTask ? RECURSIVE_TASK_NODE_ID : CHILD_TASK_NODE_ID,
    data.task,
  );
  if (options.taskClosed === true) task.state = "closed";
  if (options.parentTaskClosed === true && parentTask) {
    parentTask.state = "closed";
  }
  if (options.rootTaskClosed === true) rootTask.state = "closed";
  const taskNumber = data.parentTask
    ? RECURSIVE_TASK_NUMBER
    : CHILD_TASK_NUMBER;
  const comments = new Map([[taskNumber, data.comments]]);
  const writes = [];
  const role = options.role ?? "evaluator";
  const actorId =
    role === "worker"
      ? RESULT_ID
      : role === "evaluator"
        ? EVALUATION_ID
        : ROUTE_ID;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/user") {
      return send(200, { id: actorId, login: `${role}-reporter` });
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
      return send(
        200,
        new Map(
          [
            [ROOT_ISSUE_NUMBER, root],
            [ROOT_TASK_NUMBER, rootTask],
            [taskNumber, task],
            ...(parentTask ? [[CHILD_TASK_NUMBER, parentTask]] : []),
          ],
        ).get(Number(issueMatch[1])),
      );
    }
    const parentMatch = url.pathname.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/issues/(\\d+)/parent$`),
    );
    if (request.method === "GET" && parentMatch) {
      const number = Number(parentMatch[1]);
      const parent =
        number === RECURSIVE_TASK_NUMBER
          ? parentTask
          : options.topLevelParentIsInitial === true &&
              number === CHILD_TASK_NUMBER
            ? rootTask
          : root;
      return send(200, parent);
    }
    const subIssuesMatch = url.pathname.match(
      new RegExp(`^/repos/${OWNER}/${REPO}/issues/(\\d+)/sub_issues$`),
    );
    if (request.method === "GET" && subIssuesMatch) {
      return send(
        200,
        Number(subIssuesMatch[1]) === ROOT_ISSUE_NUMBER
          ? [rootTask, parentTask ?? task]
          : [],
      );
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
        id: 300 + writes.length,
        node_id: `IC_write_${writes.length}`,
        body,
        user: { id: actorId, login: `${role}-reporter` },
        created_at: "2026-08-29T21:00:00Z",
        updated_at: "2026-08-29T21:00:00Z",
      };
      comments.get(number).push(comment);
      writes.push({ number, body });
      if (
        options.dispatchAfterReworkPost === true &&
        parseTaskRoute(body)?.action === "rework"
      ) {
        comments.get(number).push({
          id: 400,
          node_id: "IC_dispatch_after_rework",
          body: formatTaskDispatch({
            ...data.dispatch,
            dispatchId: protocolId(
              "dispatch",
              `${data.dispatch.dispatchId}-rework`,
            ),
            launchId: protocolId(
              "dispatch-launch",
              `${data.dispatch.launchId}-rework`,
            ),
            lease: {
              ...data.dispatch.lease,
              leaseId: protocolId(
                "lease",
                `${data.dispatch.lease.leaseId}-rework`,
              ),
            },
          }),
          user: { id: ASSIGNMENT_ID, login: "assigner" },
          created_at: "2026-08-29T21:01:00Z",
          updated_at: "2026-08-29T21:01:00Z",
        });
      }
      if (options.closeAfterPost === true) {
        task.state = "closed";
        rootTask.state = "closed";
      }
      return send(201, comment);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/github/workgraph-v1/lease/validate"
    ) {
      const value = await requestBody(request);
      return send(200, {
        ...value,
        attempt: data.result.attempt,
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
    COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: String(EVALUATION_ID),
    COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: String(ROUTE_ID),
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL:
      `${origin}/github/workgraph-v1/lease/validate`,
    COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN: "lease-token",
  });
  if (role === "worker") {
    process.env.COPILOT_MCP_WORKGRAPH_EXECUTOR_ID = data.policy.workerId;
    delete process.env.COPILOT_MCP_WORKGRAPH_EVALUATOR_ID;
    delete process.env.COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID;
  } else if (role === "evaluator") {
    process.env.COPILOT_MCP_WORKGRAPH_EVALUATOR_ID =
      options.evaluatorId ?? data.policy.evaluatorId;
    delete process.env.COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID;
  } else {
    process.env.COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID =
      options.orchestratorId ?? data.policy.orchestratorId;
    delete process.env.COPILOT_MCP_WORKGRAPH_EVALUATOR_ID;
  }
  try {
    await callback({ data, writes, comments });
  } finally {
    process.env = previous;
    server.close();
    await once(server, "close");
  }
}

test("v1 Result identity, body, and envelope digest have stable vectors", () => {
  const task = {
    taskId: VECTOR_TASK_ID,
    workflowRunId: VECTOR_RUN_ID,
    workflowDefinitionId: "workflow",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: `sha256:${"a".repeat(64)}`,
    taskDefinitionId: VECTOR_TASK_DEFINITION_ID,
    taskKey: "task",
    operation: "execute",
  };
  const resultId = deriveWorkGraphTaskResultId(
    VECTOR_TASK_ID,
    VECTOR_DISPATCH_ID,
    VECTOR_LEASE_ID,
  );
  assert.equal(
    resultId,
    "urn:drasi:workgraph:id:v1:result:sha256:f0f893a82047b5ab3435fe299867caa34eef163f7020fdb7799346749ff6bdef",
  );
  const body = formatTaskResult({
    resultId,
    rootIssueId: "root-1",
    workflowRunId: VECTOR_RUN_ID,
    taskId: VECTOR_TASK_ID,
    task,
    dispatchId: VECTOR_DISPATCH_ID,
    leaseId: VECTOR_LEASE_ID,
    attempt: 1,
    outcome: "succeeded",
    output: { z: 1, a: true },
  });

  assert.equal(
    body,
    `WorkGraphTaskResult/v1

\`\`\`json
{
  "apiVersion": "workgraph.drasi.io/v1",
  "kind": "TaskResult",
  "id": "${resultId}",
  "rootIssueId": "root-1",
  "workflowRunId": "${VECTOR_RUN_ID}",
  "taskId": "${VECTOR_TASK_ID}",
  "workflowContext": {
    "workflowDefinitionId": "workflow",
    "workflowDefinitionVersion": "v1",
    "workflowDefinitionDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "taskDefinitionId": "${VECTOR_TASK_DEFINITION_ID}",
    "taskKey": "task",
    "operation": "execute"
  },
  "references": {
    "dispatch": {
      "kind": "TaskDispatch",
      "id": "${VECTOR_DISPATCH_ID}"
    },
    "lease": {
      "kind": "TaskLease",
      "id": "${VECTOR_LEASE_ID}"
    }
  },
  "data": {
    "attempt": 1,
    "outcome": "succeeded",
    "output": {
      "a": true,
      "z": 1
    }
  }
}
\`\`\`
`,
  );
  assert.deepEqual(parseTaskResult(body), {
    resultId,
    rootIssueId: "root-1",
    workflowRunId: VECTOR_RUN_ID,
    taskId: VECTOR_TASK_ID,
    task,
    dispatchId: VECTOR_DISPATCH_ID,
    leaseId: VECTOR_LEASE_ID,
    attempt: 1,
    outcome: "succeeded",
    output: { a: true, z: 1 },
  });

  assert.equal(
    taskResultDigest(parseTaskResult(body)),
    "sha256:4137a8eb709f27a8cb6961924c4d475fd96e8edcfab97fb2d89b9fce6ba9fe78",
  );
  assert.notEqual(
    taskResultDigest(parseTaskResult(body)),
    "sha256:7fbfa3cf23de081c97a4742fd36c7cefadc0d5527c0205de962e346832c6d5e8",
    "the envelope digest must differ from the obsolete flattened payload digest",
  );
  const integerKeys = {
    ...parseTaskResult(body),
    output: { 2: "two", 10: "ten" },
  };
  assert.equal(
    canonicalTaskResultEnvelopeJson(integerKeys),
    `{"apiVersion":"workgraph.drasi.io/v1","data":{"attempt":1,"outcome":"succeeded","output":{"10":"ten","2":"two"}},"id":"${resultId}","kind":"TaskResult","references":{"dispatch":{"id":"${VECTOR_DISPATCH_ID}","kind":"TaskDispatch"},"lease":{"id":"${VECTOR_LEASE_ID}","kind":"TaskLease"}},"rootIssueId":"root-1","taskId":"${VECTOR_TASK_ID}","workflowContext":{"operation":"execute","taskDefinitionId":"${VECTOR_TASK_DEFINITION_ID}","taskKey":"task","workflowDefinitionDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflowDefinitionId":"workflow","workflowDefinitionVersion":"v1"},"workflowRunId":"${VECTOR_RUN_ID}"}`,
  );
  assert.equal(
    taskResultDigest(integerKeys),
    "sha256:f21fdd0db68d5777c7908a393dc23f4e1d5451eee30d2fba0f7c4e0f1ec05b77",
  );
  const digestShape = JSON.parse(canonicalTaskResultEnvelopeJson(integerKeys));
  assert.equal(digestShape.kind, "TaskResult");
  assert.equal(digestShape.id, resultId);
  assert.equal(digestShape.resultId, undefined);
  assert.deepEqual(digestShape.references, {
    dispatch: { kind: "TaskDispatch", id: VECTOR_DISPATCH_ID },
    lease: { kind: "TaskLease", id: VECTOR_LEASE_ID },
  });
  assert.throws(() => parseTaskResult(body.replace('  "taskId"', ' "taskId"')));
  assert.throws(() => parseTaskResult(body.replace("/v1", "/v2")));
});

test("TaskResult URN envelope digest has a stable cross-shape vector", () => {
  const task = {
    taskId: RUST_TASK_ID,
    workflowRunId: RUST_RUN_ID,
    workflowDefinitionId: "workflow-1",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: `sha256:${"1".repeat(64)}`,
    taskDefinitionId: RUST_TASK_DEFINITION_ID,
    taskKey: "task",
    operation: "execute",
  };
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      RUST_TASK_ID,
      RUST_DISPATCH_ID,
      RUST_LEASE_ID,
    ),
    rootIssueId: "root-1",
    workflowRunId: RUST_RUN_ID,
    taskId: RUST_TASK_ID,
    task,
    dispatchId: RUST_DISPATCH_ID,
    leaseId: RUST_LEASE_ID,
    attempt: 1,
    outcome: "succeeded",
    output: { 2: "two", 10: "ten" },
  };

  assert.equal(
    taskResultDigest(result),
    "sha256:1376f6e924be53d9d2ee58ab039d05c5bc5fbd9cc0bc780dd433277d80e2a654",
  );
  assert.equal(
    taskResultDigest(parseTaskResult(formatTaskResult(result))),
    taskResultDigest(result),
  );
});

test("Dispatch uses the exact seven-field schema and direct task identities", async () => {
  const data = fixture();
  const parsed = parseTaskDispatch(formatTaskDispatch(data.childDispatch));
  assert.deepEqual(Object.keys(parsed), [
    "dispatchId",
    "launchId",
    "rootIssueId",
    "workflowRunId",
    "taskId",
    "task",
    "lease",
  ]);
  const { rootIssueId: _removed, ...oldShape } = data.childDispatch;
  assert.throws(() => formatTaskDispatch(oldShape));
  assert.throws(() =>
    formatTaskDispatch({ ...data.childDispatch, taskId: "task-mismatch" }),
  );
  await withFakeLifecycle(
    { dispatchIdentityDrift: true },
    async ({ data: lifecycle, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", lifecycle.input),
        /malformed, foreign, or duplicate Dispatch/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("reporter exports strict TaskError diagnostic support", () => {
  const data = fixture();
  const references = {
    forkId: null,
    joinId: null,
    assignmentId: null,
    dispatchId: data.childDispatch.dispatchId,
    leaseId: data.childDispatch.lease.leaseId,
    resultId: null,
    evaluationId: null,
    routeId: null,
  };
  const error = {
    errorId: deriveWorkGraphTaskErrorId(
      data.childTask.taskId,
      "dispatch",
      "dispatch-failed",
      references.dispatchId,
    ),
    rootIssueId: data.childTask.rootIssueId,
    workflowRunId: data.childTask.workflowRunId,
    taskId: data.childTask.taskId,
    task: data.childDispatch.task,
    references,
    stage: "dispatch",
    code: "dispatch-failed",
    category: "system",
    summary: "Dispatch failed.",
    retryable: false,
    attempt: null,
    details: {},
  };
  assert.deepEqual(parseTaskError(formatTaskError(error)), error);
});

test("Result output enforces the kernel JSON data domain", () => {
  const base = {
    resultId: deriveWorkGraphTaskResultId(
      VECTOR_TASK_ID,
      VECTOR_DISPATCH_ID,
      VECTOR_LEASE_ID,
    ),
    rootIssueId: "root-1",
    workflowRunId: VECTOR_RUN_ID,
    taskId: VECTOR_TASK_ID,
    task: {
      taskId: VECTOR_TASK_ID,
      workflowRunId: VECTOR_RUN_ID,
      workflowDefinitionId: "workflow",
      workflowDefinitionVersion: "v1",
      workflowDefinitionDigest: `sha256:${"a".repeat(64)}`,
      taskDefinitionId: VECTOR_TASK_DEFINITION_ID,
      taskKey: "task",
      operation: "execute",
    },
    dispatchId: VECTOR_DISPATCH_ID,
    leaseId: VECTOR_LEASE_ID,
    attempt: 1,
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

test("MCP exposes only narrow WorkGraph readers and lifecycle writers", async () => {
  assert.deepEqual(
    tools.map(({ name }) => name),
    [
      "get_root_issue",
      "submit_task_result",
      "get_task_snapshot",
      "submit_task_evaluation",
      "submit_task_route",
    ],
  );
  const lifecycleWriteKeys = ["taskLocator", "taskId", "resultId"];
  assert.deepEqual(
    tools.find(({ name }) => name === "submit_task_evaluation").inputSchema
      .required,
    [
      ...lifecycleWriteKeys,
      "evaluationId",
      "verdict",
      "summary",
      "feedback",
    ],
  );
  assert.deepEqual(
    tools.find(({ name }) => name === "submit_task_route").inputSchema.required,
    [...lifecycleWriteKeys, "evaluationId", "routeId", "action"],
  );
  for (const tool of tools) {
    assert.equal(
      tool.inputSchema.properties.taskId.pattern,
      "^urn:drasi:workgraph:id:v1:task:sha256:[0-9a-f]{64}$",
    );
  }
  const resultSchema = tools.find(
    ({ name }) => name === "submit_task_result",
  ).inputSchema.properties;
  assert.equal(
    resultSchema.dispatchId.pattern,
    "^urn:drasi:workgraph:id:v1:dispatch:sha256:[0-9a-f]{64}$",
  );
  assert.equal(
    resultSchema.leaseId.pattern,
    "^urn:drasi:workgraph:id:v1:lease:sha256:[0-9a-f]{64}$",
  );
  const snapshotSchema = tools.find(
    ({ name }) => name === "get_task_snapshot",
  ).inputSchema.properties;
  for (const [field, type] of [
    ["workflowRunId", "workflow-run"],
    ["dispatchId", "dispatch"],
    ["leaseId", "lease"],
    ["resultId", "result"],
  ]) {
    assert.equal(
      snapshotSchema[field].pattern,
      `^urn:drasi:workgraph:id:v1:${type}:sha256:[0-9a-f]{64}$`,
    );
  }
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
    [
      "get_root_issue",
      "submit_task_result",
      "get_task_snapshot",
      "submit_task_evaluation",
      "submit_task_route",
    ],
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
    const result = parseTaskResult(state.writes[0].body);
    assert.equal(result.rootIssueId, data.childTask.rootIssueId);
    assert.equal(result.workflowRunId, data.childTask.workflowRunId);
    assert.equal(result.attempt, 1);
    assert.match(
      state.leaseRequests[0].value.claimId,
      /^urn:drasi:workgraph:id:v1:lease-claim:sha256:[0-9a-f]{64}$/,
    );
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

test("Core attempts are authoritative and bounded by the kernel contract", async () => {
  await withFakeRuntime({ leaseAttempt: 2 }, async ({ data, state }) => {
    const created = await callTool(
      "submit_task_result",
      resultInput(data.childTask, data.childDispatch, childLocator()),
    );
    assert.equal(created.reconciled, false);
    assert.equal(state.writes.length, 1);
    assert.equal(parseTaskResult(state.writes[0].body).attempt, 2);
    assert.equal(state.leaseRequests.length, 1);
  });
  await withFakeRuntime({ leaseAttempt: 64 }, async ({ data, state }) => {
    await assert.rejects(
      callTool(
        "submit_task_result",
        resultInput(data.childTask, data.childDispatch, childLocator()),
      ),
      /1 through 17/,
    );
    assert.equal(state.writes.length, 0);
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
    assert.equal(parseTaskResult(state.writes[0].body).attempt, 2);
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
    { executorId: "issue-coordinator" },
    async ({ data, state }) => {
    const result = await callTool(
      "submit_task_result",
      resultInput(data.rootTask, data.rootDispatch, rootLocator()),
    );
    assert.equal(result.reconciled, false);
    assert.equal(state.writes[0].number, ROOT_TASK_NUMBER);
    assert.equal(state.leaseRequests[0].value.executorId, "issue-coordinator");
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
  for (const options of [
    { leaseResponse: { attempt: 0 } },
    { leaseResponse: { attempt: 65 } },
    { leaseResponse: { attempt: 1.5 } },
    { omitLeaseAttempt: true },
    { leaseResponse: { unexpected: true } },
  ]) {
    await withFakeRuntime(options, async ({ data, state }) => {
      await assert.rejects(
        callTool(
          "submit_task_result",
          resultInput(data.childTask, data.childDispatch, childLocator()),
        ),
        /Source Lease (attempt|validation response)/,
      );
      assert.equal(state.writes.length, 0);
    });
  }
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

test("reporter inputs reject legacy and malformed task IDs before reads", async () => {
  const invalidTaskIds = [
    `wgt-${"a".repeat(60)}`,
    "task-1",
    `workgraph-v1:task:sha256:${"a".repeat(64)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"A".repeat(64)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"a".repeat(63)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"g".repeat(64)}`,
  ];
  await withFakeRuntime({}, async ({ data, state }) => {
    for (const taskId of invalidTaskIds) {
      await assert.rejects(
        callTool("get_root_issue", {
          taskLocator: childLocator(),
          taskId,
        }),
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
      await assert.rejects(
        callTool("submit_task_result", {
          ...resultInput(data.childTask, data.childDispatch, childLocator()),
          taskId,
        }),
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
    }
    assert.equal(state.writes.length, 0);
    assert.equal(state.leaseRequests.length, 0);
  });
  await withFakeLifecycle({}, async ({ data, writes }) => {
    for (const taskId of invalidTaskIds) {
      await assert.rejects(
        callTool("get_task_snapshot", { ...data.input, taskId }),
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
      await assert.rejects(
        callTool("submit_task_evaluation", {
          ...evaluationInput(data, "accepted"),
          taskId,
        }),
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
    }
    assert.equal(writes.length, 0);
  });
  await withFakeLifecycle(
    { role: "orchestrator", verdict: "accepted" },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      for (const taskId of invalidTaskIds) {
        await assert.rejects(
          callTool("submit_task_route", {
            ...data.input,
            taskId,
            evaluationId: data.evaluation.evaluationId,
            routeId: snapshot.routeId,
            action: "advance",
            ...snapshot.authorizedTransitions[0],
          }),
          /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
        );
      }
      assert.equal(writes.length, 0);
    },
  );
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

function evaluationInput(data, verdict) {
  return {
    ...data.input,
    evaluationId: deriveWorkGraphTaskEvaluationId(
      data.input.taskId,
      data.input.resultId,
      taskResultDigest(data.result),
    ),
    verdict,
    summary: verdict === "accepted" ? "Accepted." : "Rejected.",
    feedback: verdict === "accepted" ? "" : "Add concrete supporting evidence.",
  };
}

test("Evaluation snapshot and writer cover accepted and rejected verdicts", async () => {
  for (const verdict of ["accepted", "rejected"]) {
    await withFakeLifecycle({}, async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.equal(snapshot.evaluatorId, data.policy.evaluatorId);
      assert.deepEqual(snapshot.authorizedVerdicts, ["accepted", "rejected"]);
      assert.equal(snapshot.resultDigest, taskResultDigest(data.result));
      assert.equal(
        snapshot.evaluationId,
        deriveWorkGraphTaskEvaluationId(
          data.input.taskId,
          data.input.resultId,
          snapshot.resultDigest,
        ),
      );
      const input = {
        taskLocator: data.input.taskLocator,
        taskId: data.input.taskId,
        resultId: data.input.resultId,
        evaluationId: snapshot.evaluationId,
        verdict,
        summary: verdict === "accepted" ? "Accepted." : "Rejected.",
        feedback:
          verdict === "accepted" ? "" : "Add concrete supporting evidence.",
      };
      const created = await callTool(
        "submit_task_evaluation",
        input,
      );
      assert.equal(created.reconciled, false);
      assert.equal(writes.length, 1);
      const payload = parseTaskEvaluation(writes[0].body);
      assert.equal(payload.verdict, verdict);
      assert.equal(payload.rootIssueId, data.input.rootIssueId);
      assert.equal(payload.workflowRunId, data.input.workflowRunId);
      assert.equal(payload.taskId, data.input.taskId);
      assert.equal(payload.resultId, data.input.resultId);
      assert.equal(payload.resultDigest, taskResultDigest(data.result));
      assert.equal(payload.attempt, 1);
      const retried = await callTool(
        "submit_task_evaluation",
        input,
      );
      assert.equal(retried.reconciled, true);
      assert.equal(writes.length, 1);
    });
  }
});

test("Evaluation and Route bind the authoritative Result attempt", async () => {
  await withFakeLifecycle(
    { attempt: 2, dispatchCount: 1 },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.equal(snapshot.attempt, 2);
      await callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      );
      assert.equal(parseTaskEvaluation(writes[0].body).attempt, 2);
    },
  );
  await withFakeLifecycle(
    {
      attempt: 2,
      dispatchCount: 1,
      role: "orchestrator",
      verdict: "accepted",
    },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      await callTool("submit_task_route", {
        ...data.input,
        evaluationId: data.evaluation.evaluationId,
        routeId: snapshot.routeId,
        action: "advance",
        ...snapshot.authorizedTransitions[0],
      });
      assert.equal(parseTaskRoute(writes[0].body).attempt, 2);
    },
  );
});

test("deterministic lifecycle claims make concurrent identical writes idempotent", async () => {
  await withFakeLifecycle({}, async ({ data, writes }) => {
    const settled = await Promise.all([
      callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      ),
      callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      ),
    ]);
    assert.equal(writes.length, 1);
    assert.equal(
      new Set(settled.map(({ claimId }) => claimId)).size,
      1,
    );
    assert.deepEqual(
      settled.map(({ reconciled }) => reconciled).sort(),
      [false, true],
    );
  });
  await withFakeLifecycle(
    { role: "orchestrator", verdict: "accepted" },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      const input = {
        ...data.input,
        evaluationId: data.evaluation.evaluationId,
        routeId: snapshot.routeId,
        action: "advance",
        ...snapshot.authorizedTransitions[0],
      };
      const settled = await Promise.all([
        callTool("submit_task_route", input),
        callTool("submit_task_route", input),
      ]);
      assert.equal(writes.length, 1);
      assert.equal(
        new Set(settled.map(({ claimId }) => claimId)).size,
        1,
      );
      assert.deepEqual(
        settled.map(({ reconciled }) => reconciled).sort(),
        [false, true],
      );
    },
  );
  await withFakeLifecycle({}, async ({ data, writes }) => {
    const settled = await Promise.allSettled([
      callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      ),
      callTool("submit_task_evaluation", {
        ...evaluationInput(data, "accepted"),
        evaluationId: "evaluation-conflicting-concurrent",
        summary: "Different immutable evaluation.",
      }),
    ]);
    assert.equal(writes.length, 1);
    assert.equal(
      settled.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(
      settled.filter(({ status }) => status === "rejected").length,
      1,
    );
  });
});

test("existing lifecycle artifacts reconcile across closure races", async () => {
  await withFakeLifecycle(
    { closeAfterPost: true },
    async ({ data, writes }) => {
      const created = await callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      );
      assert.equal(created.reconciled, false);
      assert.equal(writes.length, 1);
    },
  );
  await withFakeLifecycle(
    { verdict: "accepted", taskClosed: true, rootTaskClosed: true },
    async ({ data, writes }) => {
      const reconciled = await callTool(
        "submit_task_evaluation",
        evaluationInput(data, "accepted"),
      );
      assert.equal(reconciled.reconciled, true);
      assert.equal(writes.length, 0);
    },
  );
  await withFakeLifecycle(
    { taskClosed: true },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool(
          "submit_task_evaluation",
          evaluationInput(data, "accepted"),
        ),
        /requires an open Task/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("lifecycle reads enforce full Root Issue admission integrity", async () => {
  for (const options of [
    { rootAdmitted: false },
    { staleRootIssue: true },
  ]) {
    await withFakeLifecycle(options, async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /Root Issue is missing, stale|changed after admission/,
      );
      assert.equal(writes.length, 0);
    });
  }
});

test("lifecycle reads reject task metadata that drifts from the definition", async () => {
  for (const options of [
    { taskMetadataDrift: true },
    { rootTaskMetadataDrift: true },
  ]) {
    await withFakeLifecycle(options, async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /taskKey or operation does not match/,
      );
      assert.equal(writes.length, 0);
    });
  }
});

test("later top-level tasks are direct Root Issue children", async () => {
  await withFakeLifecycle(
    { stepId: "d", rootTaskClosed: true },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.equal(snapshot.sourceStepId, "d");
      assert.equal(snapshot.taskId, data.task.taskId);
      assert.equal(writes.length, 0);
    },
  );
  await withFakeLifecycle(
    { stepId: "d", topLevelParentIsInitial: true },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /Root Issue is missing, stale|ordinary Root Issue/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("later top-level tasks can report after the initial task closes", async () => {
  await withFakeLifecycle(
    {
      stepId: "b",
      role: "worker",
      rootTaskClosed: true,
      omitResult: true,
    },
    async ({ data, writes }) => {
      const created = await callTool(
        "submit_task_result",
        resultInput(data.task, data.dispatch, data.input.taskLocator),
      );
      assert.equal(created.reconciled, false);
      assert.equal(writes.length, 1);
      assert.equal(parseTaskResult(writes[0].body).taskId, data.task.taskId);
    },
  );
});

test("Evaluation fails closed on conflicting duplicates and direct identity drift", async () => {
  await withFakeLifecycle(
    { verdict: "accepted", conflictingEvaluation: true },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /duplicate, or conflicting Evaluation/,
      );
      assert.equal(writes.length, 0);
    },
  );
  await withFakeLifecycle({}, async ({ data, writes }) => {
    await assert.rejects(
      callTool("submit_task_evaluation", {
        ...evaluationInput(data, "accepted"),
        rootIssueId: "I_wrong_root",
      }),
      /directly match the Task/,
    );
    await assert.rejects(
      callTool("submit_task_evaluation", {
        ...evaluationInput(data, "accepted"),
        attempt: 2,
      }),
      /attempt does not match/,
    );
    assert.equal(writes.length, 0);
  });
  await withFakeLifecycle(
    { evaluatorId: "issue-validation-evaluator" },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /configured evaluator/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("Evaluation rejects arbitrary and legacy IDs in comments and submissions", async () => {
  const invalidIds = [
    "evaluation-arbitrary",
    `workgraph-v1:evaluation-artifact:sha256:${"1".repeat(64)}`,
  ];
  for (const evaluationId of invalidIds) {
    await withFakeLifecycle(
      { verdict: "accepted", persistedEvaluationId: evaluationId },
      async ({ data, writes }) => {
        await assert.rejects(
          callTool("get_task_snapshot", data.input),
          /evaluationId (?:is not canonical|must be urn:)/,
        );
        assert.equal(writes.length, 0);
      },
    );
    await withFakeLifecycle({}, async ({ data, writes }) => {
      await assert.rejects(
        callTool("submit_task_evaluation", {
          ...evaluationInput(data, "accepted"),
          evaluationId,
        }),
        /canonical current Result identity/,
      );
      assert.equal(writes.length, 0);
    });
  }
});

test("Route advances through linear next edges to task and terminal", async () => {
  await withFakeLifecycle(
    { stepId: "b", role: "orchestrator", verdict: "accepted" },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.equal(
        snapshot.routeId,
        deriveWorkGraphTaskRouteId(
          data.input.taskId,
          data.evaluation.evaluationId,
        ),
      );
      assert.deepEqual(snapshot.authorizedTransitions, [
        {
          transitionKind: "next",
          targetStepId: "c",
          targetStepKind: "task",
          targetTaskDefinitionId:
            COMPILED.steps.c.taskDefinition.taskDefinitionId,
        },
      ]);
      const routeInput = {
        taskLocator: data.input.taskLocator,
        taskId: data.input.taskId,
        resultId: data.input.resultId,
        evaluationId: data.evaluation.evaluationId,
        routeId: snapshot.routeId,
        action: "advance",
        ...snapshot.authorizedTransitions[0],
      };
      const created = await callTool("submit_task_route", routeInput);
      assert.equal(created.reconciled, false);
      assert.equal(parseTaskRoute(writes[0].body).targetStepId, "c");
      const retried = await callTool("submit_task_route", routeInput);
      assert.equal(retried.reconciled, true);
      assert.equal(writes.length, 1);
    },
  );
  for (const [stepId, expectedKind] of [
    ["c", "task"],
    ["d", "terminal"],
  ]) {
    await withFakeLifecycle(
      { stepId, role: "orchestrator", verdict: "accepted" },
      async ({ data, writes }) => {
        const snapshot = await callTool("get_task_snapshot", data.input);
        assert.deepEqual(
          snapshot.authorizedActions,
          expectedKind === "terminal"
            ? ["advance", "complete", "error", "ignore"]
            : ["advance", "error", "ignore"],
        );
        const choice = snapshot.authorizedTransitions[0];
        await callTool("submit_task_route", {
          ...data.input,
          evaluationId: data.evaluation.evaluationId,
          routeId: snapshot.routeId,
          action: "advance",
          ...choice,
        });
        const payload = parseTaskRoute(writes[0].body);
        assert.equal(payload.targetStepKind, expectedKind);
        assert.equal("outcome" in payload, false);
        assert.equal(
          "targetTaskDefinitionId" in payload,
          expectedKind === "task",
        );
      },
    );
  }
});

test("Route rejects arbitrary and legacy IDs in comments and submissions", async () => {
  const seed = lifecycleFixture({ stepId: "c", verdict: "accepted" });
  const invalidIds = [
    "route-arbitrary",
    `workgraph-v1:route-artifact:sha256:${"2".repeat(64)}`,
  ];
  for (const routeId of invalidIds) {
    await withFakeLifecycle(
      {
        stepId: "c",
        role: "orchestrator",
        verdict: "accepted",
        route: {
          routeId,
          rootIssueId: seed.input.rootIssueId,
          workflowRunId: seed.input.workflowRunId,
          taskId: seed.input.taskId,
          resultId: seed.input.resultId,
          evaluationId: seed.evaluation.evaluationId,
          evaluationVerdict: "accepted",
          orchestratorId: seed.policy.orchestratorId,
          action: "advance",
          transitionKind: "next",
          targetStepId: "d",
          targetStepKind: "task",
          targetTaskDefinitionId:
            COMPILED.steps.d.taskDefinition.taskDefinitionId,
          attempt: 1,
        },
      },
      async ({ data, writes }) => {
        await assert.rejects(
          callTool("get_task_snapshot", data.input),
          /routeId (?:is not canonical|must be urn:)/,
        );
        assert.equal(writes.length, 0);
      },
    );
    await withFakeLifecycle(
      { stepId: "c", role: "orchestrator", verdict: "accepted" },
      async ({ data, writes }) => {
        const snapshot = await callTool("get_task_snapshot", data.input);
        await assert.rejects(
          callTool("submit_task_route", {
            ...data.input,
            evaluationId: data.evaluation.evaluationId,
            routeId,
            action: "advance",
            ...snapshot.authorizedTransitions[0],
          }),
          /routeId (?:must be urn:|does not match the canonical current Evaluation identity)/,
        );
        assert.equal(writes.length, 0);
      },
    );
  }
});

test("existing Routes are revalidated against the compiled linear policy", async () => {
  const seed = lifecycleFixture({
    stepId: "c",
    verdict: "accepted",
  });
  const invalidRoute = {
    routeId: deriveWorkGraphTaskRouteId(
      seed.input.taskId,
      seed.evaluation.evaluationId,
    ),
    rootIssueId: seed.input.rootIssueId,
    workflowRunId: seed.input.workflowRunId,
    taskId: seed.input.taskId,
    resultId: seed.input.resultId,
    evaluationId: seed.evaluation.evaluationId,
    evaluationVerdict: "accepted",
    orchestratorId: seed.policy.orchestratorId,
    action: "advance",
    transitionKind: "next",
    targetStepId: "b",
    targetStepKind: "task",
    targetTaskDefinitionId: COMPILED.steps.b.taskDefinition.taskDefinitionId,
    attempt: 1,
  };
  await withFakeLifecycle(
    {
      stepId: "c",
      role: "orchestrator",
      verdict: "accepted",
      route: invalidRoute,
    },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /conflicting Route/,
      );
      assert.equal(writes.length, 0);
    },
  );
  const topLevel = lifecycleFixture({ stepId: "c", verdict: "accepted" });
  await withFakeLifecycle(
    {
      stepId: "c",
      role: "orchestrator",
      verdict: "accepted",
      route: {
        routeId: deriveWorkGraphTaskRouteId(
          topLevel.input.taskId,
          topLevel.evaluation.evaluationId,
        ),
        rootIssueId: topLevel.input.rootIssueId,
        workflowRunId: topLevel.input.workflowRunId,
        taskId: topLevel.input.taskId,
        resultId: topLevel.input.resultId,
        evaluationId: topLevel.evaluation.evaluationId,
        evaluationVerdict: "accepted",
        orchestratorId: topLevel.policy.orchestratorId,
        action: "complete",
        attempt: 1,
      },
    },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /conflicting Route/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("Route rejects wrong compiled mapping and wrong orchestrator", async () => {
  await withFakeLifecycle(
    { stepId: "c", role: "orchestrator", verdict: "accepted" },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      await assert.rejects(
        callTool("submit_task_route", {
          ...data.input,
          evaluationId: data.evaluation.evaluationId,
          routeId: snapshot.routeId,
          action: "advance",
          ...snapshot.authorizedTransitions[0],
          targetStepId: "b",
        }),
        /compiled transition|bounded compiled choices|targetTaskDefinitionId/,
      );
      assert.equal(writes.length, 0);
    },
  );
  await withFakeLifecycle(
    {
      stepId: "c",
      role: "orchestrator",
      verdict: "accepted",
      orchestratorId: "validation-stage-coordinator",
    },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /configured orchestrator/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("Rejected Route reworks the same task and assignment within the limit", async () => {
  await withFakeLifecycle(
    {
      stepId: "c",
      attempt: 3,
      role: "orchestrator",
      verdict: "rejected",
      dispatchAfterReworkPost: true,
    },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.deepEqual(snapshot.authorizedActions, ["rework", "error", "ignore"]);
      const routed = await callTool("submit_task_route", {
        ...data.input,
        evaluationId: data.evaluation.evaluationId,
        routeId: snapshot.routeId,
        action: "rework",
      });
      assert.deepEqual(routed.rework, {
        taskId: data.task.taskId,
        assignmentId: data.dispatch.lease.assignmentId,
        attempt: 4,
        feedback: data.evaluation.feedback,
      });
      assert.equal(parseTaskRoute(writes[0].body).attempt, 3);
      const retried = await callTool("submit_task_route", {
        ...data.input,
        evaluationId: data.evaluation.evaluationId,
        routeId: snapshot.routeId,
        action: "rework",
      });
      assert.equal(retried.reconciled, true);
      assert.equal(writes.length, 1);
    },
  );
  await withFakeLifecycle(
    { stepId: "c", attempt: 4, role: "orchestrator", verdict: "rejected" },
    async ({ data, writes }) => {
      const snapshot = await callTool("get_task_snapshot", data.input);
      assert.deepEqual(snapshot.authorizedActions, ["error", "ignore"]);
      await assert.rejects(
        callTool("submit_task_route", {
          ...data.input,
          evaluationId: data.evaluation.evaluationId,
          routeId: snapshot.routeId,
          action: "rework",
        }),
        /exceeds the source task policy|not authorized/,
      );
      assert.equal(writes.length, 0);
    },
  );
});

test("Route rejects stale Result, Evaluation, and attempt identities", async () => {
  await withFakeLifecycle(
    { role: "orchestrator", verdict: "accepted" },
    async ({ data, writes }) => {
      const canonicalRouteId = deriveWorkGraphTaskRouteId(
        data.input.taskId,
        data.evaluation.evaluationId,
      );
      for (const changed of [
        { resultId: "result-stale" },
        { evaluationId: "evaluation-stale" },
        { attempt: 2 },
      ]) {
        await assert.rejects(
          callTool("submit_task_route", {
            ...data.input,
            evaluationId: data.evaluation.evaluationId,
            routeId: canonicalRouteId,
            action: "complete",
            ...changed,
          }),
        );
      }
      assert.equal(writes.length, 0);
    },
  );
});

test("lifecycle reads reject a caller attempt that does not match Result", async () => {
  await withFakeLifecycle(
    { attempt: 2, resultAttempt: 1 },
    async ({ data, writes }) => {
      await assert.rejects(
        callTool("get_task_snapshot", data.input),
        /authoritative current Result attempt/,
      );
      assert.equal(writes.length, 0);
    },
  );
});
