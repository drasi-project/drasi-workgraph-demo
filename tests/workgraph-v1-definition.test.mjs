import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_TASK_DEFINITION_CHILDREN,
  formatRuntimeTask,
  formatWorkflowDefinition,
  parseRuntimeTask,
  parseWorkflowDefinition,
  validateRootRuntimeTask,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import { buildWorkGraphV1Proof } from "../scripts/prepare-workgraph-v1-proof.mjs";

const DEFINITION_PATH = ".github/workgraph/workflows/issue-lifecycle-v1.body";
const INPUTS_PATH = ".github/workgraph/fixtures/v1/live-proof-inputs.json";
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
