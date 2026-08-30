import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_MAX_REWORK,
  MAX_TASK_DEFINITION_CHILDREN,
  formatTaskEvaluation,
  formatTaskRoute,
  formatRuntimeTask,
  formatWorkflowDefinition,
  nextReworkAttempt,
  normalizeIssueWorkflow,
  parseTaskEvaluation,
  parseTaskRoute,
  parseRuntimeTask,
  parseWorkflowDefinition,
  validateRootRuntimeTask,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import { buildWorkGraphV1Proof } from "../scripts/prepare-workgraph-v1-proof.mjs";

const DEFINITION_PATH = ".github/workgraph/workflows/issue-lifecycle-v1.body";
const INPUTS_PATH = ".github/workgraph/fixtures/v1/live-proof-inputs.json";
const AUTHORING_PATH = ".github/workgraph/workflows/issue-lifecycle.yaml";
const EXPECTED_PATH =
  ".github/workgraph/fixtures/v1/issue-lifecycle.expected.json";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const clone = (value) => structuredClone(value);

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
  assert.equal(Buffer.byteLength(body), 831);
  assert.equal(
    createHash("sha256").update(body, "utf8").digest("hex"),
    "68918d0137ec173cbcd24b8c32792874f15c3f92abf95424f98012977566d85b",
  );
  const definition = parseWorkflowDefinition(body);
  assert.equal(formatWorkflowDefinition(definition), body);
  assert.equal(definition.version, "v1");
  assert.deepEqual(
    taskDefinitions(definition.root).map(({ taskDefinitionId }) => taskDefinitionId),
    ["root-v1", "validate-v1"],
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
  const definition = parseWorkflowDefinition(await read(DEFINITION_PATH));
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
  const definition = parseWorkflowDefinition(await read(DEFINITION_PATH));
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

test("proof inputs pin 17 wg- queries and remain fully inactive", async () => {
  const inputs = JSON.parse(await read(INPUTS_PATH));
  assert.equal(inputs.runtimeContract.queryIds.length, 17);
  assert.equal(new Set(inputs.runtimeContract.queryIds).size, 17);
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
    "wgt-34c7e7f57d7382cd2fe4d3848d5a3242287150e55420d9cae04a9557daa1",
  );
  assert.equal(
    proof.expectedRootTask.value.workflowRunId,
    "workgraph-v1:run:sha256:7e382f874d15c6c60d8b4a15c365d0e85c2b5a65453924831442291cce73d510",
  );
  assert.equal(
    proof.expectedRootTask.value.resolvedInputs.rootIssue.issueNodeId,
    proof.expectedRootTask.value.rootIssueId,
  );
  assert.equal(proof.expectedRootTask.firstLifecycleState, "FORK");
});

function richWorkflow() {
  const task = (name, operation, agent, next) => ({
    name,
    type: "task",
    operation,
    agent,
    next,
  });
  return {
    apiVersion: "workgraph.drasi.io/v1",
    kind: "IssueWorkflow",
    metadata: { id: "issue-lifecycle" },
    spec: {
      trigger: "workgraph",
      initial: "A",
      defaults: {
        evaluator: "result-evaluator",
        orchestrator: "workflow-coordinator",
        maxRework: 3,
        rework: { task: "same", assignment: "same", attempt: "fresh" },
      },
      steps: {
        A: task("intake", "intake-issue", "issue-worker", "B"),
        B: task("normalize", "normalize-issue", "issue-worker", "C"),
        C: {
          name: "validate",
          type: "task",
          operation: "validate-issue",
          agent: "issue-validator",
          evaluator: "issue-validation-evaluator",
          outcomes: [
            { outcome: "needs-info", verdict: "accepted", target: "D" },
            { outcome: "continue", verdict: "accepted", target: "E" },
            { outcome: "reject", verdict: "accepted", target: "F" },
          ],
        },
        D: task("request-info", "request-information", "issue-info-requester", {
          waitFor: "root-issue-comment",
          where: { rootIssue: true, authorType: "non-agent-human" },
          target: "C",
        }),
        E: task("triage", "triage-issue", "issue-worker", "G"),
        F: task(
          "record-rejection",
          "record-rejection",
          "issue-worker",
          "ignored",
        ),
        G: {
          ...task(
            "parallel-validation",
            "coordinate-validation",
            "issue-worker",
            "H",
          ),
          orchestrator: "validation-stage-coordinator",
          maxRework: 2,
          children: [
            {
              id: "G-title",
              name: "validate-title",
              operation: "validate-title",
              agent: "issue-validator",
            },
            {
              id: "G-body",
              name: "validate-body",
              operation: "validate-body",
              agent: "issue-validator",
            },
            {
              id: "G-reproduction",
              name: "validate-reproduction",
              operation: "validate-reproduction",
              agent: "issue-validator",
            },
          ],
          join: {
            mode: "all",
            require: "accepted",
            coordinator: "after-children",
          },
        },
        H: task("finalize", "finalize-issue", "issue-worker", "completed"),
      },
      terminals: {
        ignored: { status: "ignored" },
        completed: { status: "completed" },
      },
    },
  };
}

test("rich v1 authoring preserves the branch, wait loop, recursion, and overrides", async () => {
  const [yaml, expected] = await Promise.all([
    read(AUTHORING_PATH),
    read(EXPECTED_PATH).then(JSON.parse),
  ]);
  assert.match(yaml, /^apiVersion: workgraph\.drasi\.io\/v1$/m);
  assert.match(yaml, /^  trigger: workgraph$/m);
  assert.doesNotMatch(yaml, /status:\s*new/i);
  assert.equal(expected.marker, "WorkGraphWorkflowDefinition/v1");
  assert.equal(expected.workflowDefinitionId, "issue-lifecycle");
  assert.equal(expected.version, "v1");
  assert.deepEqual(Object.keys(expected.steps), [
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
  ]);
  assert.equal(expected.steps.A.next, "B");
  assert.equal(expected.steps.B.next, "C");
  assert.deepEqual(expected.steps.C.acceptedOutcomes, {
    "needs-info": "D",
    continue: "E",
    reject: "F",
  });
  assert.deepEqual(expected.steps.D.wait, {
    event: "root-issue-comment",
    rootIssue: true,
    authorType: "non-agent-human",
    target: "C",
  });
  assert.deepEqual(expected.steps.G.children, [
    "G-title",
    "G-body",
    "G-reproduction",
  ]);
  assert.deepEqual(expected.steps.G.join, {
    mode: "all",
    require: "accepted",
    coordinator: "after-children",
  });
  assert.equal(expected.steps.E.next, "G");
  assert.equal(expected.steps.F.next, "ignored");
  assert.equal(expected.steps.G.next, "H");
  assert.equal(expected.steps.H.next, "completed");
  assert.equal(expected.defaults.maxRework, DEFAULT_MAX_REWORK);
  assert.equal(expected.steps.C.evaluator, "issue-validation-evaluator");
  assert.equal(
    expected.steps.G.orchestrator,
    "validation-stage-coordinator",
  );
  assert.equal(expected.steps.G.maxRework, 2);
  assert.deepEqual(expected.terminals, {
    ignored: "ignored",
    completed: "completed",
  });
});

test("high-level IssueWorkflow shape is strict and resolves all graph references", () => {
  const workflow = richWorkflow();
  assert.deepEqual(normalizeIssueWorkflow(workflow), workflow);

  const wrongTrigger = clone(workflow);
  wrongTrigger.spec.trigger = "new";
  assert.throws(() => normalizeIssueWorkflow(wrongTrigger), /must be workgraph/);

  const unqualifiedWait = clone(workflow);
  unqualifiedWait.spec.steps.D.next.where.authorType = "agent";
  assert.throws(
    () => normalizeIssueWorkflow(unqualifiedWait),
    /non-agent-human Root Issue comment/,
  );

  const missingTarget = clone(workflow);
  missingTarget.spec.steps.E.next = "Z";
  assert.throws(
    () => normalizeIssueWorkflow(missingTarget),
    /declared workflow step/,
  );

  const rejectedBusinessOutcome = clone(workflow);
  rejectedBusinessOutcome.spec.steps.C.outcomes[0].verdict = "rejected";
  assert.throws(
    () => normalizeIssueWorkflow(rejectedBusinessOutcome),
    /accepted for a business outcome/,
  );
});

function evaluation(verdict = "accepted") {
  return {
    evaluationId: "evaluation-1",
    rootIssueId: "I_root_issue",
    workflowRunId: "run-1",
    taskId: "task-C",
    resultId: "result-1",
    resultDigest: `sha256:${"a".repeat(64)}`,
    evaluatorId: "issue-validation-evaluator",
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
    taskId: "task-C",
    resultId: "result-1",
    evaluationId: "evaluation-1",
    evaluationVerdict: verdict,
    orchestratorId: "workflow-coordinator",
    action,
    attempt: 0,
  };
  if (action === "advance") {
    value.outcome = "continue";
    value.target = "E";
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
        result: { resultId: "result-1" },
      }),
    /properties must be exactly/,
  );
});

test("Route matrix, advance pair, exclusions, and bounded same-task rework are strict", () => {
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
  assert.throws(
    () => formatTaskRoute(route("rework", "accepted")),
    /invalid for verdict accepted/,
  );
  assert.throws(
    () => formatTaskRoute(route("complete", "rejected")),
    /invalid for verdict rejected/,
  );
  const missingTarget = route("advance");
  delete missingTarget.target;
  assert.throws(
    () => formatTaskRoute(missingTarget),
    /properties must be exactly/,
  );
  assert.throws(
    () => formatTaskRoute({ ...route("complete"), outcome: "continue" }),
    /properties must be exactly/,
  );

  const first = {
    taskId: "task-G-title",
    assignmentId: "assignment-1",
    attempt: 0,
  };
  const second = nextReworkAttempt(first);
  assert.deepEqual(second, { ...first, attempt: 1 });
  assert.deepEqual(nextReworkAttempt(second), { ...first, attempt: 2 });
  assert.deepEqual(nextReworkAttempt({ ...first, attempt: 2 }), {
    ...first,
    attempt: 3,
  });
  assert.throws(
    () => nextReworkAttempt({ ...first, attempt: 3 }),
    /maximum of 3/,
  );
});
