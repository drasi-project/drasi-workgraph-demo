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
  deriveVNextAdmissionId,
  deriveVNextPrincipalContentDigest,
  deriveVNextRootTaskId,
  deriveVNextTaskResultId,
  deriveVNextWorkflowRunId,
  formatVNextTaskResult,
  parseAgentsYaml,
  formatTask,
  formatTaskResult,
  leaseValidationPathForTool,
  parseTask,
  resultDigest,
  validateLeaseValidationUrl,
} from "../.github/mcp/workgraph-reporter.mjs";
import { formatRuntimeTask } from "../.github/mcp/workgraph-vnext-definition.mjs";
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
const REPOSITORY_NODE = "R_demo";
const PRINCIPAL_NUMBER = 161;
const PRINCIPAL_NODE = "I_demo_161";
const PRINCIPAL_TITLE = "Demo issue 🚀";
const PRINCIPAL_BODY = "Line 1\r\nLine 2\n";
const PRINCIPAL_CONTENT_DIGEST =
  "sha256:84cdbe803b7880c398508c1f3ac62d157e2cbb60d9bc7fae63d56dba28e05750";
const ADMISSION_WORKFLOW_RUN_ID =
  "workgraph-vnext:run:sha256:73a4fabc01739d001b856f622d2192cd1b4ae500a25ba044829a6505edee8aa1";
const ADMISSION_ROOT_TASK_ID =
  "wgt-f0e9789eb47ad9bf308d29a0183a5206baccf6dab07def899d60b6bfab7d";
const ADMISSION_ID =
  "workgraph-vnext:admission:sha256:7384ba74027ee09914caf20dc41b015b01b51f4f4da52900a507c253e3435a82";
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
  "    leaseDuration: PT30M\n" +
  "  - agentId: demo-orchestrator\n" +
  "    slots: 1\n" +
  "    leaseDuration: PT15M\n";

test("lease validation URLs remain scoped to legacy lease-bound tools", () => {
  assert.equal(
    leaseValidationPathForTool("post_workflow_parent_info_request"),
    "/github/workgraph-v2/lease/validate",
  );
  const v2Url =
    "https://workgraph.example/github/workgraph-v2/lease/validate";
  assert.equal(
    validateLeaseValidationUrl(v2Url, "submit_workflow_task_result", false),
    v2Url,
  );
  assert.equal(
    validateLeaseValidationUrl(
      "https://workgraph.example/github/workgraph/lease/validate",
      "submit_workflow_task_result",
      false,
    ),
    v2Url,
  );
  assert.throws(
    () => leaseValidationPathForTool("submit_task_result"),
    /unknown lease-bound tool/,
  );
  assert.throws(
    () =>
      validateLeaseValidationUrl(
        "https://workgraph.example/untrusted/lease/validate",
        "submit_workflow_task_result",
        false,
      ),
    /invalid for this tool/,
  );
  assert.equal(
    validateLeaseValidationUrl(
      "http://127.0.0.1:9000/lease/validate",
      "submit_workflow_task_result",
      true,
    ),
    "http://127.0.0.1:9000/lease/validate",
  );
});
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
const WORKFLOW_EVALUATOR_PAYLOAD = {
  taskType: "workflow-task",
  inputs: {
    ...WORKFLOW_COMMON,
    operation: "evaluate-validation",
    agent: "issue-validation-evaluator",
    inputs: {},
    join: "all",
    expectedChildCount: 2,
    children: WORKFLOW_CHILDREN,
  },
};
const WORKFLOW_REQUEST_PAYLOAD = {
  taskType: "workflow-task",
  inputs: {
    ...WORKFLOW_COMMON,
    stepId: "request-info",
    operation: "request-info",
    agent: "issue-info-requester",
    inputs: { fromStep: "parallel-validation" },
  },
};
const WORKFLOW_EVALUATOR_RESULT = {
  taskType: "workflow-task",
  leaseId: "lease-evaluator-001",
  outcome: "succeeded",
  summary: "Joined validation Results evaluated.",
  result: {
    decision: "request-info",
    titlePassed: false,
    bodyPassed: true,
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

const VNEXT_TASK = {
  taskId: "task-1",
  workflowRunId: "run-1",
  workflowDefinitionId: "demo-issue-lifecycle",
  workflowDefinitionVersion: "v1",
  workflowDefinitionDigest: `sha256:${"a".repeat(64)}`,
  taskDefinitionId: "demo-validate-v1",
  resolvedInputs: { validationProfile: "new-issue-default" },
};

const VNEXT_DISPATCH = {
  dispatchId: "dispatch-1",
  launchId: "launch-1",
  task: Object.fromEntries(
    Object.entries(VNEXT_TASK).filter(([key]) => key !== "resolvedInputs"),
  ),
  lease: {
    leaseId: "lease-1",
    assignmentId: "assignment-1",
    executorId: "issue-validator",
    slotId: "issue-validator/1",
  },
};

function vnextDispatchBody(dispatch = VNEXT_DISPATCH) {
  return `WorkGraphTaskDispatch/v1\n\n\`\`\`json\n${JSON.stringify(dispatch, null, 2)}\n\`\`\`\n`;
}

function makeVNextTask(options = {}, runtimeTask = VNEXT_TASK) {
  const task = makeTask(options);
  task.body = formatRuntimeTask(runtimeTask);
  return task;
}

function makePrincipalIssue(overrides = {}) {
  return {
    id: 161,
    number: PRINCIPAL_NUMBER,
    node_id: PRINCIPAL_NODE,
    state: "open",
    title: PRINCIPAL_TITLE,
    body: PRINCIPAL_BODY,
    labels: [{ name: "status:new" }],
    user: { id: IDS.submitter, login: "submitter", type: "User" },
    type: null,
    repository_url:
      "https://api.github.com/repos/drasi-project/drasi-workgraph-demo",
    ...overrides,
  };
}

function admissionRootTask(principalIssue = {}) {
  return {
    taskId: ADMISSION_ROOT_TASK_ID,
    workflowRunId: ADMISSION_WORKFLOW_RUN_ID,
    workflowDefinitionId: "demo-issue-lifecycle",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: `sha256:${"a".repeat(64)}`,
    taskDefinitionId: "demo-root-v1",
    resolvedInputs: {
      proofMode: "isolated",
      principalIssue: {
        repositoryOwner: "drasi-project",
        repositoryName: "drasi-workgraph-demo",
        repositoryNodeId: REPOSITORY_NODE,
        issueNumber: PRINCIPAL_NUMBER,
        issueNodeId: PRINCIPAL_NODE,
        contentDigest: PRINCIPAL_CONTENT_DIGEST,
        ...principalIssue,
      },
    },
  };
}

function admissionValidatorTask() {
  return {
    ...VNEXT_TASK,
    taskId: "wgt-admission-validator",
    workflowRunId: ADMISSION_WORKFLOW_RUN_ID,
  };
}

function principalReadInput(task = admissionValidatorTask()) {
  return {
    taskLocator: {
      repositoryOwner: "drasi-project",
      repositoryName: "drasi-workgraph-demo",
      repositoryNodeId: REPOSITORY_NODE,
      issueNumber: TASK_NUMBER,
      issueNodeId: TASK_NODE,
      parentIssueNumber: PARENT_NUMBER,
      parentIssueNodeId: PARENT_NODE,
    },
    taskId: task.taskId,
  };
}

function vnextResultInput(output = { criteria: [], summary: "Validated." }) {
  return {
    taskLocator: {
      repositoryOwner: "drasi-project",
      repositoryName: "drasi-workgraph-demo",
      repositoryNodeId: REPOSITORY_NODE,
      issueNumber: TASK_NUMBER,
      issueNodeId: TASK_NODE,
      parentIssueNumber: PARENT_NUMBER,
      parentIssueNodeId: PARENT_NODE,
    },
    taskId: VNEXT_TASK.taskId,
    dispatchId: VNEXT_DISPATCH.dispatchId,
    leaseId: VNEXT_DISPATCH.lease.leaseId,
    outcome: "succeeded",
    output,
  };
}

function vnextDispatchComment(
  dispatch = VNEXT_DISPATCH,
  author = IDS.assignment,
) {
  return makeComment(vnextDispatchBody(dispatch), author, "IC_dispatch", 220);
}

function vnextResultComment(
  input = vnextResultInput(),
  author = IDS.result,
) {
  const payload = {
    resultId: deriveVNextTaskResultId(
      input.taskId,
      input.dispatchId,
      input.leaseId,
    ),
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    leaseId: input.leaseId,
    outcome: input.outcome,
    output: input.output,
  };
  return makeComment(formatVNextTaskResult(payload), author, "IC_vnext_result", 221);
}

function makeWorkflowTask(
  payload,
  {
    number = TASK_NUMBER,
    nodeId = TASK_NODE,
    id = 117,
    state = "open",
    stateReason = state === "closed" ? "completed" : null,
    authorId = IDS.launcher,
  } = {},
) {
  return {
    id,
    number,
    node_id: nodeId,
    state,
    state_reason: stateReason,
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

function workflowResultComment(
  result,
  author = IDS.result,
  nodeId = "IC_workflow_result",
) {
  return makeComment(formatWorkflowResult(result), author, nodeId, 212);
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
      route === "/repos/drasi-project/drasi-workgraph-demo"
    ) {
      send(response, 200, {
        name: "drasi-workgraph-demo",
        owner: { login: "drasi-project" },
        node_id: REPOSITORY_NODE,
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
      const issue =
        number === PARENT_NUMBER ? state.parent : state.tasks.get(number);
      if (!issue) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 200, issue);
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
      {
        agentId: "demo-orchestrator",
        slots: 1,
        leaseDuration: "PT15M",
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

test("exposes only eleven narrow tools and ignores MCP notifications", async () => {
  await withFake({}, async (fake) => {
    const { tools } = await runTool(fake, IDS.assignment, "submit_task_assignment", {
      ...baseInput(),
      agentId: "issue-validator",
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "get_vnext_principal_issue",
        "get_result_snapshot",
        "submit_task_assignment",
        "submit_task_result",
        "submit_workflow_task_assignment",
        "submit_workflow_task_result",
        "submit_result_acceptance",
        "transition_issue",
        "post_parent_info_request",
        "post_workflow_parent_info_request",
        "submit_task_feedback",
      ],
    );
    tools.forEach((tool) =>
      assert.equal(tool.inputSchema.additionalProperties, false),
    );
    const resultTool = tools.find((tool) => tool.name === "submit_task_result");
    const principalTool = tools.find(
      (tool) => tool.name === "get_vnext_principal_issue",
    );
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
      principalTool.inputSchema.required,
      ["taskLocator", "taskId"],
    );
    assert.deepEqual(
      principalTool.inputSchema.properties.taskLocator.required,
      [
        "repositoryOwner",
        "repositoryName",
        "repositoryNodeId",
        "issueNumber",
        "issueNodeId",
        "parentIssueNumber",
        "parentIssueNodeId",
      ],
    );
    assert.deepEqual(
      [...resultTool.inputSchema.required].sort(),
      [
        "dispatchId",
        "leaseId",
        "outcome",
        "output",
        "taskId",
        "taskLocator",
      ].sort(),
    );
    assert.deepEqual(
      resultTool.inputSchema.properties.taskLocator.required,
      [
        "repositoryOwner",
        "repositoryName",
        "repositoryNodeId",
        "issueNumber",
        "issueNodeId",
      ],
    );
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
    const resultInput = vnextResultInput();
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
        required: [...common, assignment, result],
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
        name: "workflow request-info Result",
        actor: IDS.result,
        tool: "submit_workflow_task_result",
        input: {
          ...baseInput(),
          ...activeLeaseInput(INFO_LEASE),
          workResult: {
            taskType: "workflow-task",
            leaseId: INFO_LEASE.leaseId,
            outcome: "succeeded",
            summary: "Requested the missing issue information.",
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
        name: "workflow parent info request",
        actor: IDS.info,
        tool: "post_workflow_parent_info_request",
        input: {
          ...baseInput(),
          priorTaskIssueNumber: 18,
          priorTaskIssueNodeId: "I_evaluator",
          priorResultCommentNodeId: "IC_evaluator_result",
          priorResultBodyDigest: `sha256:${"0".repeat(64)}`,
          ...activeLeaseInput(INFO_LEASE),
        },
        required: [...common, assignment, result, info, ...lease],
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

test("VNext Result input is exact and rejects legacy fields before GitHub reads", async () => {
  const complete = vnextResultInput();
  for (const key of Object.keys(complete)) {
    await withFake({}, async (fake) => {
      const input = structuredClone(complete);
      delete input[key];
      const response = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(response.result.isError, true, key);
      assert.deepEqual(fake.state.operations, []);
    });
  }
  for (const legacy of ["workResult", "assignmentCommentNodeId", "agentId", "slotId"]) {
    await withFake({}, async (fake) => {
      const response = await runTool(fake, IDS.result, "submit_task_result", {
        ...complete,
        [legacy]: "legacy",
      });
      assert.equal(response.result.isError, true, legacy);
      assert.match(response.result.content[0].text, /properties must be exactly/);
      assert.deepEqual(fake.state.operations, []);
    });
  }
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

test("workflow request-info binds the prior evaluator Result and parent comment", async () => {
  const requestTask = makeWorkflowTask(WORKFLOW_REQUEST_PAYLOAD);
  const priorTask = makeWorkflowTask(WORKFLOW_EVALUATOR_PAYLOAD, {
    number: 16,
    nodeId: "I_evaluator",
    id: 116,
    state: "closed",
  });
  const priorResult = workflowResultComment(
    WORKFLOW_EVALUATOR_RESULT,
    IDS.result,
    "IC_evaluator_result",
  );
  const priorResultBodyDigest = resultDigest(priorResult.body);
  await withFake(
    {
      tasks: [requestTask, priorTask],
      children: [requestTask.number, priorTask.number],
      comments: {
        [requestTask.number]: [
          workflowAssignmentComment(
            "issue-info-requester",
            INFO_LEASE.assignmentCommentNodeId,
          ),
        ],
        [priorTask.number]: [priorResult],
      },
      activeLease: {
        ...INFO_LEASE,
        taskNodeId: requestTask.node_id,
        taskType: "workflow-task",
      },
    },
    async (fake) => {
      const postInput = {
        ...baseInput(requestTask),
        ...activeLeaseInput(INFO_LEASE),
        priorTaskIssueNumber: priorTask.number,
        priorTaskIssueNodeId: priorTask.node_id,
        priorResultCommentNodeId: priorResult.node_id,
        priorResultBodyDigest,
      };
      const stale = await runTool(
        fake,
        IDS.info,
        "post_workflow_parent_info_request",
        {
          ...postInput,
          priorResultBodyDigest: `sha256:${"f".repeat(64)}`,
        },
      );
      assert.equal(stale.result.isError, true);
      assert.match(stale.result.content[0].text, /revision is not current/);

      const first = await runTool(
        fake,
        IDS.info,
        "post_workflow_parent_info_request",
        postInput,
      );
      assert.equal(first.result.isError, false);
      assert.equal(first.result.structuredContent.reconciled, false);
      const requestCommentNodeId =
        first.result.structuredContent.requestCommentNodeId;
      const parentComment = fake.state.comments
        .get(PARENT_NUMBER)
        .find((comment) => comment.node_id === requestCommentNodeId);
      assert.match(parentComment.body, /The Issue has a non-empty title/);
      assert.doesNotMatch(parentComment.body, /The Issue body is present/);
      assert.match(
        parentComment.body,
        new RegExp(
          `WorkGraphInfoRequest/v2 .*priorResultCommentNodeId=${priorResult.node_id} ` +
            `priorResultBodyDigest=${priorResultBodyDigest}`,
        ),
      );

      const duplicate = await runTool(
        fake,
        IDS.info,
        "post_workflow_parent_info_request",
        postInput,
      );
      assert.equal(duplicate.result.isError, false);
      assert.equal(duplicate.result.structuredContent.reconciled, true);
      assert.equal(
        fake.state.operations.filter(
          (operation) =>
            operation ===
            `POST /repos/drasi-project/drasi-workgraph-demo/issues/${PARENT_NUMBER}/comments`,
        ).length,
        1,
      );

      const workResult = {
        taskType: "workflow-task",
        leaseId: INFO_LEASE.leaseId,
        outcome: "succeeded",
        summary: "Requested the missing issue information.",
        result: { requestCommentNodeId },
      };
      const submitted = await runTool(
        fake,
        IDS.result,
        "submit_workflow_task_result",
        {
          ...baseInput(requestTask),
          ...activeLeaseInput(INFO_LEASE),
          workResult,
        },
      );
      assert.equal(submitted.result.isError, false);
      assert.equal(
        fake.state.comments.get(requestTask.number).at(-1).body,
        formatWorkflowResult(workResult),
      );
    },
  );
});

test("VNext Result ID and body match the frozen kernel vector", () => {
  const resultId = deriveVNextTaskResultId("task-1", "dispatch-1", "lease-1");
  assert.equal(
    resultId,
    "workgraph-vnext:result:sha256:4fcd8917e2144ba5787b5b224c1ab293ac7b1027b52a946cbf188a97a0696755",
  );
  const body = formatVNextTaskResult({
    resultId,
    taskId: "task-1",
    dispatchId: "dispatch-1",
    leaseId: "lease-1",
    outcome: "succeeded",
    output: {
      small: 0.000001,
      tiny: 0.0000001,
      negativeZero: -0,
      nested: JSON.parse(
        '{"2":"two","10":"ten","__proto__":{"preserved":true}}',
      ),
    },
  });
  assert.equal(
    body,
    `WorkGraphTaskResult/v1

\`\`\`json
{
  "resultId": "${resultId}",
  "taskId": "task-1",
  "dispatchId": "dispatch-1",
  "leaseId": "lease-1",
  "outcome": "succeeded",
  "output": {
    "negativeZero": -0.0,
    "nested": {
      "10": "ten",
      "2": "two",
      "__proto__": {
        "preserved": true
      }
    },
    "small": 1e-6,
    "tiny": 1e-7
  }
}
\`\`\`
`,
  );
});

test("VNext admission identities match the frozen shared vector", () => {
    assert.equal(
      deriveVNextPrincipalContentDigest(PRINCIPAL_TITLE, PRINCIPAL_BODY),
      PRINCIPAL_CONTENT_DIGEST,
    );
    assert.equal(
      deriveVNextWorkflowRunId(
        REPOSITORY_NODE,
        PRINCIPAL_NODE,
        "demo-issue-lifecycle",
        "v1",
        `sha256:${"a".repeat(64)}`,
      ),
      ADMISSION_WORKFLOW_RUN_ID,
    );
    assert.equal(
      deriveVNextRootTaskId(ADMISSION_WORKFLOW_RUN_ID, "demo-root-v1"),
      ADMISSION_ROOT_TASK_ID,
    );
    assert.equal(
      deriveVNextAdmissionId(ADMISSION_WORKFLOW_RUN_ID, ADMISSION_ROOT_TASK_ID),
      ADMISSION_ID,
    );
    assert.equal(
      deriveVNextPrincipalContentDigest("No body", null),
      deriveVNextPrincipalContentDigest("No body", ""),
    );
});

test("VNext principal reader verifies typed root ancestry and snapshot", async () => {
    const validatorTask = admissionValidatorTask();
    const rootIssue = makeVNextTask(
      {
        number: PARENT_NUMBER,
        nodeId: PARENT_NODE,
        id: 107,
      },
      admissionRootTask(),
    );
    const principal = makePrincipalIssue();
    await withFake(
      {
        tasks: [makeVNextTask({}, validatorTask), principal],
        parentIssue: rootIssue,
        children: [TASK_NUMBER],
      },
      async (fake) => {
        const response = await runTool(
          fake,
          IDS.result,
          "get_vnext_principal_issue",
          principalReadInput(validatorTask),
        );
        assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
        assert.deepEqual(response.result.structuredContent, {
          taskId: validatorTask.taskId,
          rootTaskId: ADMISSION_ROOT_TASK_ID,
          workflowRunId: ADMISSION_WORKFLOW_RUN_ID,
          principalIssue: {
            repositoryOwner: "drasi-project",
            repositoryName: "drasi-workgraph-demo",
            repositoryNodeId: REPOSITORY_NODE,
            issueNumber: PRINCIPAL_NUMBER,
            issueNodeId: PRINCIPAL_NODE,
            contentDigest: PRINCIPAL_CONTENT_DIGEST,
            title: PRINCIPAL_TITLE,
            body: PRINCIPAL_BODY,
          },
        });
        assert.equal(
          fake.state.operations.some((operation) => operation.startsWith("POST ")),
          false,
        );
      },
    );
});

test("VNext principal reader fails closed on stale content and wrong ancestry", async () => {
    const validatorTask = admissionValidatorTask();
    const scenarios = [
      {
        name: "stale principal content",
        rootTask: admissionRootTask(),
        principal: makePrincipalIssue({ body: `${PRINCIPAL_BODY}changed` }),
        children: [TASK_NUMBER],
        expected: /changed after admission/,
      },
      {
        name: "non-root parent",
        rootTask: {
          ...admissionRootTask(),
          taskDefinitionId: "demo-validate-v1",
        },
        principal: makePrincipalIssue(),
        children: [TASK_NUMBER],
        expected: /canonical parentless VNext root/,
      },
      {
        name: "non-deterministic root identity",
        rootTask: {
          ...admissionRootTask(),
          taskId: "wgt-wrong",
        },
        principal: makePrincipalIssue(),
        children: [TASK_NUMBER],
        expected: /deterministic admission identity/,
      },
      {
        name: "unpinned definition digest",
        rootTask: {
          ...admissionRootTask(),
          workflowDefinitionDigest: `sha256:${"b".repeat(64)}`,
        },
        validatorTask: {
          ...validatorTask,
          workflowDefinitionDigest: `sha256:${"b".repeat(64)}`,
        },
        principal: makePrincipalIssue(),
        children: [TASK_NUMBER],
        expected: /admission workflow/,
      },
      {
        name: "root has a native parent",
        rootTask: admissionRootTask(),
        principal: makePrincipalIssue(),
        children: [TASK_NUMBER, PARENT_NUMBER],
        expected: /canonical parentless VNext root/,
      },
      {
        name: "typed principal",
        rootTask: admissionRootTask(),
        principal: makePrincipalIssue({
          type: { name: "WorkGraphTask", node_id: TYPE_ID },
        }),
        children: [TASK_NUMBER],
        expected: /open ordinary Issue/,
      },
      {
        name: "missing principal",
        rootTask: admissionRootTask(),
        principal: null,
        children: [TASK_NUMBER],
        expected: /HTTP 404/,
      },
    ];
    for (const scenario of scenarios) {
      const rootIssue = makeVNextTask(
        {
          number: PARENT_NUMBER,
          nodeId: PARENT_NODE,
          id: 107,
        },
        scenario.rootTask,
      );
      await withFake(
        {
          tasks: [
            makeVNextTask({}, scenario.validatorTask ?? validatorTask),
            ...(scenario.principal ? [scenario.principal] : []),
          ],
          parentIssue: rootIssue,
          children: scenario.children,
        },
        async (fake) => {
          const response = await runTool(
            fake,
            IDS.result,
            "get_vnext_principal_issue",
            principalReadInput(scenario.validatorTask ?? validatorTask),
          );
          assert.equal(response.result.isError, true, scenario.name);
          assert.match(response.result.content[0].text, scenario.expected, scenario.name);
          assert.equal(
            fake.state.operations.some((operation) => operation.startsWith("POST ")),
            false,
            scenario.name,
          );
        },
      );
    }
});

test("VNext Result verifies Dispatch, writes once, and reconciles exact retry", async () => {
  const input = vnextResultInput({
    criteria: [
      { criterion: CRITERIA[0], evidence: "Present.", passed: true },
      { criterion: CRITERIA[1], evidence: "Present.", passed: true },
    ],
    summary: "Both required fields are present.",
  });
  await withFake(
    {
      tasks: [makeVNextTask()],
      comments: { [TASK_NUMBER]: [vnextDispatchComment()] },
    },
    async (fake) => {
      const first = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(first.result.isError, false, first.result.content?.[0]?.text);
      assert.equal(first.result.structuredContent.reconciled, false);
      assert.equal(
        first.result.structuredContent.resultId,
        deriveVNextTaskResultId(input.taskId, input.dispatchId, input.leaseId),
      );
      const body = fake.state.comments.get(TASK_NUMBER).at(-1).body;
      assert.equal(body, formatVNextTaskResult({
        resultId: first.result.structuredContent.resultId,
        taskId: input.taskId,
        dispatchId: input.dispatchId,
        leaseId: input.leaseId,
        outcome: input.outcome,
        output: input.output,
      }));
      const retry = await runTool(fake, IDS.result, "submit_task_result", input);
      assert.equal(retry.result.isError, false);
      assert.equal(retry.result.structuredContent.reconciled, true);
      fake.state.tasks.get(TASK_NUMBER).state = "closed";
      const closedRetry = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        input,
      );
      assert.equal(closedRetry.result.isError, false);
      assert.equal(closedRetry.result.structuredContent.reconciled, true);
      assert.equal(fake.state.comments.get(TASK_NUMBER).length, 2);
      assert.equal(fake.state.tasks.get(TASK_NUMBER).state, "closed");
      assert.equal(
        fake.state.operations.some((operation) => operation.startsWith("PATCH ")),
        false,
      );
      assert.equal(
        fake.state.operations.some((operation) => operation === "POST /lease/validate"),
        false,
      );
    },
  );
});

test("demo orchestrator reports a root Result without parent locator fields", async () => {
  const rootTask = {
    ...VNEXT_TASK,
    taskId: "task-root",
    taskDefinitionId: "demo-root-v1",
    resolvedInputs: { proofMode: "isolated" },
  };
  const rootDispatch = {
    ...VNEXT_DISPATCH,
    dispatchId: "dispatch-root",
    launchId: "launch-root",
    task: Object.fromEntries(
      Object.entries(rootTask).filter(([key]) => key !== "resolvedInputs"),
    ),
    lease: {
      leaseId: "lease-root",
      assignmentId: "assignment-root",
      executorId: "demo-orchestrator",
      slotId: "demo-orchestrator/1",
    },
  };
  const input = {
    taskLocator: {
      repositoryOwner: "drasi-project",
      repositoryName: "drasi-workgraph-demo",
      repositoryNodeId: REPOSITORY_NODE,
      issueNumber: TASK_NUMBER,
      issueNodeId: TASK_NODE,
    },
    taskId: rootTask.taskId,
    dispatchId: rootDispatch.dispatchId,
    leaseId: rootDispatch.lease.leaseId,
    outcome: "succeeded",
    output: {
      summary: "The isolated validation child completed.",
      directChildResults: {
        validate: { resultId: "child-result", outcome: "succeeded" },
      },
      directChildEvaluations: {
        validate: { evaluationId: "child-evaluation", route: "complete" },
      },
    },
  };
  await withFake(
    {
      tasks: [makeVNextTask({}, rootTask)],
      children: [],
      comments: {
        [TASK_NUMBER]: [vnextDispatchComment(rootDispatch)],
      },
    },
    async (fake) => {
      const response = await runTool(
        fake,
        IDS.result,
        "submit_task_result",
        input,
      );
      assert.equal(response.result.isError, false, response.result.content?.[0]?.text);
      assert.equal(response.result.structuredContent.reconciled, false);
      assert.equal(
        fake.state.comments.get(TASK_NUMBER).at(-1).body,
        formatVNextTaskResult({
          resultId: deriveVNextTaskResultId(
            input.taskId,
            input.dispatchId,
            input.leaseId,
          ),
          taskId: input.taskId,
          dispatchId: input.dispatchId,
          leaseId: input.leaseId,
          outcome: input.outcome,
          output: input.output,
        }),
      );
    },
  );
});

test("VNext Result fails closed on locator, Dispatch, and Result conflicts", async () => {
  const scenarios = [
    {
      name: "locator",
      input: {
        ...vnextResultInput(),
        taskLocator: {
          ...vnextResultInput().taskLocator,
          repositoryNodeId: "R_other",
        },
      },
      comments: [vnextDispatchComment()],
      expected: /repository does not match/,
    },
    {
      name: "foreign Dispatch",
      input: vnextResultInput(),
      comments: [vnextDispatchComment(VNEXT_DISPATCH, 999)],
      expected: /exactly one trusted canonical/,
    },
    {
      name: "wrong Lease",
      input: { ...vnextResultInput(), leaseId: "lease-other" },
      comments: [vnextDispatchComment()],
      expected: /Dispatch task or Lease identity/,
    },
    {
      name: "conflicting Result",
      input: vnextResultInput(),
      comments: [
        vnextDispatchComment(),
        vnextResultComment(vnextResultInput({ summary: "Different." })),
      ],
      expected: /conflicting Result/,
    },
    {
      name: "legacy Result",
      input: vnextResultInput(),
      comments: [vnextDispatchComment(), resultComment(PASS_RESULT)],
      expected: /conflicting Result/,
    },
  ];
  for (const scenario of scenarios) {
    await withFake(
      {
        tasks: [makeVNextTask()],
        comments: { [TASK_NUMBER]: scenario.comments },
      },
      async (fake) => {
        const response = await runTool(
          fake,
          IDS.result,
          "submit_task_result",
          scenario.input,
        );
        assert.equal(response.result.isError, true, scenario.name);
        assert.match(response.result.content[0].text, scenario.expected, scenario.name);
        assert.equal(
          fake.state.operations.some((operation) => operation.endsWith("/comments") && operation.startsWith("POST ")),
          false,
          scenario.name,
        );
      },
    );
  }
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
