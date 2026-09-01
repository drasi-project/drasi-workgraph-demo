import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MAX_REWORK_ATTEMPTS,
  MAX_TASK_DEFINITION_CHILDREN,
  RUNTIME_TASK_MARKER,
  TASK_ERROR_MARKER,
  TASK_FORK_MARKER,
  TASK_JOIN_MARKER,
  deriveWorkGraphProtocolId,
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
  parseTaskJoin,
  parseWorkGraphTaskAction,
  parseTaskResult,
  parseTaskRoute,
  parseCompiledWorkflowDefinition,
  parseRuntimeTask,
  parseWorkflowDefinition,
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
    /must match the task routing executor/,
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
