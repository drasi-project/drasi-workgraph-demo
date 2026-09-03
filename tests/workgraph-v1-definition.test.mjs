import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MAX_REWORK_ATTEMPTS,
  MAX_TASK_DEFINITION_CHILDREN,
  MAX_TASK_DEFINITION_DEPTH,
  MAX_TASK_DEFINITION_EXECUTORS,
  MAX_TASK_RESPONSE_BODY_BYTES,
  RESERVED_RUNTIME_INPUT_KEYS,
  RUNTIME_TASK_MARKER,
  TASK_ERROR_MARKER,
  TASK_FORK_MARKER,
  TASK_JOIN_MARKER,
  decodeWorkGraphText,
  deriveWorkGraphProtocolId,
  deriveWorkGraphResponseBodyDigest,
  deriveWorkGraphTaskResponseId,
  encodeWorkGraphText,
  deriveWorkGraphTaskEvaluationId,
  deriveWorkGraphTaskErrorId,
  deriveWorkGraphTaskForkId,
  deriveWorkGraphTaskJoinId,
  deriveWorkGraphTaskResultId,
  deriveWorkGraphTaskRouteId,
  formatTaskEvaluation,
  formatTaskAssignment,
  formatTaskDispatch,
  formatTaskError,
  formatTaskFork,
  formatTaskJoin,
  formatTaskResult,
  formatTaskResponse,
  formatTaskRoute,
  formatCompiledWorkflowDefinition,
  formatRuntimeTask,
  formatWorkflowDefinition,
  nextReworkAttempt,
  normalizeCompiledWorkflowDefinition,
  normalizeIssueWorkflow,
  parseTaskEvaluation,
  parseTaskAssignment,
  parseTaskDispatch,
  parseTaskError,
  parseTaskFork,
  parseTaskResponse,
  parseTaskJoin,
  parseWorkGraphTaskAction,
  parseTaskResult,
  parseTaskRoute,
  parseCompiledWorkflowDefinition,
  parseRuntimeTask,
  parseWorkflowDefinition,
  resolveCompiledFlowScopes,
  startsWithWorkGraphMention,
  taskResultDigest,
  workerSelectorCandidates,
  workerSelectorPreferred,
  validateRootRuntimeTask,
  validateTaskRouteAgainstDefinition,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import {
  buildWorkGraphV1Proof,
  validateGeneratedQueryInventory,
} from "../scripts/prepare-workgraph-v1-proof.mjs";

const DEFINITION_PATH = ".github/workgraph/workflows/issue-lifecycle-v1.body";
const INPUTS_PATH = ".github/workgraph/fixtures/v1/live-proof-inputs.json";
const AUTHORING_PATH = ".github/workgraph/workflows/issue-lifecycle.yaml";
const TEST_CASE_PATH = ".github/workgraph/tests/linear-sequence-v1.json";
const EXPECTED_PATH =
  ".github/workgraph/fixtures/v1/issue-lifecycle.expected.json";
const SCOPED_DEFINITION_PATH =
  ".github/workgraph/workflows/scoped-control-flow-v1.body";
const SCOPED_AUTHORING_PATH =
  ".github/workgraph/workflows/scoped-control-flow.yaml";
const SCOPED_TEST_CASE_PATH =
  ".github/workgraph/tests/scoped-control-flow-v1.json";
const SCOPED_EXPECTED_PATH =
  ".github/workgraph/fixtures/v1/scoped-control-flow.expected.json";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const clone = (value) => structuredClone(value);
const COMPILED_OUTPUT = JSON.parse(await read(EXPECTED_PATH));
const COMPILED_FIXTURE = COMPILED_OUTPUT.workgraphDefinition;
const protocolId = (type, seed) => deriveWorkGraphProtocolId(type, [seed]);
const MESSAGE_RUN_ID = protocolId("workflow-run", "message-run");
const TASK_C_ID = protocolId("task", "task-c");
const VECTOR_TASK_ID = protocolId("task", "task-1");
const ASSIGNMENT_ID = protocolId("assignment", "assignment-1");
const DISPATCH_ID = protocolId("dispatch", "dispatch-1");
const LEASE_ID = protocolId("lease", "lease-1");
const LAUNCH_ID = protocolId("dispatch-launch", "launch-1");
const RESULT_ID = protocolId("result", "result-1");
const PROOF_QUERY_IDS = [
  "wg-issues-waiting-for-admission",
  "wg-tasks-waiting-for-fork",
  "wg-tasks-waiting-for-fork-action",
  "wg-tasks-waiting-for-join-all",
  "wg-tasks-waiting-for-join-action",
  "wg-task-leaves-waiting-for-assign",
  "wg-task-parents-waiting-for-assign",
  "wg-tasks-waiting-for-lease",
  "wg-tasks-waiting-for-dispatch",
  "wg-tasks-waiting-for-result",
  "wg-tasks-waiting-for-evaluate",
  "wg-tasks-waiting-for-route",
  "wg-tasks-waiting-for-close",
  "wg-tasks-closed",
  "wg-task-detail",
  "wg-task-definition-detail",
  "wg-child-realization-detail",
  "wg-task-artifact-detail",
  "wg-result-detail",
  "wg-evaluation-detail",
  "wg-route-detail",
  "wg-error-detail",
  "wg-terminal-detail",
  "wg-predecessor-result-detail",
];
const sourceContext = (stepId) => ({
  sourceStepId: stepId,
  taskDefinitionId:
    COMPILED_FIXTURE.steps[stepId].taskDefinition.taskDefinitionId,
});

function nestedDefinition() {
  return {
    workflowDefinitionId: "issue-validation",
    version: "v1",
    digest: `sha256:${"a".repeat(64)}`,
    root: {
      taskDefinitionId: protocolId("task-definition", "issue-validation-root"),
      taskKey: "root",
      operation: "summarize",
      routing: { permittedExecutors: ["summary-agent"] },
      staticInputs: { objective: "validate the issue" },
      children: [
        {
          taskDefinitionId: protocolId("task-definition", "issue-validation-body"),
          taskKey: "body",
          operation: "validate-body",
          routing: { permittedExecutors: ["body-agent"] },
          staticInputs: {},
          children: [
            {
              taskDefinitionId: protocolId(
                "task-definition",
                "issue-validation-body-links",
              ),
              taskKey: "body-links",
              operation: "validate-links",
              routing: { permittedExecutors: ["link-agent"] },
              staticInputs: {},
              children: [],
            },
          ],
        },
        {
          taskDefinitionId: protocolId("task-definition", "issue-validation-title"),
          taskKey: "title",
          operation: "validate-title",
          routing: { permittedExecutors: ["title-agent"] },
          staticInputs: {},
          children: [],
        },
      ],
    },
  };
}

function taskDefinitions(root) {
  return [root, ...root.children.flatMap(taskDefinitions)];
}

test("the v1 workflow definition remains byte exact", async () => {
  const body = await read(DEFINITION_PATH);
  assert.equal(body, COMPILED_OUTPUT.canonicalDefinitionBody);
  const definition = parseCompiledWorkflowDefinition(body);
  assert.equal(formatCompiledWorkflowDefinition(definition), body);
  assert.equal(definition.version, "v1");
  assert.equal(definition.digest, COMPILED_OUTPUT.definitionDigest);
  assert.equal(Object.keys(definition.steps).length, 5);
  assert.deepEqual(
    Object.values(definition.steps)
      .filter(({ type }) => type === "task")
      .map(({ taskDefinition }) => taskDefinition.taskKey),
    ["a", "b", "c", "d"],
  );
});

test("recursive definitions preserve deterministic global task identities", () => {
  const definition = parseWorkflowDefinition(
    formatWorkflowDefinition(nestedDefinition()),
  );
  const tasks = taskDefinitions(definition.root);
  assert.deepEqual(
    definition.root.children.map(({ taskKey }) => taskKey),
    ["body", "title"],
  );
  assert.deepEqual(
    definition.root.children[0].children.map(({ taskKey }) => taskKey),
    ["body-links"],
  );
  assert.equal(
    new Set(tasks.map(({ taskDefinitionId }) => taskDefinitionId)).size,
    tasks.length,
  );
  assert.equal(new Set(tasks.map(({ taskKey }) => taskKey)).size, tasks.length);
});

test("formatting canonicalizes data maps and requires child ordering", () => {
  const definition = nestedDefinition();
  definition.root.staticInputs = {
    proofMode: "isolated",
    evaluationRoutes: { succeeded: "complete", failed: "fail" },
  };
  const body = formatWorkflowDefinition(definition);
  assert.ok(body.indexOf('"evaluationRoutes"') < body.indexOf('"proofMode"'));
  assert.ok(body.indexOf('"failed"') < body.indexOf('"succeeded"'));

  definition.root.children.reverse();
  assert.throws(
    () => formatWorkflowDefinition(definition),
    /children must be ordered by unique taskKey/,
  );
});

test("definition validation rejects duplicate identities and invalid bounds", () => {
  const duplicate = nestedDefinition();
  duplicate.root.children[1].taskDefinitionId =
    duplicate.root.children[0].taskDefinitionId;
  assert.throws(
    () => formatWorkflowDefinition(duplicate),
    /repeats taskDefinitionId/,
  );

  const tooWide = nestedDefinition();
  const leaf = clone(tooWide.root.children[1]);
  tooWide.root.children = Array.from(
    { length: MAX_TASK_DEFINITION_CHILDREN + 1 },
    (_, index) => ({
      ...clone(leaf),
      taskDefinitionId: `wide-${String(index).padStart(2, "0")}`,
      taskKey: `wide-${String(index).padStart(2, "0")}`,
    }),
  );
  assert.throws(
    () => formatWorkflowDefinition(tooWide),
    /exceeds 16 direct children/,
  );

  for (const permittedExecutors of [
    [],
    ["issue-validator", "issue-validator"],
    Array.from({ length: 9 }, (_, index) => `executor-${index}`),
  ]) {
    const invalid = nestedDefinition();
    invalid.root.routing.permittedExecutors = permittedExecutors;
    assert.throws(
      () => formatWorkflowDefinition(invalid),
      /permittedExecutors|repeats permitted executor/,
    );
  }
});

test("parsing rejects unknown, oversized, reserved-marker, and noncanonical bodies", async () => {
  const definition = nestedDefinition();
  const unknown = clone(definition);
  unknown.root.unexpected = true;
  assert.throws(
    () => formatWorkflowDefinition(unknown),
    /properties must be exactly/,
  );

  for (const marker of [
    "WorkGraphTask/v1",
    "WorkGraphTaskAssignment/v1",
    "WorkGraphTaskDispatch/v1",
    "WorkGraphTaskResult/v1",
    "WorkGraphTaskEvaluation/v1",
    "WorkGraphTaskRoute/v1",
    "WorkGraphTaskError/v1",
  ]) {
    const marked = clone(definition);
    marked.root.staticInputs = { unsafe: marker };
    assert.throws(() => formatWorkflowDefinition(marked), /protocol markers/);
  }

  const body = formatWorkflowDefinition(definition);
  assert.throws(
    () => parseWorkflowDefinition(body.replace('  "version"', ' "version"')),
    /not canonical/,
  );
  assert.throws(
    () => parseWorkflowDefinition(body.replace("\n", "\r\n")),
    /not canonical/,
  );
  const oversized = clone(definition);
  oversized.root.staticInputs = { payload: "x".repeat(64 * 1024) };
  assert.throws(
    () => formatWorkflowDefinition(oversized),
    /exceeds 65536 bytes/,
  );
});

test("runtime tasks require top-level Root Issue identity and exact definition pins", async () => {
  const proof = await buildWorkGraphV1Proof();
  const definition = parseCompiledWorkflowDefinition(await read(DEFINITION_PATH));
  const body = proof.expectedRootTask.body;
  const root = parseRuntimeTask(body);
  assert.equal(root.rootIssueId, "I_workgraph_root_issue");
  assert.equal(root.taskKey, "a");
  assert.equal(root.operation, "intake-issue");
  assert.equal(formatRuntimeTask(root), body);
  const envelope = JSON.parse(body.match(/```json\n([\s\S]+)\n```/)[1]);
  assert.equal(envelope.kind, "Task");
  assert.equal(envelope.id, root.taskId);
  assert.deepEqual(envelope.references, {});
  assert.equal(envelope.workflowContext.taskKey, root.taskKey);
  assert.deepEqual(envelope.data, { resolvedInputs: root.resolvedInputs });
  assert.deepEqual(validateRootRuntimeTask(definition, root), root);

  for (const [field, value] of [
    ["workflowDefinitionId", "different-workflow"],
    ["workflowDefinitionVersion", "different-version"],
    ["workflowDefinitionDigest", `sha256:${"b".repeat(64)}`],
    ["taskDefinitionId", "different-root"],
    ["taskKey", "different-key"],
    ["operation", "different-operation"],
  ]) {
    assert.throws(
      () => validateRootRuntimeTask(definition, { ...root, [field]: value }),
      new RegExp(field),
    );
  }
  const missingRootIssue = { ...root };
  delete missingRootIssue.rootIssueId;
  assert.throws(
    () => formatRuntimeTask(missingRootIssue),
    /properties must be exactly/,
  );
  const legacy = { ...root };
  delete legacy.taskKey;
  delete legacy.operation;
  const legacyBody = `${RUNTIME_TASK_MARKER}\n\n\`\`\`json\n${JSON.stringify(legacy, null, 2)}\n\`\`\`\n`;
  assert.throws(() => parseRuntimeTask(legacyBody), /properties must be exactly/);
  assert.throws(() => formatRuntimeTask(legacy), /properties must be exactly/);
});

test("proof inputs pin the exact loopback query contract and remain inactive", async () => {
  const inputs = JSON.parse(await read(INPUTS_PATH));
  assert.deepEqual(Object.keys(inputs.runtimeContract).sort(), [
    "queryContractDigest",
    "queryIds",
    "reactionId",
    "serverConfig",
    "sourceId",
    "stateStorePath",
  ]);
  assert.deepEqual(inputs.runtimeContract.queryIds, PROOF_QUERY_IDS);
  assert.equal(
    inputs.runtimeContract.serverConfig,
    "server-config-v1-loopback.yaml",
  );
  assert.equal(
    inputs.runtimeContract.stateStorePath,
    "data/workgraph-v1-loopback.redb",
  );
  const canonicalGenericInventory = JSON.parse(
    await readFile(
      new URL(
        "../../drasi-dogfooding/.github/extensions/workgraph-v1-view/contract/query-inventory.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const digestEntries = [
    ...canonicalGenericInventory.admissionQueries,
    ...canonicalGenericInventory.lifecycleQueries,
    ...canonicalGenericInventory.detailQueries,
    ...COMPILED_OUTPUT.queryBundle.canvasInventory,
  ].map(({ id, sha256 }) => ({ id, sha256 }));
  assert.deepEqual(
    digestEntries.map(({ id }) => id),
    PROOF_QUERY_IDS,
  );
  const queryContractDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(digestEntries), "utf8")
    .digest("hex")}`;
  assert.equal(
    inputs.runtimeContract.queryContractDigest,
    "sha256:85a25c8f38b4a31868c0934771c9bf698e433f15b99f59aed3f2cd73069c7ec7",
  );
  assert.equal(inputs.runtimeContract.queryContractDigest, queryContractDigest);
  assert.deepEqual(inputs.activation, {
    serverAutoStart: false,
    sourceAutoStart: false,
    queryAutoStart: false,
    reactionMode: "disabled",
    dryRun: true,
    liveAcknowledgment: false,
    githubWritesAllowed: false,
  });
  assert.equal(inputs.rootIssueAdmission.label, "workgraph");
  assert.equal(
    inputs.leaseValidation.path,
    "/github/workgraph-v1/lease/validate",
  );
  assert.deepEqual(inputs.leaseValidation.requestFields, [
    "taskId",
    "leaseId",
    "assignmentId",
    "executorId",
    "slotId",
    "claimId",
  ]);
});

test("offline proof derives the Root Task from Root Issue admission", async () => {
  const proof = await buildWorkGraphV1Proof();
  assert.deepEqual(proof.expectedAdmissionQuery, {
    queryId: "wg-issues-waiting-for-admission",
    rootIssueId: "I_workgraph_root_issue",
    admissionId:
      "urn:drasi:workgraph:id:v1:admission:sha256:077e3315d4fcc9cbd8eb0377863c0bac07f859bbb0143b5661e3101ca1276198",
  });
  assert.equal(
    proof.expectedRootTask.value.taskId,
    "urn:drasi:workgraph:id:v1:task:sha256:f000b1854ea3b9b009c43bdbf68e7786298016514e52a81d46f5461116b4ee4b",
  );
  assert.equal(
    proof.expectedRootTask.value.workflowRunId,
    "urn:drasi:workgraph:id:v1:workflow-run:sha256:086749d7bbfd8c7b6f665a099f7344d71314674c9f89f1a2021f0c9ac2ff1691",
  );
  assert.equal(
    proof.expectedRootTask.value.resolvedInputs.rootIssue.issueNodeId,
    proof.expectedRootTask.value.rootIssueId,
  );
  assert.equal(proof.expectedRootTask.firstLifecycleState, "ASSIGN");
});

test("offline proof rejects per-edge generated queries", () => {
  const queryBundle = clone(COMPILED_OUTPUT.queryBundle);
  queryBundle.queries.push({ id: "wg-next-legacy", query: "RETURN 1" });
  queryBundle.canvasInventory.push({
    id: "wg-next-legacy",
    sha256: "0".repeat(64),
  });
  assert.throws(
    () => validateGeneratedQueryInventory(queryBundle),
    /must not generate per-edge queries/,
  );
});

function linearWorkflow() {
  const task = (operation, next) => ({
    type: "task",
    operation,
    worker: "issue-worker",
    inputs: {},
    next,
  });
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "issue-lifecycle" },
    spec: {
      trigger: "workgraph",
      initial: "a",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
      steps: {
        a: task("intake-issue", "b"),
        b: task("normalize-issue", "c"),
        c: task("inspect-issue", "d"),
        d: task("finalize-issue", "completed"),
        completed: { type: "terminal", outcome: "completed" },
      },
    },
  };
}

function complexWorkflow() {
  const task = (operation, worker, transition, inputs = {}) => {
    const value = { type: "task", operation, worker, inputs };
    if (typeof transition === "string") value.next = transition;
    else value.outcomes = transition;
    return value;
  };
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "issue-lifecycle" },
    spec: {
      trigger: "workgraph",
      initial: "a",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
      steps: {
        a: task("intake-issue", "issue-worker", "b"),
        b: task("normalize-issue", "issue-worker", "c"),
        c: {
          type: "task",
          operation: "validate-issue",
          worker: "issue-validator",
          inputs: { profile: "new-issue-default" },
          evaluator: "issue-validation-evaluator",
          outcomes: { "needs-info": "d", continue: "e", reject: "f" },
        },
        d: task(
          "request-information",
          "issue-info-requester",
          "human",
          { source: "c" },
        ),
        human: {
          type: "wait",
          event: "root-issue-commented",
          next: "c",
        },
        e: task("triage-issue", "issue-worker", "g"),
        f: task(
          "record-rejection",
          "issue-worker",
          "ignored",
        ),
        g: {
          ...task(
            "coordinate-validation",
            "issue-worker",
            "h",
          ),
          orchestrator: "validation-stage-coordinator",
          maxReworkAttempts: 2,
          children: {
            join: "all",
            tasks: {
              title: {
                operation: "validate-title",
                worker: "issue-validator",
                inputs: { field: "title" },
              },
              body: {
                operation: "validate-body",
                worker: "issue-validator",
                inputs: { field: "body" },
              },
              reproduction: {
                operation: "validate-reproduction",
                worker: "issue-validator",
                inputs: { section: "reproduction" },
              },
            },
          },
        },
        h: task("finalize-issue", "issue-worker", "completed"),
        completed: { type: "terminal", outcome: "completed" },
        ignored: { type: "terminal", outcome: "ignored" },
      },
    },
  };
}

test("linear v1 authoring and test case match the compiled sequence", async () => {
  const [yaml, expected, testCase] = await Promise.all([
    read(AUTHORING_PATH),
    read(EXPECTED_PATH).then(JSON.parse),
    read(TEST_CASE_PATH).then(JSON.parse),
  ]);
  assert.match(yaml, /^apiVersion: workgraph\.drasi\.io\/v1$/m);
  assert.match(yaml, /^  trigger: workgraph$/m);
  assert.match(yaml, /^  initial: a$/m);
  assert.match(yaml, /^    maxReworkAttempts: 3$/m);
  assert.doesNotMatch(yaml, /\bagent:|\bmaxRework:|waitFor:|^\s+[A-H]:/m);
  assert.doesNotMatch(yaml, /^\s+(?:children|outcomes):/m);
  assert.doesNotMatch(yaml, /^\s+type: wait$/m);
  assert.doesNotMatch(yaml, /status:\s*new/i);
  assert.deepEqual(
    normalizeCompiledWorkflowDefinition(expected.workgraphDefinition),
    expected.workgraphDefinition,
  );
  assert.equal(
    expected.definitionDigest,
    expected.workgraphDefinition.digest,
  );
  assert.equal(
    expected.canonicalDefinitionBody.startsWith(
      "WorkGraphWorkflowDefinition/v1\n\n```json\n",
    ),
    true,
  );
  assert.equal(
    expected.workgraphDefinition.defaults.maxReworkAttempts,
    DEFAULT_MAX_REWORK_ATTEMPTS,
  );
  const definition = expected.workgraphDefinition;
  const taskEntries = Object.entries(definition.steps).filter(
    ([, step]) => step.type === "task",
  );
  const taskKeys = taskEntries.map(([stepId]) => stepId);
  assert.deepEqual(taskKeys, ["a", "b", "c", "d"]);
  for (const [stepId, step] of taskEntries) {
    assert.equal(step.taskDefinition.taskKey, stepId);
    assert.deepEqual(step.taskDefinition.children, []);
    assert.deepEqual(step.taskDefinition.routing.permittedExecutors, [
      "issue-worker",
    ]);
    assert.equal(step.transition.type, "next");
    assert.deepEqual(Object.values(step.executionPolicies), [
      {
        workerId: "issue-worker",
        evaluatorId: "result-evaluator",
        orchestratorId: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
    ]);
  }
  assert.equal(
    Object.values(definition.steps).some(({ type }) => type === "wait"),
    false,
  );
  assert.deepEqual(
    Object.values(definition.steps)
      .filter(({ type }) => type === "terminal")
      .map(({ outcome }) => outcome),
    ["completed"],
  );
  const generatedQueryIds = expected.queryBundle.queries.map(({ id }) => id);
  assert.deepEqual(generatedQueryIds, []);

  assert.deepEqual(Object.keys(testCase), [
    "apiVersion",
    "kind",
    "metadata",
    "spec",
  ]);
  assert.equal(testCase.apiVersion, "drasi.io/v1");
  assert.equal(testCase.kind, "WorkGraphTestCase");
  assert.deepEqual(testCase.metadata, { id: "linear-sequence" });
  assert.deepEqual(Object.keys(testCase.spec), [
    "workflowDefinitionId",
    "rootIssue",
    "steps",
    "expected",
  ]);
  assert.equal(
    testCase.spec.workflowDefinitionId,
    definition.workflowDefinitionId,
  );
  assert.deepEqual(Object.keys(testCase.spec.rootIssue), [
    "title",
    "body",
    "labels",
  ]);
  assert.equal(typeof testCase.spec.rootIssue.title, "string");
  assert.equal(typeof testCase.spec.rootIssue.body, "string");
  assert.deepEqual(testCase.spec.rootIssue.labels, ["workgraph"]);
  assert.deepEqual(Object.keys(testCase.spec.steps), taskKeys);
  for (const stepId of taskKeys) {
    const step = testCase.spec.steps[stepId];
    assert.deepEqual(Object.keys(step), ["result", "evaluationVerdict"]);
    assert.deepEqual(Object.keys(step.result), ["outcome", "output"]);
    assert.equal(step.result.outcome, "succeeded");
    assert.deepEqual(step.result.output, { step: stepId });
    assert.equal(step.evaluationVerdict, "accepted");
  }
  assert.deepEqual(Object.keys(testCase.spec.expected), [
    "topLevelTaskKeys",
    "taskParents",
    "terminalOutcome",
  ]);
  assert.deepEqual(testCase.spec.expected.topLevelTaskKeys, taskKeys);
  assert.deepEqual(
    testCase.spec.expected.taskParents,
    Object.fromEntries(taskKeys.map((taskKey) => [taskKey, null])),
  );
  const traversed = [];
  let stepId = definition.initialStepId;
  while (definition.steps[stepId].type === "task") {
    assert.equal(traversed.includes(stepId), false);
    traversed.push(stepId);
    stepId = definition.steps[stepId].transition.targetStepId;
  }
  assert.deepEqual(traversed, taskKeys);
  assert.equal(definition.steps[stepId].type, "terminal");
  assert.equal(
    definition.steps[stepId].outcome,
    testCase.spec.expected.terminalOutcome,
  );

  const wrongTerminal = clone(definition);
  wrongTerminal.steps.completed.outcome = "done";
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(wrongTerminal),
    /invalid terminal outcome/,
  );

  const missingPolicy = clone(definition);
  const cId = missingPolicy.steps.c.taskDefinition.taskDefinitionId;
  delete missingPolicy.steps.c.executionPolicies[cId];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(missingPolicy),
    /non-empty map|exactly match all recursive taskDefinitionIds/,
  );

  const extraPolicy = clone(definition);
  extraPolicy.steps.c.executionPolicies[
    protocolId("task-definition", "extra-policy")
  ] = {
    workerId: "issue-worker",
    evaluatorId: "result-evaluator",
    orchestratorId: "workflow-coordinator",
    maxReworkAttempts: 3,
  };
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(extraPolicy),
    /exactly match all recursive taskDefinitionIds/,
  );

  const wrongWorker = clone(definition);
  wrongWorker.steps.c.executionPolicies[cId].workerId = "other-worker";
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(wrongWorker),
    /workerId must be one of its permitted executors/,
  );
});

test("fork and mixed fixtures preserve hierarchy and branch paths without per-edge queries", async () => {
  const [fork, forkCase, mixed, parallelCase, skipCase, rejectCase] =
    await Promise.all([
      read(".github/workgraph/fixtures/v1/fork-join-lifecycle.expected.json").then(
        JSON.parse,
      ),
      read(".github/workgraph/tests/fork-join-v1.json").then(JSON.parse),
      read(".github/workgraph/fixtures/v1/mixed-control-flow.expected.json").then(
        JSON.parse,
      ),
      read(".github/workgraph/tests/mixed-parallel-v1.json").then(JSON.parse),
      read(".github/workgraph/tests/mixed-skip-v1.json").then(JSON.parse),
      read(".github/workgraph/tests/mixed-reject-v1.json").then(JSON.parse),
    ]);

  assert.deepEqual(fork.queryBundle.queries, []);
  assert.deepEqual(mixed.queryBundle.queries, []);
  const forkDefinition = fork.workgraphDefinition;
  assert.deepEqual(
    Object.values(forkDefinition.steps)
      .filter(({ type }) => type === "task")
      .map(({ taskDefinition }) => taskDefinition.taskKey),
    ["a", "b", "f", "g"],
  );
  assert.deepEqual(
    forkDefinition.steps.b.taskDefinition.children.map(({ taskKey }) => taskKey),
    ["c", "d", "e"],
  );
  assert.equal(
    Object.keys(forkDefinition.steps.b.executionPolicies).length,
    4,
  );
  assert.deepEqual(forkCase.spec.expected.taskParents, {
    a: null,
    b: null,
    c: "b",
    d: "b",
    e: "b",
    f: null,
    g: null,
  });

  const mixedDefinition = mixed.workgraphDefinition;
  assert.deepEqual(mixedDefinition.steps.c.transition, {
    type: "outcomes",
    targets: {
      parallel: "g",
      reject: "ignored",
      skip: "h",
    },
  });
  assert.deepEqual(
    mixedDefinition.steps.g.taskDefinition.children.map(({ taskKey }) => taskKey),
    ["d", "e", "f"],
  );
  assert.deepEqual(parallelCase.spec.expected.topLevelTaskKeys, [
    "a",
    "b",
    "c",
    "g",
    "h",
  ]);
  assert.deepEqual(skipCase.spec.expected.topLevelTaskKeys, ["a", "b", "c", "h"]);
  assert.equal(skipCase.spec.expected.terminalOutcome, "completed");
  assert.deepEqual(rejectCase.spec.expected.topLevelTaskKeys, ["a", "b", "c"]);
  assert.equal(rejectCase.spec.expected.terminalOutcome, "ignored");
});

test("high-level IssueWorkflow shape is strict and resolves all graph references", () => {
  const workflow = linearWorkflow();
  assert.deepEqual(normalizeIssueWorkflow(workflow), COMPILED_OUTPUT.definition);

  const wrongTrigger = clone(workflow);
  wrongTrigger.spec.trigger = "new";
  assert.throws(() => normalizeIssueWorkflow(wrongTrigger), /must be workgraph/);

  const inlineWait = clone(workflow);
  inlineWait.spec.steps.b.next = {
    event: "root-issue-commented",
    next: "c",
  };
  assert.throws(
    () => normalizeIssueWorkflow(inlineWait),
    /lowercase step ID/,
  );

  const missingTarget = clone(workflow);
  missingTarget.spec.steps.c.next = "missing";
  assert.throws(
    () => normalizeIssueWorkflow(missingTarget),
    /declared workflow step/,
  );

  const outcomeList = clone(workflow);
  delete outcomeList.spec.steps.c.next;
  outcomeList.spec.steps.c.outcomes = [
    { outcome: "continue", target: "d" },
  ];
  assert.throws(
    () => normalizeIssueWorkflow(outcomeList),
    /non-empty map/,
  );

  const bothTransitions = clone(workflow);
  bothTransitions.spec.steps.c.outcomes = { continue: "d" };
  assert.throws(
    () => normalizeIssueWorkflow(bothTransitions),
    /exactly one of next or outcomes/,
  );

  const unsafeRework = clone(workflow);
  unsafeRework.spec.steps.c.maxReworkAttempts = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => normalizeIssueWorkflow(unsafeRework),
    /safe integer/,
  );

  const omittedInputs = clone(workflow);
  delete omittedInputs.spec.steps.a.inputs;
  const normalized = normalizeIssueWorkflow(omittedInputs);
  assert.deepEqual(normalized.spec.steps.a.inputs, {});

  for (const type of ["wait", "terminal"]) {
    const invalidInitial = clone(
      type === "wait" ? complexWorkflow() : workflow,
    );
    invalidInitial.spec.initial = type === "wait" ? "human" : "completed";
    assert.throws(
      () => normalizeIssueWorkflow(invalidInitial),
      /initial step must be a task/,
    );
  }

  const unreachableError = clone(workflow);
  unreachableError.spec.steps.error = { type: "terminal", outcome: "error" };
  assert.throws(
    () => normalizeIssueWorkflow(unreachableError),
    /unreachable steps: error/,
  );
});

test("recursive child namespaces and overrides are independent at every depth", () => {
  const workflow = complexWorkflow();
  workflow.spec.steps.g.children.tasks.title = {
    ...workflow.spec.steps.g.children.tasks.title,
    evaluator: "issue-validation-evaluator",
    orchestrator: "validation-stage-coordinator",
    maxReworkAttempts: 1,
    children: {
      join: "all",
      tasks: {
        a: {
          operation: "validate-title-format",
          worker: "issue-validator",
          inputs: { format: "plain-text" },
          maxReworkAttempts: 0,
        },
      },
    },
  };
  const normalized = normalizeIssueWorkflow(workflow);
  const title = normalized.spec.steps.g.children.tasks.title;
  assert.equal(title.evaluator, "issue-validation-evaluator");
  assert.equal(title.maxReworkAttempts, 1);
  assert.equal(title.children.tasks.a.maxReworkAttempts, 0);
  assert.equal(title.children.tasks.a.orchestrator, null);
  assert.ok(normalized.spec.steps.a);
});

test("graph validation rejects unreachable work and cycles without waits", () => {
  const unreachable = complexWorkflow();
  unreachable.spec.steps.orphan = {
    type: "task",
    operation: "orphan",
    worker: "issue-worker",
    inputs: {},
    next: "completed",
  };
  assert.throws(
    () => normalizeIssueWorkflow(unreachable),
    /unreachable steps: orphan/,
  );

  const noTerminal = complexWorkflow();
  noTerminal.spec.steps.c.outcomes = { continue: "e" };
  delete noTerminal.spec.steps.h.outcomes;
  noTerminal.spec.steps.h.next = "e";
  assert.throws(
    () => normalizeIssueWorkflow(noTerminal),
    /cycle without a wait|reach at least one terminal/,
  );

  const unconditionalCycle = complexWorkflow();
  unconditionalCycle.spec.steps.e.next = "a";
  assert.throws(
    () => normalizeIssueWorkflow(unconditionalCycle),
    /cycle without a wait/,
  );

  assert.doesNotThrow(() => normalizeIssueWorkflow(complexWorkflow()));
});

function messageTask(taskId = TASK_C_ID) {
  return {
    taskId,
    workflowRunId: MESSAGE_RUN_ID,
    workflowDefinitionId: COMPILED_FIXTURE.workflowDefinitionId,
    workflowDefinitionVersion: COMPILED_FIXTURE.version,
    workflowDefinitionDigest: COMPILED_FIXTURE.digest,
    taskDefinitionId: COMPILED_FIXTURE.steps.c.taskDefinition.taskDefinitionId,
    taskKey: "c",
    operation: "inspect-issue",
  };
}

function evaluation(verdict = "accepted") {
  const resultDigest = `sha256:${"a".repeat(64)}`;
  return {
    evaluationId: deriveWorkGraphTaskEvaluationId(
      TASK_C_ID,
      RESULT_ID,
      resultDigest,
    ),
    rootIssueId: "I_root_issue",
    workflowRunId: MESSAGE_RUN_ID,
    taskId: TASK_C_ID,
    task: messageTask(),
    resultId: RESULT_ID,
    resultDigest,
    evaluatorId: "result-evaluator",
    attempt: 1,
    verdict,
    summary: "The Result satisfies the evaluation contract.",
    feedback: verdict === "rejected" ? "Correct the Result and try again." : "",
  };
}

function route(action, verdict = "accepted") {
  const evaluationId = evaluation().evaluationId;
  const value = {
    routeId: deriveWorkGraphTaskRouteId(TASK_C_ID, evaluationId),
    rootIssueId: "I_root_issue",
    workflowRunId: MESSAGE_RUN_ID,
    taskId: TASK_C_ID,
    task: messageTask(),
    resultId: RESULT_ID,
    evaluationId,
    evaluationVerdict: verdict,
    orchestratorId: "workflow-coordinator",
    action,
    attempt: 1,
  };
  if (action === "advance") {
    value.transitionKind = "next";
    value.targetStepId = "d";
    value.targetStepKind = "task";
    value.targetTaskDefinitionId =
      COMPILED_FIXTURE.steps.d.taskDefinition.taskDefinitionId;
  }
  return value;
}

test("all lifecycle bodies use the strict unified envelope", () => {
  const task = messageTask();
  const assignment = {
    assignmentId: ASSIGNMENT_ID,
    rootIssueId: "I_root_issue",
    workflowRunId: MESSAGE_RUN_ID,
    taskId: task.taskId,
    task,
    joinId: null,
    permittedExecutors: ["issue-worker"],
  };
  const dispatch = {
    dispatchId: DISPATCH_ID,
    launchId: LAUNCH_ID,
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    lease: {
      leaseId: LEASE_ID,
      assignmentId: assignment.assignmentId,
      executorId: "issue-worker",
      slotId: "slot-1",
    },
  };
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      task.taskId,
      dispatch.dispatchId,
      dispatch.lease.leaseId,
    ),
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.lease.leaseId,
    attempt: 1,
    outcome: "failed",
    output: { summary: "worker failed" },
  };
  const errorReferences = {
    forkId: null,
    joinId: null,
    assignmentId: null,
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.lease.leaseId,
    resultId: result.resultId,
    evaluationId: protocolId("evaluation", "error-evaluation"),
    routeId: protocolId("route", "error-route"),
  };
  const error = {
    errorId: deriveWorkGraphTaskErrorId(
      task.taskId,
      "routing",
      "workflow-routed-to-error",
      errorReferences.routeId,
    ),
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    references: errorReferences,
    stage: "routing",
    code: "workflow-routed-to-error",
    category: "task",
    summary: "The workflow routed to error.",
    retryable: false,
    attempt: null,
    details: { routeAction: "error" },
  };

  for (const [value, format, parse] of [
    [assignment, formatTaskAssignment, parseTaskAssignment],
    [dispatch, formatTaskDispatch, parseTaskDispatch],
    [result, formatTaskResult, parseTaskResult],
    [evaluation(), formatTaskEvaluation, parseTaskEvaluation],
    [route("complete"), formatTaskRoute, parseTaskRoute],
    [error, formatTaskError, parseTaskError],
  ]) {
    const body = format(value);
    assert.deepEqual(parse(body), value);
    const envelope = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
    assert.deepEqual(Object.keys(envelope), [
      "apiVersion",
      "kind",
      "id",
      "rootIssueId",
      "workflowRunId",
      "taskId",
      "workflowContext",
      "references",
      "data",
    ]);
    assert.equal(envelope.apiVersion, "workgraph.drasi.io/v1");
    assert.equal(envelope.workflowContext.taskKey, "c");
    assert.equal(envelope.workflowContext.operation, "inspect-issue");
  }
  assert.ok(formatTaskError(error).startsWith(`${TASK_ERROR_MARKER}\n`));
  assert.deepEqual(
    JSON.parse(
      formatTaskAssignment(assignment).match(/```json\n([\s\S]+)\n```/)[1],
    ).references,
    { join: null },
  );
  const dispatchEnvelope = JSON.parse(
    formatTaskDispatch(dispatch).match(/```json\n([\s\S]+)\n```/)[1],
  );
  assert.deepEqual(dispatchEnvelope.references, {
    assignment: { kind: "TaskAssignment", id: ASSIGNMENT_ID },
  });
  assert.deepEqual(
    JSON.parse(formatTaskResult(result).match(/```json\n([\s\S]+)\n```/)[1])
      .references,
    {
      dispatch: { kind: "TaskDispatch", id: DISPATCH_ID },
      lease: { kind: "TaskLease", id: LEASE_ID },
    },
  );
  assert.deepEqual(
    JSON.parse(
      formatTaskEvaluation(evaluation()).match(/```json\n([\s\S]+)\n```/)[1],
    ).references,
    { result: { kind: "TaskResult", id: RESULT_ID } },
  );
  assert.deepEqual(
    JSON.parse(formatTaskRoute(route("complete")).match(/```json\n([\s\S]+)\n```/)[1])
      .references,
    {
      result: { kind: "TaskResult", id: RESULT_ID },
      evaluation: {
        kind: "TaskEvaluation",
        id: evaluation().evaluationId,
      },
    },
  );
  assert.deepEqual(
    JSON.parse(formatTaskError(error).match(/```json\n([\s\S]+)\n```/)[1])
      .references,
    {
      fork: null,
      join: null,
      assignment: null,
      dispatch: { kind: "TaskDispatch", id: DISPATCH_ID },
      lease: { kind: "TaskLease", id: LEASE_ID },
      result: { kind: "TaskResult", id: result.resultId },
      evaluation: {
        kind: "TaskEvaluation",
        id: errorReferences.evaluationId,
      },
      route: { kind: "TaskRoute", id: errorReferences.routeId },
    },
  );
  assert.throws(
    () =>
      parseTaskDispatch(
        formatTaskDispatch(dispatch).replace(
          '"kind": "TaskAssignment"',
          '"kind": "TaskDispatch"',
        ),
      ),
    /assignment reference kind must be TaskAssignment/,
  );
  assert.throws(
    () =>
      parseTaskDispatch(
        formatTaskDispatch(dispatch).replace(
          `"id": "${ASSIGNMENT_ID}"`,
          `"id": "${DISPATCH_ID}"`,
        ),
      ),
    /assignment reference id must be urn:.*:assignment:/,
  );
  assert.throws(
    () =>
      parseTaskDispatch(
        formatTaskDispatch(dispatch).replace(
          '"assignment": {',
          '"assignmentId": {',
        ),
      ),
    /references properties must be exactly assignment/,
  );
  assert.throws(
    () =>
      formatTaskAssignment({
        ...assignment,
        assignmentId: DISPATCH_ID,
      }),
    /assignmentId must be urn:.*:assignment:/,
  );
  assert.throws(
    () =>
      formatTaskDispatch({
        ...dispatch,
        launchId: LEASE_ID,
      }),
    /launchId must be urn:.*:dispatch-launch:/,
  );
  assert.throws(
    () =>
      formatTaskResult({
        ...result,
        resultId: protocolId("evaluation", "wrong-result-type"),
      }),
    /resultId must be urn:.*:result:/,
  );
  assert.throws(
    () =>
      formatTaskAssignment({
        ...assignment,
        workflowRunId: TASK_C_ID,
        task: { ...assignment.task, workflowRunId: TASK_C_ID },
      }),
    /workflowRunId must be urn:.*:workflow-run:/,
  );
  assert.throws(
    () =>
      formatTaskAssignment({
        ...assignment,
        task: {
          ...assignment.task,
          taskDefinitionId: TASK_C_ID,
        },
      }),
    /taskDefinitionId must be urn:.*:task-definition:/,
  );
  assert.throws(
    () => parseTaskResult(formatTaskResult(result).replace('"kind": "TaskResult"', '"kind": "Result"')),
    /apiVersion or kind is invalid/,
  );
  const arbitraryResultId = {
    ...result,
    resultId: protocolId("result", "arbitrary-wire-result"),
  };
  assert.equal(
    parseTaskResult(formatTaskResult(arbitraryResultId)).resultId,
    arbitraryResultId.resultId,
  );

  const nonAdvanceBody = formatTaskRoute(route("complete"));
  const routeEnvelope = JSON.parse(
    nonAdvanceBody.match(/```json\n([\s\S]+)\n```/)[1],
  );
  assert.deepEqual(routeEnvelope.data, {
    evaluationVerdict: "accepted",
    orchestratorId: "workflow-coordinator",
    action: "complete",
    attempt: 1,
    transitionKind: null,
    targetStepId: null,
    targetStepKind: null,
    selectedOutcome: null,
    targetTaskDefinitionId: null,
  });
});

test("Fork and Join actions have stable ordered identities and strict envelopes", () => {
  const parentTaskId = protocolId("task", "parent");
  const task = { ...messageTask(), taskId: parentTaskId };
  const children = [
    {
      taskDefinitionId: protocolId("task-definition", "definition-a"),
      taskId: protocolId("task", "task-a"),
    },
    {
      taskDefinitionId: protocolId("task-definition", "definition-b"),
      taskId: protocolId("task", "task-b"),
    },
  ].sort((left, right) =>
    left.taskDefinitionId.localeCompare(right.taskDefinitionId),
  );
  const forkId = deriveWorkGraphTaskForkId(parentTaskId, children);
  assert.equal(
    forkId,
    "urn:drasi:workgraph:id:v1:fork:sha256:f7eed381ba52f77add8889df2706b2577bda16160cbc2ba21000f062f245862f",
  );
  const fork = {
    forkId,
    rootIssueId: "I_root_issue",
    workflowRunId: MESSAGE_RUN_ID,
    taskId: parentTaskId,
    task,
    children,
  };
  const forkBody = formatTaskFork(fork);
  assert.ok(forkBody.startsWith(`${TASK_FORK_MARKER}\n`));
  assert.deepEqual(parseTaskFork(forkBody), fork);
  assert.deepEqual(parseWorkGraphTaskAction(forkBody), {
    kind: "TaskFork",
    value: fork,
  });

  const joinedChildren = children.map((child, index) => ({
    ...child,
    resultId: protocolId("result", `result-${index}`),
    evaluationId: protocolId("evaluation", `evaluation-${index}`),
  }));
  const joinId = deriveWorkGraphTaskJoinId(
    parentTaskId,
    forkId,
    joinedChildren,
  );
  assert.equal(
    joinId,
    "urn:drasi:workgraph:id:v1:join:sha256:0f3cad8d997a109b04b5110f2bc4507f69a2ec20ea13c80ea69091977cb4e659",
  );
  const join = {
    joinId,
    rootIssueId: fork.rootIssueId,
    workflowRunId: fork.workflowRunId,
    taskId: parentTaskId,
    task,
    forkId,
    strategy: "all",
    children: joinedChildren,
  };
  const joinBody = formatTaskJoin(join);
  assert.ok(joinBody.startsWith(`${TASK_JOIN_MARKER}\n`));
  assert.deepEqual(parseTaskJoin(joinBody), join);
  assert.deepEqual(parseWorkGraphTaskAction(joinBody), {
    kind: "TaskJoin",
    value: join,
  });
  assert.throws(
    () => formatTaskFork({ ...fork, children: [...children].reverse() }),
    /ordered by taskDefinitionId/,
  );
  assert.throws(
    () => formatTaskJoin({ ...join, children: [] }),
    /must contain 1-16 entries/,
  );
  assert.throws(
    () =>
      formatTaskJoin({
        ...join,
        children: [
          joinedChildren[0],
          {
            ...joinedChildren[1],
            resultId: joinedChildren[0].resultId,
          },
        ],
      }),
    /unique Result and Evaluation references/,
  );
});

test("all task contracts reject legacy and malformed task IDs", () => {
  const task = messageTask();
  const assignment = {
    assignmentId: ASSIGNMENT_ID,
    rootIssueId: "I_root_issue",
    workflowRunId: task.workflowRunId,
    taskId: task.taskId,
    task,
    joinId: null,
    permittedExecutors: ["issue-worker"],
  };
  const dispatch = {
    dispatchId: DISPATCH_ID,
    launchId: LAUNCH_ID,
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    lease: {
      leaseId: LEASE_ID,
      assignmentId: assignment.assignmentId,
      executorId: "issue-worker",
      slotId: "slot-1",
    },
  };
  const result = {
    resultId: protocolId("result", "opaque-result"),
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.lease.leaseId,
    attempt: 1,
    outcome: "succeeded",
    output: {},
  };
  const errorReferences = {
    forkId: null,
    joinId: null,
    assignmentId: null,
    dispatchId: null,
    leaseId: null,
    resultId: null,
    evaluationId: null,
    routeId: null,
  };
  const error = {
    errorId: deriveWorkGraphTaskErrorId(
      task.taskId,
      "routing",
      "terminal-error",
      "cause-1",
    ),
    rootIssueId: assignment.rootIssueId,
    workflowRunId: assignment.workflowRunId,
    taskId: task.taskId,
    task,
    references: errorReferences,
    stage: "routing",
    code: "terminal-error",
    category: "task",
    summary: "Routing ended in error.",
    retryable: false,
    attempt: null,
    details: {},
  };
  const invalidTaskIds = [
    `wgt-${"a".repeat(60)}`,
    "task-1",
    `workgraph-v1:task:sha256:${"a".repeat(64)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"A".repeat(64)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"a".repeat(63)}`,
    `urn:drasi:workgraph:id:v1:task:sha256:${"g".repeat(64)}`,
  ];
  const values = [
    [
      {
        ...task,
        rootIssueId: assignment.rootIssueId,
        resolvedInputs: {},
      },
      formatRuntimeTask,
    ],
    [assignment, formatTaskAssignment],
    [dispatch, formatTaskDispatch],
    [result, formatTaskResult],
    [evaluation(), formatTaskEvaluation],
    [route("complete"), formatTaskRoute],
    [error, formatTaskError],
  ];
  const canonicalTaskBody = formatRuntimeTask(values[0][0]);
  const canonicalResultBody = formatTaskResult(result);
  for (const invalidTaskId of invalidTaskIds) {
    for (const [value, format] of values) {
      const invalid = {
        ...value,
        taskId: invalidTaskId,
        ...(value.task
          ? { task: { ...value.task, taskId: invalidTaskId } }
          : {}),
      };
      assert.throws(
        () => format(invalid),
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
    }
    assert.throws(
      () =>
        parseRuntimeTask(
          canonicalTaskBody.replaceAll(task.taskId, invalidTaskId),
        ),
      /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
    );
    assert.throws(
      () =>
        parseTaskResult(
          canonicalResultBody.replaceAll(task.taskId, invalidTaskId),
        ),
      /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
    );
    for (const derive of [
      () => deriveWorkGraphTaskResultId(invalidTaskId, "dispatch-1", "lease-1"),
      () =>
        deriveWorkGraphTaskEvaluationId(
          invalidTaskId,
          "result-1",
          `sha256:${"a".repeat(64)}`,
        ),
      () => deriveWorkGraphTaskRouteId(invalidTaskId, "evaluation-1"),
      () =>
        deriveWorkGraphTaskErrorId(
          invalidTaskId,
          "routing",
          "terminal-error",
          "cause-1",
        ),
    ]) {
      assert.throws(
        derive,
        /taskId must be urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>/,
      );
    }
  }
});

test("Evaluate artifacts have exact direct bindings and accepted or rejected verdicts", () => {
  assert.equal(
    "urn:drasi:workgraph:id:v1:evaluation:sha256:7da3695e03dcf4b5669415c4652cb7a6ffb8a54167e9440caca826b64bc933dd",
    "urn:drasi:workgraph:id:v1:evaluation:sha256:7da3695e03dcf4b5669415c4652cb7a6ffb8a54167e9440caca826b64bc933dd",
  );
  for (const verdict of ["accepted", "rejected"]) {
    const value = evaluation(verdict);
    assert.deepEqual(parseTaskEvaluation(formatTaskEvaluation(value)), value);
  }
  const canonical = evaluation();
  const canonicalBody = formatTaskEvaluation(canonical);
  for (const evaluationId of [
    "evaluation-arbitrary",
    `workgraph-v1:evaluation-artifact:sha256:${"1".repeat(64)}`,
  ]) {
    assert.throws(
      () => formatTaskEvaluation({ ...canonical, evaluationId }),
      /evaluationId (?:is not canonical|must be urn:)/,
    );
    assert.throws(
      () =>
        parseTaskEvaluation(
          canonicalBody.replace(canonical.evaluationId, evaluationId),
        ),
      /evaluationId (?:is not canonical|must be urn:)/,
    );
  }
  assert.throws(
    () => formatTaskEvaluation({ ...evaluation(), verdict: "continue" }),
    /accepted or rejected/,
  );
  assert.throws(
    () => formatTaskEvaluation({ ...evaluation("rejected"), feedback: "" }),
    /requires feedback/,
  );
  assert.throws(
    () =>
      formatTaskEvaluation({
        ...evaluation(),
        feedback: "accepted feedback is forbidden",
      }),
    /requires empty feedback/,
  );
  assert.throws(
    () =>
      formatTaskEvaluation({
        ...evaluation(),
        result: { resultId: "result-1" },
      }),
    /properties must be exactly/,
  );
  assert.throws(
    () => formatTaskEvaluation({ ...evaluation(), taskId: "task id" }),
    /taskId/,
  );
  assert.throws(
    () => formatTaskEvaluation({ ...evaluation(), attempt: 0 }),
    /1 through 17/,
  );
  assert.throws(
    () =>
      formatTaskEvaluation({
        ...evaluation(),
        feedback: "x".repeat(64 * 1024),
      }),
    /16384 bytes/,
  );
  assert.throws(
    () =>
      formatTaskEvaluation({
        ...evaluation(),
        summary: "😀".repeat(1025),
      }),
    /4096 bytes/,
  );
  assert.doesNotThrow(() =>
    formatTaskEvaluation({
      ...evaluation(),
      summary: "Reviewed WorkGraphTaskResult/v1 successfully.",
    }),
  );
  const reversed = Object.fromEntries(
    Object.entries(evaluation()).reverse(),
  );
  assert.equal(
    formatTaskEvaluation(reversed),
    formatTaskEvaluation(evaluation()),
  );
});

test("Route matrix, advance pair, exclusions, and bounded same-task rework are strict", () => {
  const definition = COMPILED_FIXTURE;
  assert.equal(
    "urn:drasi:workgraph:id:v1:route:sha256:e37700a674e08063e432f8889c851a192542a0e41ee7384abc7b21594368fee0",
    deriveWorkGraphTaskRouteId(
      VECTOR_TASK_ID,
      deriveWorkGraphTaskEvaluationId(
        VECTOR_TASK_ID,
        RESULT_ID,
        `sha256:${"a".repeat(64)}`,
      ),
    ),
  );
  for (const [action, verdict] of [
    ["advance", "accepted"],
    ["complete", "accepted"],
    ["rework", "rejected"],
    ["error", "accepted"],
    ["error", "rejected"],
    ["ignore", "accepted"],
    ["ignore", "rejected"],
  ]) {
    const value = route(action, verdict);
    assert.deepEqual(parseTaskRoute(formatTaskRoute(value)), value);
  }
  const canonical = route("complete");
  const canonicalBody = formatTaskRoute(canonical);
  for (const routeId of [
    "route-arbitrary",
    `workgraph-v1:route-artifact:sha256:${"2".repeat(64)}`,
  ]) {
    assert.throws(
      () => formatTaskRoute({ ...canonical, routeId }),
      /routeId (?:is not canonical|must be urn:)/,
    );
    assert.throws(
      () => parseTaskRoute(canonicalBody.replace(canonical.routeId, routeId)),
      /routeId (?:is not canonical|must be urn:)/,
    );
  }
  assert.deepEqual(
    validateTaskRouteAgainstDefinition(
      route("advance"),
      definition,
      sourceContext("c"),
    ),
    route("advance"),
  );
  assert.throws(
    () => formatTaskRoute(route("rework", "accepted")),
    /invalid for verdict accepted/,
  );
  assert.throws(
    () => formatTaskRoute(route("complete", "rejected")),
    /invalid for verdict rejected/,
  );
  const missingTarget = route("advance");
  delete missingTarget.targetStepId;
  assert.throws(
    () => formatTaskRoute(missingTarget),
    /missing: targetStepId/,
  );
  assert.throws(
    () => formatTaskRoute({ ...route("complete"), outcome: "continue" }),
    /properties must be exactly/,
  );
  const terminalRoute = {
    ...route("advance"),
    targetStepId: "completed",
    targetStepKind: "terminal",
  };
  delete terminalRoute.targetTaskDefinitionId;
  assert.deepEqual(
    parseTaskRoute(formatTaskRoute(terminalRoute)),
    terminalRoute,
  );
  assert.deepEqual(
    validateTaskRouteAgainstDefinition(
      terminalRoute,
      definition,
      sourceContext("d"),
    ),
    terminalRoute,
  );
  assert.throws(
    () => {
      const invalid = {
        ...terminalRoute,
        targetTaskDefinitionId: "completed",
      };
      return validateTaskRouteAgainstDefinition(
        invalid,
        definition,
        sourceContext("d"),
      );
    },
    /wait or terminal target must not include/,
  );
  assert.throws(
    () =>
      validateTaskRouteAgainstDefinition(
        {
          ...route("advance"),
          targetTaskDefinitionId: protocolId(
            "task-definition",
            "different-task",
          ),
        },
        definition,
        sourceContext("c"),
      ),
    /requires its targetTaskDefinitionId/,
  );
  assert.throws(
    () =>
      validateTaskRouteAgainstDefinition(
        route("advance"),
        definition,
        sourceContext("a"),
      ),
    /source task's compiled transition/,
  );
  const overLimit = {
    ...route("rework", "rejected"),
    attempt: 4,
  };
  assert.throws(
    () =>
      validateTaskRouteAgainstDefinition(
        overLimit,
        definition,
        sourceContext("c"),
      ),
    /exceeds the source task policy/,
  );
  assert.throws(
    () =>
      validateTaskRouteAgainstDefinition(
        {
          ...route("ignore", "accepted"),
          orchestratorId: "other-coordinator",
        },
        definition,
        sourceContext("c"),
      ),
    /orchestratorId must match the source task policy/,
  );
  assert.throws(
    () => formatTaskRoute({ ...route("advance"), attempt: 18 }),
    /1 through 17/,
  );
  const reversed = Object.fromEntries(Object.entries(route("advance")).reverse());
  assert.equal(formatTaskRoute(reversed), formatTaskRoute(route("advance")));

  const first = {
    taskId: TASK_C_ID,
    assignmentId: ASSIGNMENT_ID,
    attempt: 1,
  };
  const second = nextReworkAttempt(first);
  assert.deepEqual(second, { ...first, attempt: 2 });
  assert.deepEqual(nextReworkAttempt(second), { ...first, attempt: 3 });
  assert.deepEqual(nextReworkAttempt({ ...first, attempt: 3 }), {
    ...first,
    attempt: 4,
  });
  assert.throws(
    () => nextReworkAttempt({ ...first, attempt: 4 }),
    /maximum of 3/,
  );
});

function scopedWorkflow() {
  const task = (operation, worker, next, extra = {}) => ({
    type: "task",
    operation,
    worker,
    inputs: {},
    ...extra,
    next,
  });
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "scoped-control-flow" },
    spec: {
      trigger: "workgraph",
      initial: "run",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
      steps: {
        run: task("coordinate-issue", "issue-worker", "completed", {
          flowEntries: ["fix", "notify"],
        }),
        completed: { type: "terminal", outcome: "completed" },
        fix: task("coordinate-validation", "issue-worker", "fix-cleanup", {
          children: {
            join: "all",
            tasks: {
              "fix-evidence": {
                operation: "validate-reproduction",
                worker: "issue-validator",
                inputs: { section: "reproduction" },
              },
            },
          },
          flowEntries: ["audit"],
        }),
        "fix-cleanup": task("normalize-issue", "issue-worker", "fix-complete"),
        "fix-complete": { type: "terminal", outcome: "completed" },
        audit: {
          type: "task",
          operation: "validate-title",
          worker: "issue-validator",
          inputs: { field: "title" },
          next: "audit-verify",
        },
        "audit-verify": {
          type: "task",
          operation: "validate-body",
          worker: "issue-validator",
          inputs: { field: "body" },
          next: "audit-complete",
        },
        "audit-complete": { type: "terminal", outcome: "completed" },
        notify: task("intake-issue", "issue-info-requester", "notify-complete"),
        "notify-complete": { type: "terminal", outcome: "completed" },
      },
    },
  };
}

test("scoped flow entries compile to disjoint routed scopes with nested owners", async () => {
  const [yaml, expected, testCase] = await Promise.all([
    read(SCOPED_AUTHORING_PATH),
    read(SCOPED_EXPECTED_PATH).then(JSON.parse),
    read(SCOPED_TEST_CASE_PATH).then(JSON.parse),
  ]);
  assert.match(yaml, /^  initial: run$/m);
  assert.match(yaml, /^      flowEntries:$/m);

  const definition = expected.workgraphDefinition;
  assert.deepEqual(
    normalizeCompiledWorkflowDefinition(definition),
    definition,
  );
  assert.equal(expected.definitionDigest, definition.digest);
  assert.equal(
    expected.canonicalDefinitionBody,
    await read(SCOPED_DEFINITION_PATH),
  );
  assert.deepEqual(
    parseCompiledWorkflowDefinition(expected.canonicalDefinitionBody),
    definition,
  );
  assert.deepEqual(expected.queryBundle.queries, []);

  // The initial `run` task is a container: it declares no fixed children and
  // forks one entry task per declared flow entry.
  assert.deepEqual(definition.root.children, []);
  assert.deepEqual(definition.root.flowEntries, ["fix", "notify"]);
  // `fix` forks a fixed child and a flow entry from the same task definition.
  assert.deepEqual(definition.steps.fix.taskDefinition.flowEntries, ["audit"]);
  assert.deepEqual(
    definition.steps.fix.taskDefinition.children.map(({ taskKey }) => taskKey),
    ["fix-evidence"],
  );
  assert.equal(
    Object.keys(definition.steps.fix.executionPolicies).length,
    2,
  );
  for (const stepId of ["fix-cleanup", "audit", "audit-verify", "notify"]) {
    assert.equal("flowEntries" in definition.steps[stepId].taskDefinition, false);
  }

  const flow = resolveCompiledFlowScopes(definition);
  assert.deepEqual([...flow.scopes.keys()].sort(), ["audit", "fix", "notify"]);
  // The whole run has exactly one trunk task: `run` is the initial task, the
  // container that forks both scopes, and the post-Join finalizer.
  assert.deepEqual([...flow.trunk].sort(), ["completed", "run"]);
  assert.deepEqual(
    [...flow.trunk].filter((stepId) => definition.steps[stepId].type === "task"),
    ["run"],
  );
  const fix = flow.scopes.get("fix");
  const notify = flow.scopes.get("notify");
  const audit = flow.scopes.get("audit");
  assert.deepEqual([...fix.stepIds].sort(), [
    "fix",
    "fix-cleanup",
    "fix-complete",
  ]);
  assert.deepEqual([...notify.stepIds].sort(), ["notify", "notify-complete"]);
  assert.deepEqual([...audit.stepIds].sort(), [
    "audit",
    "audit-complete",
    "audit-verify",
  ]);
  assert.equal(fix.forkDepth, 1);
  assert.equal(notify.forkDepth, 1);
  assert.equal(audit.forkDepth, 2);
  assert.equal(fix.ownerStepId, "run");
  assert.equal(notify.ownerStepId, "run");
  assert.equal(audit.ownerStepId, "fix");
  assert.equal(
    fix.ownerTaskDefinitionId,
    definition.root.taskDefinitionId,
  );
  assert.equal(
    audit.ownerTaskDefinitionId,
    definition.steps.fix.taskDefinition.taskDefinitionId,
  );
  for (const [left, right] of [
    [fix, notify],
    [fix, audit],
    [notify, audit],
  ]) {
    assert.equal(
      [...left.stepIds].some((stepId) => right.stepIds.has(stepId)),
      false,
    );
  }
  assert.equal(flow.scopeForStep("audit-verify"), audit);
  assert.equal(flow.scopeForStep("run"), null);
  assert.equal(flow.scopeForStep("completed"), null);
  assert.deepEqual(
    flow.entriesByOwner.get(definition.root.taskDefinitionId),
    ["fix", "notify"],
  );

  // Every scope terminates, and the trunk still reaches `completed`.
  assert.equal(definition.steps["fix-complete"].outcome, "completed");
  assert.equal(definition.steps["notify-complete"].outcome, "completed");
  assert.equal(definition.steps["audit-complete"].outcome, "completed");
  assert.equal(definition.steps.run.transition.targetStepId, "completed");

  assert.deepEqual(normalizeIssueWorkflow(scopedWorkflow()), expected.definition);
  assert.deepEqual(testCase.spec.expected.taskParents, {
    run: null,
    fix: "run",
    // A fixed child is a native sub-issue of its own task, not of the owner
    // that launched the scope.
    "fix-evidence": "fix",
    "fix-cleanup": "run",
    notify: "run",
    audit: "fix",
    "audit-verify": "fix",
  });
  // Exactly one direct Root child, and every other task parents under `run`
  // or under the nested `fix` container.
  assert.deepEqual(testCase.spec.expected.topLevelTaskKeys, ["run"]);
  assert.deepEqual(
    Object.entries(testCase.spec.expected.taskParents)
      .filter(([, parent]) => parent === null)
      .map(([stepId]) => stepId),
    ["run"],
  );
  assert.deepEqual(
    [
      ...new Set(
        Object.values(testCase.spec.expected.taskParents).filter(Boolean),
      ),
    ].sort(),
    ["fix", "run"],
  );
  assert.equal(testCase.spec.expected.terminalOutcome, "completed");
  assert.equal(testCase.spec.workflowDefinitionId, "scoped-control-flow");
  assert.deepEqual(
    Object.keys(testCase.spec.steps).sort(),
    [
      ...Object.entries(definition.steps)
        .filter(([, step]) => step.type === "task")
        .map(([stepId]) => stepId),
      "fix-evidence",
    ].sort(),
  );
});

test("existing v1 definitions never mention flowEntries and keep their digests", async () => {
  for (const [name, digest] of [
    ["issue-lifecycle", COMPILED_OUTPUT.definitionDigest],
    ["fork-join-lifecycle", null],
    ["mixed-control-flow", null],
  ]) {
    const [body, expected] = await Promise.all([
      read(`.github/workgraph/workflows/${name}-v1.body`),
      read(`.github/workgraph/fixtures/v1/${name}.expected.json`).then(
        JSON.parse,
      ),
    ]);
    assert.equal(body.includes("flowEntries"), false);
    assert.equal(
      JSON.stringify(expected.definition).includes("flowEntries"),
      false,
    );
    assert.equal(expected.canonicalDefinitionBody, body);
    assert.equal(expected.definitionDigest, expected.workgraphDefinition.digest);
    if (digest) assert.equal(expected.definitionDigest, digest);
    assert.equal(
      formatCompiledWorkflowDefinition(parseCompiledWorkflowDefinition(body)),
      body,
    );
    assert.equal(
      resolveCompiledFlowScopes(
        normalizeCompiledWorkflowDefinition(expected.workgraphDefinition),
      ).scopes.size,
      0,
    );
  }
});

test("flow entry declarations are strict at authoring and canonical layers", async () => {
  const rejects = (mutate, pattern) => {
    const workflow = scopedWorkflow();
    mutate(workflow);
    assert.throws(() => normalizeIssueWorkflow(workflow), pattern);
  };

  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["absent"];
  }, /flow entry 'absent' is not a declared step/);
  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["completed", "notify"];
  }, /flow entry 'completed' must reference a task step/);
  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["fix", "run"];
  }, /flow entry 'run' must not reference its own step/);
  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["fix", "fix"];
  }, /step 'run' flowEntries must be ordered by unique step id/);
  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["notify", "fix"];
  }, /step 'run' flowEntries must be ordered by unique step id/);
  rejects((workflow) => {
    workflow.spec.steps.run.flowEntries = ["Fix", "notify"];
  }, /step 'run' flowEntries entry must be 1-64 lowercase letters/);
  // A scope may not converge on the trunk.
  rejects((workflow) => {
    workflow.spec.steps["fix-cleanup"].next = "completed";
  }, /already reachable from the workflow trunk/);
  // Two entries may not converge on one another's steps.
  rejects((workflow) => {
    workflow.spec.steps.notify.next = "fix-cleanup";
  }, /already owned by flow entry/);
  // A scope must terminate.
  rejects((workflow) => {
    workflow.spec.steps["notify-complete"] = {
      type: "task",
      operation: "finalize-issue",
      worker: "issue-worker",
      inputs: {},
      next: "notify",
    };
  }, /flow entry 'notify' must reach at least one terminal step/);
  // A scope may not contain an unconditional cycle.
  rejects((workflow) => {
    delete workflow.spec.steps["audit-verify"].next;
    workflow.spec.steps["audit-verify"].outcomes = {
      ok: "audit-complete",
      retry: "audit",
    };
  }, /issue workflow has a cycle without a wait/);
  // The trunk may not transition into a routed scope.
  rejects((workflow) => {
    workflow.spec.steps.run.next = "audit-verify";
  }, /already reachable from the workflow trunk/);
  // Entry steps are unreachable without the owner that launches them.
  rejects((workflow) => {
    delete workflow.spec.steps.run.flowEntries;
  }, /issue workflow has unreachable steps/);

  const bounded = scopedWorkflow();
  bounded.spec.steps.run.children = {
    join: "all",
    tasks: Object.fromEntries(
      Array.from({ length: MAX_TASK_DEFINITION_CHILDREN - 1 }, (_, index) => [
        `child-${String(index).padStart(2, "0")}`,
        { operation: "validate-title", worker: "issue-validator" },
      ]),
    ),
  };
  assert.throws(
    () => normalizeIssueWorkflow(bounded),
    new RegExp(
      `children and flowEntries must total at most ${MAX_TASK_DEFINITION_CHILDREN} tasks`,
    ),
  );

  const expected = JSON.parse(await read(SCOPED_EXPECTED_PATH));
  const compiled = clone(expected.workgraphDefinition);
  compiled.root.flowEntries = ["notify", "fix"];
  compiled.steps.run.taskDefinition.flowEntries = ["notify", "fix"];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(compiled),
    /flowEntries must be ordered by unique step ID/,
  );

  const strayEntry = clone(expected.workgraphDefinition);
  strayEntry.root.flowEntries = ["audit", "fix", "notify"];
  strayEntry.steps.run.taskDefinition.flowEntries = ["audit", "fix", "notify"];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(strayEntry),
    /already owned by flow entry/,
  );

  const unknownKey = clone(expected.workgraphDefinition);
  unknownKey.root.flowEntry = ["fix"];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(unknownKey),
    /properties must be exactly/,
  );
});

test("nested owners and scope fork depth stay recursively bounded", async () => {
  const expected = JSON.parse(await read(SCOPED_EXPECTED_PATH));
  const policy = {
    workerId: "issue-validator",
    evaluatorId: "result-evaluator",
    orchestratorId: "workflow-coordinator",
    maxReworkAttempts: 3,
  };
  const leaf = (key, flowEntries = null) => ({
    taskDefinitionId: protocolId("task-definition", `scoped-${key}`),
    taskKey: key,
    operation: "validate-title",
    routing: { permittedExecutors: ["issue-validator"] },
    staticInputs: {},
    children: [],
    ...(flowEntries ? { flowEntries } : {}),
  });
  const register = (definition, task) => {
    definition.steps.fix.executionPolicies[task.taskDefinitionId] = {
      ...policy,
    };
    for (const child of task.children) register(definition, child);
  };

  // A nested fixed child may own a routed scope. Its physical fork depth counts
  // the owner's own nesting: fix (1) -> owner child (1) -> audit (3).
  const nested = clone(expected.workgraphDefinition);
  delete nested.steps.fix.taskDefinition.flowEntries;
  const owner = leaf("audit-owner", ["audit"]);
  // `fix` keeps its existing fixed child; children stay ordered by taskKey.
  nested.steps.fix.taskDefinition.children = [
    owner,
    ...nested.steps.fix.taskDefinition.children,
  ];
  register(nested, owner);
  const normalized = normalizeCompiledWorkflowDefinition(nested);
  const flow = resolveCompiledFlowScopes(normalized);
  assert.equal(flow.scopes.get("audit").forkDepth, 3);
  assert.equal(
    flow.scopes.get("audit").ownerTaskDefinitionId,
    owner.taskDefinitionId,
  );
  assert.equal(flow.scopes.get("audit").ownerStepId, "fix");
  assert.deepEqual(flow.entriesByOwner.get(owner.taskDefinitionId), ["audit"]);

  // The scope's own task tree is validated at that physical depth, so nesting
  // beneath a deep scope is rejected exactly like ordinary recursive children.
  const tooDeep = clone(expected.workgraphDefinition);
  let chain = leaf("audit-c3");
  for (const key of ["audit-c2", "audit-c1"]) {
    chain = { ...leaf(key), children: [chain] };
  }
  tooDeep.steps.audit.taskDefinition.children = [chain];
  const registerAudit = (task) => {
    tooDeep.steps.audit.executionPolicies[task.taskDefinitionId] = {
      ...policy,
    };
    for (const child of task.children) registerAudit(child);
  };
  registerAudit(chain);
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(tooDeep),
    new RegExp(
      `compiled task nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    ),
  );

  // The same tree beneath a trunk step stays within the bound.
  const trunk = clone(expected.workgraphDefinition);
  trunk.steps.run.taskDefinition.children = [clone(chain)];
  trunk.root.children = trunk.steps.run.taskDefinition.children;
  const registerTrunk = (task) => {
    trunk.steps.run.executionPolicies[task.taskDefinitionId] = {
      ...policy,
      workerId: "issue-validator",
    };
    for (const child of task.children) registerTrunk(child);
  };
  registerTrunk(chain);
  assert.doesNotThrow(() => normalizeCompiledWorkflowDefinition(trunk));
});

test("reserved runtime inputs cannot be authored where the runtime writes them", async () => {
  const [expected, mixed] = await Promise.all([
    read(SCOPED_EXPECTED_PATH).then(JSON.parse),
    read(".github/workgraph/fixtures/v1/mixed-control-flow.expected.json").then(
      JSON.parse,
    ),
  ]);
  assert.deepEqual(RESERVED_RUNTIME_INPUT_KEYS, [
    "workgraphPredecessorTaskId",
    "workgraphScopeEntryStepId",
    "workgraphScopeEntryTaskId",
    "workgraphScopeParentTaskId",
  ]);

  const authored = (mutate) => {
    const workflow = scopedWorkflow();
    mutate(workflow.spec.steps);
    return workflow;
  };
  // A routed successor receives `workgraphPredecessorTaskId`, so no step that
  // a transition targets may author it.
  for (const stepId of ["fix-cleanup", "audit-verify"]) {
    assert.throws(
      () =>
        normalizeIssueWorkflow(
          authored((steps) => {
            steps[stepId].inputs = { workgraphPredecessorTaskId: "x" };
          }),
        ),
      new RegExp(
        `step '${stepId}' uses reserved routed successor input 'workgraphPredecessorTaskId'`,
      ),
    );
  }
  // Every task of a routed scope receives the reserved scope strings, and the
  // entry root must stay free of a routed predecessor.
  for (const [stepId, key] of [
    ["fix", "workgraphScopeEntryTaskId"],
    ["fix", "workgraphPredecessorTaskId"],
    ["notify", "workgraphScopeParentTaskId"],
    ["audit", "workgraphScopeEntryStepId"],
    ["fix-cleanup", "workgraphScopeParentTaskId"],
  ]) {
    assert.throws(
      () =>
        normalizeIssueWorkflow(
          authored((steps) => {
            steps[stepId].inputs = { [key]: "x" };
          }),
        ),
      new RegExp(`step '${stepId}' uses reserved routed \\w+ input '${key}'`),
    );
  }
  // A nested child of a scoped task inherits the same scope metadata.
  assert.throws(
    () =>
      normalizeIssueWorkflow(
        authored((steps) => {
          steps.audit.children = {
            join: "all",
            tasks: {
              probe: {
                operation: "validate-body",
                worker: "issue-validator",
                inputs: { workgraphScopeParentTaskId: "x" },
              },
            },
          };
        }),
      ),
    /step 'audit' child task 'probe' uses reserved routed scope input 'workgraphScopeParentTaskId'/,
  );
  // `run` is the sole trunk task: it is the initial task and no transition
  // targets it, so it is never generated as an entry or a successor.
  for (const key of RESERVED_RUNTIME_INPUT_KEYS) {
    assert.doesNotThrow(() =>
      normalizeIssueWorkflow(
        authored((steps) => {
          steps.run.inputs = { [key]: "x" };
        }),
      ),
    );
  }

  const collide = (fixture, stepId, key) => {
    const definition = clone(fixture.workgraphDefinition);
    definition.steps[stepId].taskDefinition.staticInputs[key] = "x";
    if (definition.initialStepId === stepId) {
      definition.root = definition.steps[stepId].taskDefinition;
    }
    return definition;
  };
  assert.throws(
    () =>
      normalizeCompiledWorkflowDefinition(
        collide(expected, "audit", "workgraphScopeEntryTaskId"),
      ),
    /uses reserved routed scope input 'workgraphScopeEntryTaskId'/,
  );
  assert.throws(
    () =>
      normalizeCompiledWorkflowDefinition(
        collide(expected, "fix", "workgraphPredecessorTaskId"),
      ),
    /uses reserved routed successor input 'workgraphPredecessorTaskId'/,
  );
  // The rule applies to legacy trunk successors too: `b` follows `a`.
  assert.throws(
    () =>
      normalizeCompiledWorkflowDefinition(
        collide(mixed, "b", "workgraphPredecessorTaskId"),
      ),
    /uses reserved routed successor input 'workgraphPredecessorTaskId'/,
  );
  // The legacy initial step is not a transition target, so it is unaffected.
  assert.doesNotThrow(() =>
    normalizeCompiledWorkflowDefinition(
      collide(mixed, "a", "workgraphPredecessorTaskId"),
    ),
  );

  // Every shipped Demo definition stays free of reserved authored inputs, so
  // the committed bodies and digests are unchanged by this rule.
  for (const name of [
    "issue-lifecycle",
    "fork-join-lifecycle",
    "mixed-control-flow",
    "scoped-control-flow",
  ]) {
    const body = await read(`.github/workgraph/workflows/${name}-v1.body`);
    for (const key of RESERVED_RUNTIME_INPUT_KEYS) {
      assert.equal(body.includes(key), false);
    }
    assert.equal(
      formatCompiledWorkflowDefinition(parseCompiledWorkflowDefinition(body)),
      body,
    );
  }
});

// Mirrors the standalone mock's mechanical selection: the trunk starts at
// `initialStepId`, every routed scope starts at its declared entry step, both
// walk the same pinned transitions, and each chain ends at the terminal its own
// subgraph owns.
function selectWorkGraphTestCase(definition, testCase) {
  const chain = (startStepId) => {
    const tasks = [];
    const visited = new Set();
    let stepId = startStepId;
    for (;;) {
      assert.equal(visited.has(stepId), false, `cycle at '${stepId}'`);
      visited.add(stepId);
      const step = definition.steps[stepId];
      if (step.type === "terminal") {
        return { tasks, terminalStepId: stepId, terminalOutcome: step.outcome };
      }
      if (step.type === "wait") {
        stepId = step.nextStepId;
        continue;
      }
      const { taskKey } = step.taskDefinition;
      const selected = testCase.spec.steps[taskKey];
      assert.ok(selected, `no Result for selected task '${taskKey}'`);
      tasks.push(step.taskDefinition);
      stepId =
        step.transition.type === "next"
          ? step.transition.targetStepId
          : step.transition.targets[selected.result.output.outcome];
      assert.ok(stepId, `unselected outcome for '${taskKey}'`);
    }
  };

  const taskParents = {};
  const flowEntries = [];
  const insert = (task, parent) => {
    assert.equal(task.taskKey in taskParents, false);
    taskParents[task.taskKey] = parent;
    for (const child of task.children) insert(child, task.taskKey);
  };
  const collect = (owner) => {
    for (const entryStepId of owner.flowEntries ?? []) {
      const selected = chain(entryStepId);
      assert.notEqual(selected.tasks.length, 0);
      flowEntries.push({
        ownerTaskKey: owner.taskKey,
        entryStepId,
        taskKeys: selected.tasks.map(({ taskKey }) => taskKey),
        terminalStepId: selected.terminalStepId,
        terminalOutcome: selected.terminalOutcome,
      });
      for (const member of selected.tasks) insert(member, owner.taskKey);
      for (const member of selected.tasks) collect(member);
    }
    for (const child of owner.children) collect(child);
  };

  const trunk = chain(definition.initialStepId);
  for (const task of trunk.tasks) insert(task, null);
  for (const task of trunk.tasks) collect(task);
  flowEntries.sort((left, right) =>
    left.ownerTaskKey === right.ownerTaskKey
      ? (left.entryStepId < right.entryStepId ? -1 : 1)
      : left.ownerTaskKey < right.ownerTaskKey
        ? -1
        : 1,
  );
  return {
    topLevelTaskKeys: trunk.tasks.map(({ taskKey }) => taskKey),
    taskParents,
    terminalOutcome: trunk.terminalOutcome,
    flowEntries,
  };
}

test("the scoped test case matches the mechanically selected routed scopes", async () => {
  const [expected, testCase] = await Promise.all([
    read(SCOPED_EXPECTED_PATH).then(JSON.parse),
    read(SCOPED_TEST_CASE_PATH).then(JSON.parse),
  ]);
  const definition = expected.workgraphDefinition;
  const selected = selectWorkGraphTestCase(definition, testCase);

  assert.deepEqual(selected.topLevelTaskKeys, ["run"]);
  assert.deepEqual(
    selected.topLevelTaskKeys,
    testCase.spec.expected.topLevelTaskKeys,
  );
  assert.deepEqual(selected.taskParents, testCase.spec.expected.taskParents);
  assert.equal(selected.terminalOutcome, testCase.spec.expected.terminalOutcome);
  assert.deepEqual(selected.flowEntries, [
    {
      ownerTaskKey: "fix",
      entryStepId: "audit",
      taskKeys: ["audit", "audit-verify"],
      terminalStepId: "audit-complete",
      terminalOutcome: "completed",
    },
    {
      ownerTaskKey: "run",
      entryStepId: "fix",
      taskKeys: ["fix", "fix-cleanup"],
      terminalStepId: "fix-complete",
      terminalOutcome: "completed",
    },
    {
      ownerTaskKey: "run",
      entryStepId: "notify",
      taskKeys: ["notify"],
      terminalStepId: "notify-complete",
      terminalOutcome: "completed",
    },
  ]);
  assert.deepEqual(selected.flowEntries, testCase.spec.expected.flowEntries);

  // The mock deserializes with deny_unknown_fields, so the additive shape must
  // use exactly these camelCase keys.
  assert.deepEqual(Object.keys(testCase.spec.expected).sort(), [
    "flowEntries",
    "taskParents",
    "terminalOutcome",
    "topLevelTaskKeys",
  ]);
  for (const entry of testCase.spec.expected.flowEntries) {
    assert.deepEqual(Object.keys(entry), [
      "ownerTaskKey",
      "entryStepId",
      "taskKeys",
      "terminalStepId",
      "terminalOutcome",
    ]);
  }

  // The mock's cross-checks: the case describes exactly the selected tasks,
  // and every scope member is a native direct child of its owner.
  assert.deepEqual(
    Object.keys(testCase.spec.steps).sort(),
    Object.keys(testCase.spec.expected.taskParents).sort(),
  );
  const flow = resolveCompiledFlowScopes(definition);
  for (const entry of testCase.spec.expected.flowEntries) {
    const scope = flow.scopes.get(entry.entryStepId);
    assert.ok(scope, `'${entry.entryStepId}' is a compiled flow entry`);
    assert.equal(
      scope.ownerTaskDefinitionId,
      entry.ownerTaskKey === "run"
        ? definition.root.taskDefinitionId
        : definition.steps[entry.ownerTaskKey].taskDefinition.taskDefinitionId,
    );
    assert.equal(scope.stepIds.has(entry.terminalStepId), true);
    assert.equal(definition.steps[entry.terminalStepId].type, "terminal");
    assert.equal(
      definition.steps[entry.terminalStepId].outcome,
      entry.terminalOutcome,
    );
    for (const taskKey of entry.taskKeys) {
      assert.equal(scope.stepIds.has(taskKey), true);
      assert.equal(
        testCase.spec.expected.taskParents[taskKey],
        entry.ownerTaskKey,
      );
    }
    assert.equal(entry.taskKeys[0], entry.entryStepId);
  }
  // Only the entry root is Fork-named; the rest are predecessor-routed.
  assert.deepEqual(
    testCase.spec.expected.flowEntries.map(({ taskKeys }) => taskKeys.length),
    [2, 2, 1],
  );
});

test("existing test cases stay valid without the additive flowEntries field", async () => {
  for (const name of [
    "linear-sequence",
    "fork-join",
    "mixed-parallel",
    "mixed-skip",
    "mixed-reject",
  ]) {
    const testCase = JSON.parse(
      await read(`.github/workgraph/tests/${name}-v1.json`),
    );
    assert.equal("flowEntries" in testCase.spec.expected, false);
  }
});

// An authored chain of nested scopes: `plan` launches `flow-1`, which launches
// `flow-2`, and so on. The deepest entry sits at fork depth `levels`.
function nestedFlowChain(levels, childDepth = 0) {
  const task = (operation, worker, next, extra = {}) => ({
    type: "task",
    operation,
    worker,
    inputs: {},
    ...extra,
    next,
  });
  const childTree = (depth) =>
    depth === 0
      ? undefined
      : {
          join: "all",
          tasks: {
            [`nested-${depth}`]: {
              operation: "validate-title",
              worker: "issue-validator",
              ...(depth > 1 ? { children: childTree(depth - 1) } : {}),
            },
          },
        };
  const steps = {
    plan: task("intake-issue", "issue-worker", "done", {
      flowEntries: ["flow-1"],
    }),
    done: { type: "terminal", outcome: "completed" },
  };
  for (let level = 1; level <= levels; level += 1) {
    const deepest = level === levels;
    steps[`flow-${level}`] = task(
      "normalize-issue",
      "issue-worker",
      `end-${level}`,
      {
        ...(deepest ? {} : { flowEntries: [`flow-${level + 1}`] }),
        ...(deepest && childDepth > 0
          ? { children: childTree(childDepth) }
          : {}),
      },
    );
    steps[`end-${level}`] = { type: "terminal", outcome: "completed" };
  }
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "deep-flow" },
    spec: {
      trigger: "workgraph",
      initial: "plan",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
      steps,
    },
  };
}

test("authored scope fork depth bounds recursive children like the compiler", async () => {
  // A chain of nested scopes is bounded by its physical fork depth alone.
  assert.doesNotThrow(() =>
    normalizeIssueWorkflow(nestedFlowChain(MAX_TASK_DEFINITION_DEPTH)),
  );
  assert.throws(
    () => normalizeIssueWorkflow(nestedFlowChain(MAX_TASK_DEFINITION_DEPTH + 1)),
    new RegExp(`exceed maximum depth ${MAX_TASK_DEFINITION_DEPTH}`),
  );

  // Fork depth and authored child nesting add up: a scope at depth 2 may nest
  // two further child levels, but not three.
  assert.doesNotThrow(() => normalizeIssueWorkflow(nestedFlowChain(2, 2)));
  assert.throws(
    () => normalizeIssueWorkflow(nestedFlowChain(2, 3)),
    /step 'flow-2' recursive children exceed maximum depth 4/,
  );
  // The same child tree on the trunk stays within the bound.
  assert.doesNotThrow(() => {
    const trunk = nestedFlowChain(1, 0);
    trunk.spec.steps.plan.children =
      nestedFlowChain(1, 4).spec.steps["flow-1"].children;
    return normalizeIssueWorkflow(trunk);
  });

  // The committed scoped workflow: `fix` sits at fork depth 1 and nests one
  // child level, and `audit` sits at fork depth 2.
  const expected = JSON.parse(await read(SCOPED_EXPECTED_PATH));
  const flow = resolveCompiledFlowScopes(
    normalizeCompiledWorkflowDefinition(expected.workgraphDefinition),
  );
  assert.equal(flow.scopes.get("fix").forkDepth, 1);
  assert.equal(flow.scopes.get("audit").forkDepth, 2);
  const overNested = scopedWorkflow();
  overNested.spec.steps.audit.children = {
    join: "all",
    tasks: {
      "audit-a": {
        operation: "validate-title",
        worker: "issue-validator",
        children: {
          join: "all",
          tasks: {
            "audit-b": {
              operation: "validate-body",
              worker: "issue-validator",
              children: {
                join: "all",
                tasks: {
                  "audit-c": {
                    operation: "validate-reproduction",
                    worker: "issue-validator",
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  assert.throws(
    () => normalizeIssueWorkflow(overNested),
    /step 'audit' recursive children exceed maximum depth 4/,
  );
  // Two levels beneath the same depth-2 scope is exactly the bound.
  const atBound = scopedWorkflow();
  atBound.spec.steps.audit.children = {
    join: "all",
    tasks: {
      "audit-a": {
        operation: "validate-title",
        worker: "issue-validator",
        children: {
          join: "all",
          tasks: {
            "audit-b": {
              operation: "validate-body",
              worker: "issue-validator",
            },
          },
        },
      },
    },
  };
  assert.doesNotThrow(() => normalizeIssueWorkflow(atBound));
});

const HUMAN_EXPECTED_PATH =
  ".github/workgraph/fixtures/v1/human-parity.expected.json";
const HUMAN_DEFINITION_PATH =
  ".github/workgraph/workflows/human-parity-v1.body";
const HUMAN_TEST_CASE_PATH = ".github/workgraph/tests/human-parity-v1.json";

function humanParityWorkflow(instructions) {
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "human-parity" },
    spec: {
      trigger: "workgraph",
      initial: "draft",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxReworkAttempts: 3,
      },
      steps: {
        draft: {
          type: "task",
          operation: "draft-proposal",
          worker: "human-agentofreality",
          inputs: {},
          instructions: instructions.draft,
          next: "review",
        },
        review: {
          type: "task",
          operation: "normalize-issue",
          worker: "issue-worker",
          evaluator: "human-agentofreality",
          inputs: {},
          instructions: instructions.review,
          next: "completed",
        },
        completed: { type: "terminal", outcome: "completed" },
      },
    },
  };
}

test("human parity compiles a human worker and a human evaluator identically", async () => {
  const [yaml, expected, testCase] = await Promise.all([
    read(".github/workgraph/workflows/human-parity.yaml"),
    read(HUMAN_EXPECTED_PATH).then(JSON.parse),
    read(HUMAN_TEST_CASE_PATH).then(JSON.parse),
  ]);
  const definition = expected.workgraphDefinition;
  assert.equal(
    expected.canonicalDefinitionBody,
    await read(HUMAN_DEFINITION_PATH),
  );
  assert.deepEqual(normalizeCompiledWorkflowDefinition(definition), definition);
  assert.deepEqual(
    parseCompiledWorkflowDefinition(expected.canonicalDefinitionBody),
    definition,
  );
  assert.deepEqual(expected.queryBundle.queries, []);

  // A workflow references an actor ID identically whoever executes it: the
  // human worker and the agent worker are the same shape.
  const draft = definition.steps.draft;
  const review = definition.steps.review;
  assert.deepEqual(draft.taskDefinition.routing.permittedExecutors, [
    "human-agentofreality",
  ]);
  // The live fixture stays on the generic agent worker so the default-main
  // profile can perform it from the verified Root Issue alone.
  assert.deepEqual(review.taskDefinition.routing.permittedExecutors, [
    "issue-worker",
  ]);
  assert.equal(review.taskDefinition.operation, "normalize-issue");
  assert.equal(
    review.executionPolicies[review.taskDefinition.taskDefinitionId].workerId,
    "issue-worker",
  );
  assert.equal(
    draft.executionPolicies[draft.taskDefinition.taskDefinitionId].workerId,
    "human-agentofreality",
  );
  assert.equal(
    draft.executionPolicies[draft.taskDefinition.taskDefinitionId].evaluatorId,
    "result-evaluator",
  );
  assert.equal(
    review.executionPolicies[review.taskDefinition.taskDefinitionId].evaluatorId,
    "human-agentofreality",
  );
  assert.equal(review.transition.targetStepId, "completed");
  assert.equal(definition.steps.completed.outcome, "completed");

  // Instructions are actor-neutral content pinned at a position.
  for (const step of [draft, review]) {
    const { instructions } = step.taskDefinition;
    assert.ok(instructions.summary.length > 0);
    assert.ok(instructions.acceptanceCriteria.length >= 2);
  }
  assert.deepEqual(draft.taskDefinition.instructions.resultSchema, {
    proposal: "string",
    rationale: "string",
  });
  assert.equal("resultSchema" in review.taskDefinition.instructions, false);
  assert.match(yaml, /^      worker: human-agentofreality$/m);
  assert.match(yaml, /^        acceptanceCriteria:$/m);

  assert.deepEqual(
    normalizeIssueWorkflow(
      humanParityWorkflow({
        draft: expected.definition.spec.steps.draft.instructions,
        review: expected.definition.spec.steps.review.instructions,
      }),
    ),
    expected.definition,
  );
  assert.deepEqual(testCase.spec.expected.topLevelTaskKeys, [
    "draft",
    "review",
  ]);
  assert.deepEqual(testCase.spec.expected.taskParents, {
    draft: null,
    review: null,
  });
  assert.equal(testCase.spec.expected.terminalOutcome, "completed");
  assert.deepEqual(Object.keys(testCase.spec.steps).sort(), [
    "draft",
    "review",
  ]);
});

test("a candidate worker set canonicalizes to a sorted permitted executor set", async () => {
  const expected = JSON.parse(await read(HUMAN_EXPECTED_PATH));
  const instructions = {
    draft: expected.definition.spec.steps.draft.instructions,
    review: expected.definition.spec.steps.review.instructions,
  };
  const withCandidates = (candidates) => {
    const workflow = humanParityWorkflow(instructions);
    workflow.spec.steps.draft.worker = {
      candidates,
      selection: "first-available",
    };
    return workflow;
  };

  // Authored order carries no priority: it is preserved in the authored
  // definition and sorted into the compiled permitted set.
  const authored = normalizeIssueWorkflow(
    withCandidates(["zulu-actor", "human-agentofreality"]),
  );
  assert.deepEqual(authored.spec.steps.draft.worker, {
    candidates: ["zulu-actor", "human-agentofreality"],
    selection: "first-available",
  });
  assert.deepEqual(
    workerSelectorCandidates(authored.spec.steps.draft.worker),
    ["human-agentofreality", "zulu-actor"],
  );
  assert.equal(
    workerSelectorPreferred(authored.spec.steps.draft.worker),
    "human-agentofreality",
  );
  // A single-candidate set is the scalar form.
  assert.deepEqual(workerSelectorCandidates("solo-actor"), ["solo-actor"]);
  assert.equal(workerSelectorPreferred("solo-actor"), "solo-actor");
  assert.deepEqual(
    workerSelectorCandidates(
      normalizeIssueWorkflow(withCandidates(["human-agentofreality"])).spec
        .steps.draft.worker,
    ),
    ["human-agentofreality"],
  );

  assert.throws(
    () => normalizeIssueWorkflow(withCandidates([])),
    new RegExp(
      `candidates must contain 1-${MAX_TASK_DEFINITION_EXECUTORS} entries`,
    ),
  );
  assert.throws(
    () => normalizeIssueWorkflow(withCandidates(["a-actor", "a-actor"])),
    /repeats candidate 'a-actor'/,
  );
  assert.throws(
    () => normalizeIssueWorkflow(withCandidates(["Actor"])),
    /must be 1-64 lowercase letters/,
  );
  assert.throws(() => {
    const workflow = withCandidates(["a-actor"]);
    workflow.spec.steps.draft.worker.selection = "round-robin";
    return normalizeIssueWorkflow(workflow);
  }, /selection must be first-available/);
  assert.throws(() => {
    const workflow = humanParityWorkflow(instructions);
    workflow.spec.steps.draft.worker = { candidates: ["a-actor"] };
    return normalizeIssueWorkflow(workflow);
  }, /properties must be exactly/);

  // Separation of duties holds for the whole permitted set.
  const compiled = clone(expected.workgraphDefinition);
  const draft = compiled.steps.draft;
  const draftId = draft.taskDefinition.taskDefinitionId;
  draft.taskDefinition.routing.permittedExecutors = [
    "human-agentofreality",
    "result-evaluator",
  ];
  compiled.root = draft.taskDefinition;
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(compiled),
    /must not permit its evaluator 'result-evaluator' to execute the task/,
  );
  draft.taskDefinition.routing.permittedExecutors = [
    "human-agentofreality",
    "workflow-coordinator",
  ];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(compiled),
    /must not permit its orchestrator 'workflow-coordinator' to execute the task/,
  );
  // Membership authorizes execution; the policy default must be a member.
  draft.taskDefinition.routing.permittedExecutors = ["some-other-actor"];
  assert.throws(
    () => normalizeCompiledWorkflowDefinition(compiled),
    /workerId must be one of its permitted executors/,
  );
  draft.taskDefinition.routing.permittedExecutors = [
    "human-agentofreality",
    "some-other-actor",
  ];
  assert.doesNotThrow(() => normalizeCompiledWorkflowDefinition(compiled));
  assert.equal(
    draft.executionPolicies[draftId].workerId,
    "human-agentofreality",
  );
});

const RESPONSE_TASK_ID = protocolId("task", "response-task");
const RESPONSE_RUN_ID = protocolId("workflow-run", "response-run");
const RESPONSE_DEFINITION_ID = protocolId("task-definition", "response-def");
const RESPONSE_DISPATCH_ID = protocolId("dispatch", "response-dispatch");
const RESPONSE_LEASE_ID = protocolId("lease", "response-lease");
const RESPONSE_RESULT_ID = protocolId("result", "response-result");
const RESPONSE_COMMENT_NODE_ID = "IC_kwDOAbcdef4AbCdE";
const RESPONSE_AUTHOR_NODE_ID = "MDQ6VXNlcjQwMjEyNDM=";

function responseTaskIdentity() {
  return {
    taskId: RESPONSE_TASK_ID,
    workflowRunId: RESPONSE_RUN_ID,
    workflowDefinitionId: "human-parity",
    workflowDefinitionVersion: "v1",
    workflowDefinitionDigest: `sha256:${"a".repeat(64)}`,
    taskDefinitionId: RESPONSE_DEFINITION_ID,
    taskKey: "draft",
    operation: "draft-proposal",
  };
}

function workerResponse(body = "@workgraph here is the proposal.") {
  const subject = {
    role: "worker",
    dispatchId: RESPONSE_DISPATCH_ID,
    leaseId: RESPONSE_LEASE_ID,
  };
  return {
    responseId: deriveWorkGraphTaskResponseId(
      RESPONSE_TASK_ID,
      subject,
      RESPONSE_COMMENT_NODE_ID,
      RESPONSE_AUTHOR_NODE_ID,
    ),
    rootIssueId: "I_human_root",
    workflowRunId: RESPONSE_RUN_ID,
    taskId: RESPONSE_TASK_ID,
    task: responseTaskIdentity(),
    actorId: "human-agentofreality",
    role: "worker",
    dispatchId: RESPONSE_DISPATCH_ID,
    leaseId: RESPONSE_LEASE_ID,
    commentNodeId: RESPONSE_COMMENT_NODE_ID,
    authorDatabaseId: 4021243,
    authorNodeId: RESPONSE_AUTHOR_NODE_ID,
    authorLogin: "agentofreality",
    bodyDigest: deriveWorkGraphResponseBodyDigest(body),
    createdRevision: 1,
    updatedRevision: 1,
    body,
  };
}

test("TaskResponse evidence is role and subject bound and carries raw text verbatim", () => {
  const payload = workerResponse();
  const body = formatTaskResponse(payload);
  assert.match(body, /^WorkGraphTaskResponse\/v1\n\n```json\n/);
  assert.deepEqual(parseTaskResponse(body), payload);

  // Real replies contain CRLF and fenced code blocks; hex transport keeps the
  // envelope canonical while leaving the authored text untouched.
  const raw = "@WorkGraph done.\r\n\r\n```json\n{\"ok\": true}\n```\r\n";
  const encoded = workerResponse(raw);
  const parsed = parseTaskResponse(formatTaskResponse(encoded));
  assert.equal(parsed.body, raw);
  assert.deepEqual(decodeWorkGraphText(encodeWorkGraphText(raw), "body"), raw);
  assert.equal(encodeWorkGraphText("").data, "");
  assert.throws(
    () => decodeWorkGraphText({ encoding: "utf-8-hex", data: "abc" }, "body"),
    /even number of hex digits/,
  );
  assert.throws(
    () => decodeWorkGraphText({ encoding: "utf-8-hex", data: "AB" }, "body"),
    /lowercase hex digits/,
  );
  assert.throws(
    () => decodeWorkGraphText({ encoding: "base64", data: "" }, "body"),
    /encoding must be 'utf-8-hex'/,
  );
  assert.throws(
    () => decodeWorkGraphText({ encoding: "utf-8-hex", data: "ff" }, "body"),
    /must decode to UTF-8/,
  );

  // The mention is an exact, case-insensitive login boundary.
  for (const opening of ["@workgraph x", "@WorkGraph x", "@WORKGRAPH", "  \n@Workgraph:"]) {
    assert.equal(startsWithWorkGraphMention(opening), true, opening);
  }
  for (const opening of ["@workgraphs x", "@workgraph-bot x", "hello @workgraph", ""]) {
    assert.equal(startsWithWorkGraphMention(opening), false, opening);
  }
  assert.throws(
    () => formatTaskResponse(workerResponse("no mention here")),
    /must open with '@workgraph'/,
  );

  // Evidence names exactly the subject its role answers.
  const evaluatorSubject = { role: "evaluator", resultId: RESPONSE_RESULT_ID };
  const evaluator = {
    ...workerResponse("@workgraph looks right."),
    role: "evaluator",
    dispatchId: undefined,
    leaseId: undefined,
    resultId: RESPONSE_RESULT_ID,
  };
  delete evaluator.dispatchId;
  delete evaluator.leaseId;
  evaluator.responseId = deriveWorkGraphTaskResponseId(
    RESPONSE_TASK_ID,
    evaluatorSubject,
    RESPONSE_COMMENT_NODE_ID,
    RESPONSE_AUTHOR_NODE_ID,
  );
  assert.deepEqual(
    parseTaskResponse(formatTaskResponse(evaluator)),
    evaluator,
  );
  // The same comment yields a different identity per role and per subject.
  assert.notEqual(evaluator.responseId, workerResponse().responseId);
  assert.notEqual(
    deriveWorkGraphTaskResponseId(
      RESPONSE_TASK_ID,
      { role: "worker", dispatchId: RESPONSE_DISPATCH_ID, leaseId: protocolId("lease", "other") },
      RESPONSE_COMMENT_NODE_ID,
      RESPONSE_AUTHOR_NODE_ID,
    ),
    workerResponse().responseId,
  );

  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), leaseId: undefined }),
    /worker evidence must reference its lease/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), resultId: RESPONSE_RESULT_ID }),
    /worker evidence must not reference a result/,
  );
  assert.throws(
    () => formatTaskResponse({ ...evaluator, dispatchId: RESPONSE_DISPATCH_ID }),
    /evaluator evidence must not reference a dispatch or lease/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), bodyDigest: `sha256:${"0".repeat(64)}` }),
    /bodyDigest does not match its body/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), responseId: protocolId("response", "forged") }),
    /responseId is not canonical/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), authorLogin: "-bad" }),
    /authorLogin must be 1-39/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), authorDatabaseId: 0 }),
    /authorDatabaseId must be a positive safe integer/,
  );
  assert.throws(
    () => formatTaskResponse({ ...workerResponse(), createdRevision: 2, updatedRevision: 1 }),
    /updatedRevision must not precede createdRevision/,
  );
  const oversized = `@workgraph ${"x".repeat(MAX_TASK_RESPONSE_BODY_BYTES)}`;
  assert.throws(
    () => formatTaskResponse(workerResponse(oversized)),
    new RegExp(`body must be 1-${MAX_TASK_RESPONSE_BODY_BYTES} bytes`),
  );
});

test("Result and Evaluation carry optional Response provenance without changing legacy bytes", async () => {
  const response = workerResponse();
  const reference = { kind: "TaskResponse", id: response.responseId };
  const result = {
    resultId: deriveWorkGraphTaskResultId(
      RESPONSE_TASK_ID,
      RESPONSE_DISPATCH_ID,
      RESPONSE_LEASE_ID,
    ),
    rootIssueId: "I_human_root",
    workflowRunId: RESPONSE_RUN_ID,
    taskId: RESPONSE_TASK_ID,
    task: responseTaskIdentity(),
    dispatchId: RESPONSE_DISPATCH_ID,
    leaseId: RESPONSE_LEASE_ID,
    attempt: 1,
    outcome: "succeeded",
    output: { proposal: "done" },
  };
  const plain = formatTaskResult(result);
  assert.equal(plain.includes("response"), false);
  assert.deepEqual(parseTaskResult(plain), result);

  const attributed = { ...result, response: reference };
  const attributedBody = formatTaskResult(attributed);
  assert.match(attributedBody, /"response": \{/);
  assert.deepEqual(parseTaskResult(attributedBody), attributed);
  // Provenance never participates in identity.
  assert.equal(attributed.resultId, result.resultId);
  assert.equal(taskResultDigest(attributed) === taskResultDigest(result), false);
  assert.throws(
    () => formatTaskResult({ ...result, response: { kind: "TaskResult", id: reference.id } }),
    /response reference kind must be TaskResponse/,
  );

  const resultDigest = taskResultDigest(result);
  const evaluation = {
    evaluationId: deriveWorkGraphTaskEvaluationId(
      RESPONSE_TASK_ID,
      result.resultId,
      resultDigest,
    ),
    rootIssueId: "I_human_root",
    workflowRunId: RESPONSE_RUN_ID,
    taskId: RESPONSE_TASK_ID,
    task: responseTaskIdentity(),
    resultId: result.resultId,
    resultDigest,
    evaluatorId: "human-agentofreality",
    attempt: 1,
    verdict: "accepted",
    summary: "Accepted.",
    feedback: "",
  };
  const plainEvaluation = formatTaskEvaluation(evaluation);
  assert.equal(plainEvaluation.includes("response"), false);
  assert.deepEqual(parseTaskEvaluation(plainEvaluation), evaluation);
  const attributedEvaluation = { ...evaluation, response: reference };
  assert.deepEqual(
    parseTaskEvaluation(formatTaskEvaluation(attributedEvaluation)),
    attributedEvaluation,
  );
  assert.equal(attributedEvaluation.evaluationId, evaluation.evaluationId);

  // Every committed body predates Response and instructions and is unchanged.
  for (const name of [
    "issue-lifecycle",
    "fork-join-lifecycle",
    "mixed-control-flow",
    "scoped-control-flow",
  ]) {
    const body = await read(`.github/workgraph/workflows/${name}-v1.body`);
    assert.equal(body.includes("instructions"), false);
    assert.equal(body.includes("TaskResponse"), false);
    assert.equal(
      formatCompiledWorkflowDefinition(parseCompiledWorkflowDefinition(body)),
      body,
    );
    const expected = JSON.parse(
      await read(`.github/workgraph/fixtures/v1/${name}.expected.json`),
    );
    assert.equal(expected.canonicalDefinitionBody, body);
    assert.equal(expected.definitionDigest, expected.workgraphDefinition.digest);
  }
  assert.equal(COMPILED_OUTPUT.definitionDigest, COMPILED_FIXTURE.digest);
});

test("hex transport is byte-faithful for a BOM and every digest survives it", () => {
  // A leading U+FEFF is content, not framing. A decoder that consumes it would
  // return different text than was encoded and break the body digest binding.
  const bom = "\uFEFF";
  for (const raw of [
    `${bom}@workgraph done.`,
    `@workgraph ${bom} mid-body BOM`,
    `@workgraph trailing${bom}`,
    `${bom}${bom}@workgraph doubled`,
  ]) {
    const encoded = encodeWorkGraphText(raw);
    assert.equal(
      encoded.data,
      Buffer.from(raw, "utf8").toString("hex"),
      "hex is the exact UTF-8 bytes",
    );
    const decoded = decodeWorkGraphText(encoded, "task Response body");
    assert.equal(decoded, raw);
    assert.equal(decoded.length, raw.length);
    assert.equal(
      deriveWorkGraphResponseBodyDigest(decoded),
      deriveWorkGraphResponseBodyDigest(raw),
    );
  }
  assert.equal(encodeWorkGraphText(bom).data, "efbbbf");
  assert.equal(decodeWorkGraphText({ encoding: "utf-8-hex", data: "efbbbf" }, "b"), bom);

  // The mention scan uses Unicode White_Space, which excludes U+FEFF, so a
  // BOM-prefixed body does not address the protocol.
  assert.equal(startsWithWorkGraphMention(`${bom}@workgraph done.`), false);
  assert.equal(startsWithWorkGraphMention("\u00a0@workgraph done."), true);
  assert.equal(startsWithWorkGraphMention("\r\n  @workgraph done."), true);

  // A full envelope round-trip preserves a mid-body BOM byte for byte.
  const raw = `@workgraph review${bom} complete.\r\n`;
  const payload = { ...workerResponse(raw) };
  const parsed = parseTaskResponse(formatTaskResponse(payload));
  assert.equal(parsed.body, raw);
  assert.equal(parsed.bodyDigest, deriveWorkGraphResponseBodyDigest(raw));
});
