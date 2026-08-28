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
} from "../.github/mcp/workgraph-vnext-definition.mjs";

const CANONICAL_DEFINITION_PATH =
  ".github/workgraph/workflows/issue-lifecycle-vnext.body";
const CANONICAL_ROOT_PATH =
  ".github/workgraph/fixtures/vnext/workgraph-vnext-live-proof-root-task.body";
const LIVE_PROOF_INPUTS_PATH =
  ".github/workgraph/fixtures/vnext/live-proof-inputs.json";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function clone(value) {
  return structuredClone(value);
}

function taskDefinitions(root) {
  return [root, ...root.children.flatMap(taskDefinitions)];
}

function nestedDefinition() {
  return {
    workflowDefinitionId: "issue-validation",
    version: "v3",
    digest: `sha256:${"a".repeat(64)}`,
    root: {
      taskDefinitionId: "issue-validation-v3-root",
      taskKey: "root",
      operation: "summarize",
      routing: { permittedExecutors: ["summary-agent"] },
      staticInputs: { objective: "validate the issue" },
      children: [
        {
          taskDefinitionId: "issue-validation-v3-body",
          taskKey: "body",
          operation: "validate-body",
          routing: { permittedExecutors: ["body-agent"] },
          staticInputs: {},
          children: [
            {
              taskDefinitionId: "issue-validation-v3-body-links",
              taskKey: "body-links",
              operation: "validate-links",
              routing: { permittedExecutors: ["link-agent"] },
              staticInputs: {},
              children: [],
            },
          ],
        },
        {
          taskDefinitionId: "issue-validation-v3-title",
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

test("frozen Dogfood definition and root fixtures remain byte exact", async () => {
  const [definitionBody, rootBody] = await Promise.all([
    read(CANONICAL_DEFINITION_PATH),
    read(CANONICAL_ROOT_PATH),
  ]);

  assert.equal(Buffer.byteLength(definitionBody), 846);
  assert.equal(
    sha256(definitionBody),
    "1cd5b13c8017395dabbf25eb75465034cd54b6545be7d9fe889def1909aa66c7",
  );
  assert.equal(Buffer.byteLength(rootBody), 384);
  assert.equal(
    sha256(rootBody),
    "1cc6dfb17b655e26d53e4ade591b56f7b3adf693b01320bc8e371b150c6d936c",
  );

  const definition = parseWorkflowDefinition(definitionBody);
  const rootTask = parseRuntimeTask(rootBody);
  assert.equal(formatWorkflowDefinition(definition), definitionBody);
  assert.equal(formatRuntimeTask(rootTask), rootBody);
  assert.equal(
    definition.digest,
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.deepEqual(validateRootRuntimeTask(definition, rootTask), rootTask);
});

test("recursive definition keeps static data and deterministic identities on definitions", () => {
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
  assert.ok(tasks.some((task) => task.children.length === 0));
  assert.equal(
    new Set(tasks.map(({ taskDefinitionId }) => taskDefinitionId)).size,
    tasks.length,
  );
  assert.equal(
    new Set(tasks.map(({ taskKey }) => taskKey)).size,
    tasks.length,
  );
  assert.deepEqual(definition.root.staticInputs, {
    objective: "validate the issue",
  });
});

test("formatter canonicalizes data maps but requires canonical child ordering", () => {
  const definition = nestedDefinition();
  definition.root.staticInputs = {
    proofMode: "isolated",
    evaluationRoutes: {
      succeeded: "triage",
      failed: "request-info",
    },
  };
  const body = formatWorkflowDefinition(definition);
  assert.ok(body.indexOf('"evaluationRoutes"') < body.indexOf('"proofMode"'));
  assert.ok(body.indexOf('"failed"') < body.indexOf('"succeeded"'));

  definition.root.staticInputs = {
    2: "two",
    10: "ten",
    "\uE000": "private-use",
    "😀": "supplementary",
  };
  const numericKeyBody = formatWorkflowDefinition(definition);
  assert.ok(numericKeyBody.indexOf('"10"') < numericKeyBody.indexOf('"2"'));
  assert.ok(
    numericKeyBody.indexOf('"\uE000"') < numericKeyBody.indexOf('"😀"'),
  );
  assert.deepEqual(
    parseWorkflowDefinition(numericKeyBody).root.staticInputs,
    definition.root.staticInputs,
  );

  definition.root.children.reverse();
  assert.throws(
    () => formatWorkflowDefinition(definition),
    /children must be ordered by unique taskKey/,
  );
});

test("definition validation rejects duplicate global identities", () => {
  const definition = nestedDefinition();

  const duplicateId = clone(definition);
  duplicateId.root.children[1].taskDefinitionId =
    duplicateId.root.children[0].taskDefinitionId;
  assert.throws(
    () => formatWorkflowDefinition(duplicateId),
    /repeats taskDefinitionId/,
  );

  const duplicateKey = clone(definition);
  duplicateKey.root.children[0].children[0].taskKey =
    duplicateKey.root.children[1].taskKey;
  assert.throws(
    () => formatWorkflowDefinition(duplicateKey),
    /repeats taskKey/,
  );
});

test("definition validation enforces depth, width, and routing bounds", () => {
  const definition = nestedDefinition();
  const leaf = clone(definition.root.children[1]);

  const tooDeep = clone(definition);
  let cursor = tooDeep.root;
  for (let depth = 0; depth < 5; depth += 1) {
    const child = clone(leaf);
    child.taskDefinitionId = `depth-${depth}`;
    child.taskKey = `depth-${depth}`;
    child.children = [];
    cursor.children = [child];
    cursor = child;
  }
  assert.throws(
    () => formatWorkflowDefinition(tooDeep),
    /maximum depth 4/,
  );

  const tooWide = clone(definition);
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
    const invalidRouting = clone(definition);
    invalidRouting.root.routing.permittedExecutors = permittedExecutors;
    assert.throws(
      () => formatWorkflowDefinition(invalidRouting),
      /permittedExecutors|repeats permitted executor/,
    );
  }
});

test("strict parsing rejects unknown, legacy, oversized, and noncanonical bodies", async () => {
  const definition = parseWorkflowDefinition(
    await read(CANONICAL_DEFINITION_PATH),
  );
  const unknown = clone(definition);
  unknown.root.unexpected = true;
  assert.throws(
    () => formatWorkflowDefinition(unknown),
    /properties must be exactly/,
  );

  const missingLeafChildren = clone(definition);
  delete missingLeafChildren.root.children[0].children;
  assert.throws(
    () => formatWorkflowDefinition(missingLeafChildren),
    /properties must be exactly/,
  );

  const markerData = clone(definition);
  markerData.root.staticInputs = { unsafe: "WorkGraphTask/v2" };
  assert.throws(
    () => formatWorkflowDefinition(markerData),
    /protocol markers/,
  );

  const body = formatWorkflowDefinition(definition);
  assert.throws(
    () => parseWorkflowDefinition(body.replace('  "version"', ' "version"')),
    /not canonical/,
  );
  assert.throws(
    () => parseWorkflowDefinition(body.replace("\n", "\r\n")),
    /not canonical/,
  );
  assert.throws(
    () => parseWorkflowDefinition(body.replace("WorkGraphWorkflowDefinition/v1", "WorkGraphTask/v2")),
    /not canonical/,
  );

  const oversized = clone(definition);
  oversized.root.staticInputs = { payload: "x".repeat(64 * 1024) };
  assert.throws(
    () => formatWorkflowDefinition(oversized),
    /exceeds 65536 bytes/,
  );
});

test("runtime instances must pin the exact immutable root definition", async () => {
  const [definitionBody, rootBody] = await Promise.all([
    read(CANONICAL_DEFINITION_PATH),
    read(CANONICAL_ROOT_PATH),
  ]);
  const definition = parseWorkflowDefinition(definitionBody);
  const root = parseRuntimeTask(rootBody);

  for (const [field, value] of [
    ["workflowDefinitionId", "different-workflow"],
    ["workflowDefinitionVersion", "v2"],
    [
      "workflowDefinitionDigest",
      `sha256:${"b".repeat(64)}`,
    ],
    ["taskDefinitionId", "different-root"],
  ]) {
    assert.throws(
      () => validateRootRuntimeTask(definition, { ...root, [field]: value }),
      new RegExp(field),
    );
  }

  assert.throws(
    () => formatRuntimeTask({ ...root, operation: "coordinate-issue" }),
    /properties must be exactly/,
  );
  assert.throws(
    () =>
      formatRuntimeTask({
        ...root,
        workflowRunId: "é".repeat(200),
      }),
    /1-256 characters/,
  );
  assert.doesNotThrow(() =>
    formatRuntimeTask({
      ...root,
      workflowRunId: "run\uFEFFid",
    }),
  );
  assert.throws(
    () =>
      formatRuntimeTask({
        ...root,
        resolvedInputs: { invalid: "\uD800" },
      }),
    /ordinary LF text/,
  );
});

test("planned live proof inputs remain deterministic and write-disabled", async () => {
  const inputs = JSON.parse(await read(LIVE_PROOF_INPUTS_PATH));

  assert.equal(inputs.resultIndexStateVersion, 5);
  assert.deepEqual(
    inputs.sourceReplay.map(({ revision, kind }) => [revision, kind]),
    [
      [1, "TaskDocument"],
      [2, "DefinitionDocument"],
    ],
  );
  assert.equal(inputs.expectedFirstState.state, "FORK");
  assert.equal(inputs.expectedFirstState.precreatedChildCount, 0);
  assert.deepEqual(
    inputs.nestedLifecycle.taskDefinitions.map(({ taskKey }) => taskKey),
    ["nested-root", "nested-middle", "nested-leaf"],
  );
  assert.equal(new Set(inputs.executorCapacity.slotIds).size, 2);
  assert.equal(inputs.executorCapacity.requireDistinctDispatchIds, true);
  assert.deepEqual(
    [
      inputs.resultEvaluation.success.expectedRoute,
      inputs.resultEvaluation.failure.expectedRoute,
    ],
    ["complete", "fail"],
  );
  assert.equal(inputs.requestInfoResume.replyEncoding, "utf-8-hex");
  assert.equal(inputs.requestInfoResume.requiresFreshRun, true);
  assert.deepEqual(
    inputs.restartBoundaries.map(({ phase }) => phase),
    [
      "reducer",
      "fork-assign",
      "dispatch",
      "evaluate-close",
      "wait-resume",
    ],
  );
  assert.equal(inputs.activation.githubWritesAllowed, false);
  assert.equal(inputs.activation.clearStateVersionsBefore, 5);
});
