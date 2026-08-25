import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkflowAssignment,
  formatWorkflowResult,
  formatWorkflowTask,
  parseWorkflowResult,
  parseWorkflowTask,
  validateParallelTaskFamily,
} from "../.github/mcp/workgraph-v2-protocol.mjs";

const DIGEST = `sha256:${"0".repeat(64)}`;
const COMMON = {
  workflowId: "issue-lifecycle",
  workflowRunId: "run-001",
  stepId: "parallel-validation",
  definitionCommit: "a".repeat(40),
  definitionDigest: DIGEST,
  generation: 1,
};
const MANIFEST = [
  {
    branchId: "title",
    operation: "validate-title",
    agent: "issue-title-validator",
    inputs: { rule: "non-empty", field: "title" },
  },
  {
    branchId: "body",
    operation: "validate-body",
    agent: "issue-body-validator",
    inputs: { rule: "non-empty", field: "body" },
  },
];
const PARENT = {
  taskType: "workflow-task",
  inputs: {
    ...COMMON,
    operation: "evaluate-validation",
    agent: "issue-validation-evaluator",
    inputs: { issueNodeId: "I_parent" },
    join: "all",
    expectedChildCount: 2,
    children: MANIFEST,
  },
};
const CHILDREN = MANIFEST.map((branch) => ({
  taskType: "workflow-task",
  inputs: {
    ...COMMON,
    operation: branch.operation,
    agent: branch.agent,
    inputs: branch.inputs,
    branchId: branch.branchId,
  },
}));

test("WorkGraphTask/v2 round-trips a complete canonical parent manifest", () => {
  const body = formatWorkflowTask(PARENT);
  const parsed = parseWorkflowTask(body);

  assert.deepEqual(parsed, {
    taskType: "workflow-task",
    inputs: {
      ...COMMON,
      operation: "evaluate-validation",
      agent: "issue-validation-evaluator",
      inputs: { issueNodeId: "I_parent" },
      join: "all",
      expectedChildCount: 2,
      children: [
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
      ],
    },
  });
  assert.match(body, /^WorkGraphTask\/v2\n\n```yaml\n/);
  assert.match(body, /"expectedChildCount": 2/);
});

test("parallel family validation requires exact current-generation branches", () => {
  assert.equal(validateParallelTaskFamily(PARENT, CHILDREN), true);

  assert.throws(
    () => validateParallelTaskFamily(PARENT, CHILDREN.slice(0, 1)),
    /observed child count/,
  );
  assert.throws(
    () =>
      validateParallelTaskFamily(PARENT, [
        CHILDREN[0],
        {
          ...CHILDREN[1],
          inputs: { ...CHILDREN[1].inputs, generation: 2 },
        },
      ]),
    /generation must match/,
  );
  assert.throws(
    () =>
      validateParallelTaskFamily(PARENT, [
        CHILDREN[0],
        {
          ...CHILDREN[1],
          inputs: { ...CHILDREN[1].inputs, branchId: "unexpected" },
        },
      ]),
    /expected and unique/,
  );
});

test("v2 task validation rejects incomplete or contradictory joins", () => {
  assert.throws(
    () =>
      formatWorkflowTask({
        ...PARENT,
        inputs: { ...PARENT.inputs, expectedChildCount: 3 },
      }),
    /length must equal/,
  );
  assert.throws(
    () =>
      formatWorkflowTask({
        ...PARENT,
        inputs: {
          ...PARENT.inputs,
          children: [
            PARENT.inputs.children[0],
            {
              ...PARENT.inputs.children[1],
              agent: PARENT.inputs.children[0].agent,
            },
          ],
        },
      }),
    /agent values must be unique/,
  );
  assert.throws(
    () =>
      formatWorkflowTask({
        ...PARENT,
        inputs: {
          ...PARENT.inputs,
          agent: PARENT.inputs.children[0].agent,
        },
      }),
    /must differ from every child agent/,
  );
  assert.throws(
    () =>
      formatWorkflowTask({
        taskType: "workflow-task",
        inputs: {
          ...CHILDREN[0].inputs,
          unexpected: true,
        },
      }),
    /unknown \[unexpected\]/,
  );
});

test("workflow Result and Assignment retain the existing comment versions", () => {
  const result = {
    taskType: "workflow-task",
    leaseId: "lease-001",
    outcome: "succeeded",
    summary: "Title validation completed.",
    result: { evidence: "Present.", passed: true },
  };
  const resultBody = formatWorkflowResult(result);

  assert.match(resultBody, /^WorkGraphTaskResult\/v1\n/);
  assert.deepEqual(parseWorkflowResult(resultBody), result);
  assert.equal(
    formatWorkflowAssignment("issue-title-validator"),
    'WorkGraphTaskAssignment/v1\n\n```json\n{\n  "agentId": "issue-title-validator"\n}\n```\n',
  );
});

test("noncanonical v2 bodies and generic empty Results are rejected", () => {
  assert.throws(
    () => parseWorkflowTask(`${formatWorkflowTask(CHILDREN[0])}\n`),
    /not canonical/,
  );
  assert.throws(
    () =>
      formatWorkflowResult({
        taskType: "workflow-task",
        leaseId: "lease-001",
        outcome: "succeeded",
        summary: "Done.",
        result: {},
      }),
    /non-empty object/,
  );
  assert.equal(
    parseWorkflowResult(
      'WorkGraphTaskResult/v1\n\n```json\n{"taskType":"workflow-task"}\n```\n',
    ),
    null,
  );
});
