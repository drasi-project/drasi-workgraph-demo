import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MAX_REWORK_ATTEMPTS,
  MAX_TASK_DEFINITION_CHILDREN,
  formatTaskEvaluation,
  formatTaskRoute,
  formatCompiledWorkflowDefinition,
  formatRuntimeTask,
  formatWorkflowDefinition,
  nextReworkAttempt,
  normalizeCompiledWorkflowDefinition,
  normalizeIssueWorkflow,
  parseTaskEvaluation,
  parseTaskRoute,
  parseCompiledWorkflowDefinition,
  parseRuntimeTask,
  parseWorkflowDefinition,
  validateRootRuntimeTask,
  validateTaskRouteAgainstDefinition,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import { buildWorkGraphV1Proof } from "../scripts/prepare-workgraph-v1-proof.mjs";

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
      taskDefinitionId: "issue-validation-root",
      taskKey: "root",
      operation: "summarize",
      routing: { permittedExecutors: ["summary-agent"] },
      staticInputs: { objective: "validate the issue" },
      children: [
        {
          taskDefinitionId: "issue-validation-body",
          taskKey: "body",
          operation: "validate-body",
          routing: { permittedExecutors: ["body-agent"] },
          staticInputs: {},
          children: [
            {
              taskDefinitionId: "issue-validation-body-links",
              taskKey: "body-links",
              operation: "validate-links",
              routing: { permittedExecutors: ["link-agent"] },
              staticInputs: {},
              children: [],
            },
          ],
        },
        {
          taskDefinitionId: "issue-validation-title",
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
    "WorkGraphTaskAssign/v1",
    "WorkGraphTaskDispatch/v1",
    "WorkGraphTaskResult/v1",
    "WorkGraphTaskEvaluate/v1",
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
  assert.equal(formatRuntimeTask(root), body);
  assert.deepEqual(validateRootRuntimeTask(definition, root), root);

  for (const [field, value] of [
    ["workflowDefinitionId", "different-workflow"],
    ["workflowDefinitionVersion", "different-version"],
    ["workflowDefinitionDigest", `sha256:${"b".repeat(64)}`],
    ["taskDefinitionId", "different-root"],
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
});

test("proof inputs pin 26 wg- queries and remain fully inactive", async () => {
  const inputs = JSON.parse(await read(INPUTS_PATH));
  assert.equal(inputs.runtimeContract.queryIds.length, 26);
  assert.equal(new Set(inputs.runtimeContract.queryIds).size, 26);
  assert.ok(inputs.runtimeContract.queryIds.every((id) => id.startsWith("wg-")));
  assert.equal(inputs.runtimeContract.stateStorePath, "data/workgraph-v1.redb");
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
      "wga-c011d85d24550c7469b5264f2c1ab1237a96469ea4a51f7c27f6b6762ea1ab31",
  });
  assert.equal(
    proof.expectedRootTask.value.taskId,
    "wgt-a417c7051894a093f13e1e06c212d0bd740d608bbc75513b28aa61aad87e",
  );
  assert.equal(
    proof.expectedRootTask.value.workflowRunId,
    "workgraph-v1:run:sha256:1cb0cca12c477296d36277433d7c42f34f918e27a435cd6208c95c74599df6cd",
  );
  assert.equal(
    proof.expectedRootTask.value.resolvedInputs.rootIssue.issueNodeId,
    proof.expectedRootTask.value.rootIssueId,
  );
  assert.equal(proof.expectedRootTask.firstLifecycleState, "FORK");
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
  assert.deepEqual(
    generatedQueryIds,
    [
      "wg-entry-9fa7c23308acc6f2f663",
      "wg-next-36052ed88c92f5b5cd29",
      "wg-next-7b7e3f4ef615e40fac55",
      "wg-next-81d9671b0d5b83db2a14",
      "wg-next-d9777655870aa7254c3f",
      "wg-terminal-8f328a93bc2ba9c6d49d",
    ],
  );
  assert.equal(
    generatedQueryIds.some((id) =>
      /(?:fork|join|outcome|resume|wait)/.test(id),
    ),
    false,
  );

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
    "terminalOutcome",
  ]);
  assert.deepEqual(testCase.spec.expected.topLevelTaskKeys, taskKeys);
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
  extraPolicy.steps.c.executionPolicies["extra-policy"] = {
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

function evaluation(verdict = "accepted") {
  return {
    evaluationId: "evaluation-1",
    rootIssueId: "I_root_issue",
    workflowRunId: "run-1",
    taskId: "task-c",
    resultId: "result-1",
    resultDigest: `sha256:${"a".repeat(64)}`,
    evaluatorId: "result-evaluator",
    attempt: 1,
    verdict,
    summary: "The Result satisfies the evaluation contract.",
    feedback: verdict === "rejected" ? "Correct the Result and try again." : "",
  };
}

function route(action, verdict = "accepted") {
  const value = {
    routeId: `route-${action}`,
    rootIssueId: "I_root_issue",
    workflowRunId: "run-1",
    taskId: "task-c",
    resultId: "result-1",
    evaluationId: "evaluation-1",
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

test("Evaluate artifacts have exact direct bindings and accepted or rejected verdicts", () => {
  for (const verdict of ["accepted", "rejected"]) {
    const value = evaluation(verdict);
    assert.deepEqual(parseTaskEvaluation(formatTaskEvaluation(value)), value);
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
    () => formatTaskEvaluation({ ...evaluation(), taskId: "task_C" }),
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
    {
      routeId: "route-advance",
      rootIssueId: "I_root_issue",
      workflowRunId: "run-1",
      taskId: "task-c",
      resultId: "result-1",
      evaluationId: "evaluation-1",
      evaluationVerdict: "accepted",
      orchestratorId: "workflow-coordinator",
      action: "advance",
      transitionKind: "next",
      targetStepId: "completed",
      targetStepKind: "terminal",
      attempt: 1,
    },
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
          targetTaskDefinitionId: "different-task",
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
    taskId: "task-c",
    assignmentId: "assignment-1",
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
