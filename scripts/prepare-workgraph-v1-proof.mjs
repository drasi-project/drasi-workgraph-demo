#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatRuntimeTask,
  parseCompiledWorkflowDefinition,
  validateRootRuntimeTask,
} from "../.github/mcp/workgraph-v1-definition.mjs";
import {
  deriveWorkGraphAdmissionId,
  deriveWorkGraphRootIssueContentDigest,
  deriveWorkGraphRootTaskId,
  deriveWorkGraphWorkflowRunId,
} from "../.github/mcp/workgraph-reporter.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKGRAPH_ROOT = resolve(REPOSITORY_ROOT, ".github/workgraph");
const INPUTS_PATH = resolve(
  WORKGRAPH_ROOT,
  "fixtures/v1/live-proof-inputs.json",
);
const COMPILED_PATH = resolve(
  WORKGRAPH_ROOT,
  "fixtures/v1/issue-lifecycle.expected.json",
);
const CANONICAL_GENERIC_INVENTORY_PATH = resolve(
  REPOSITORY_ROOT,
  "../drasi-dogfooding/.github/extensions/workgraph-v1-view/contract/query-inventory.json",
);
const GENERIC_QUERY_IDS = [
  "wg-issues-waiting-for-admission",
  "wg-tasks-waiting-for-fork",
  "wg-tasks-waiting-for-join-all",
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
  "wg-predecessor-result-detail",
];
const GENERATED_QUERY_COUNT = 6;

function exact(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new Error(
      `${label} properties must be exactly ${[...keys].sort().join(", ")}`,
    );
  }
}

function localWorkGraphPath(configuredPath) {
  const resolved = resolve(dirname(INPUTS_PATH), configuredPath);
  const location = relative(WORKGRAPH_ROOT, resolved);
  if (location.startsWith("..") || resolve(WORKGRAPH_ROOT, location) !== resolved) {
    throw new Error(`proof body path escapes .github/workgraph: ${configuredPath}`);
  }
  return resolved;
}

function validateActivation(value) {
  exact(
    value,
    [
      "serverAutoStart",
      "sourceAutoStart",
      "queryAutoStart",
      "reactionMode",
      "dryRun",
      "liveAcknowledgment",
      "githubWritesAllowed",
    ],
    "activation",
  );
  if (
    value.serverAutoStart !== false ||
    value.sourceAutoStart !== false ||
    value.queryAutoStart !== false ||
    value.reactionMode !== "disabled" ||
    value.dryRun !== true ||
    value.liveAcknowledgment !== false ||
    value.githubWritesAllowed !== false
  ) {
    throw new Error("proof activation must remain disabled and write-free");
  }
}

function queryDigestEntries(entries, expectedIds, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`${label} must be an array`);
  }
  const projected = entries.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`${label}[${index}] must contain a valid id and SHA-256`);
    }
    return { id: entry.id, sha256: entry.sha256 };
  });
  if (
    JSON.stringify(projected.map(({ id }) => id)) !==
    JSON.stringify(expectedIds)
  ) {
    throw new Error(`${label} IDs are not the exact canonical ordered set`);
  }
  return projected;
}

function queryContractDigest(entries) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex")}`;
}

export function validateGeneratedQueryInventory(queryBundle) {
  const generatedInventory = queryBundle?.canvasInventory;
  const generatedQueries = queryBundle?.queries;
  if (
    !Array.isArray(generatedInventory) ||
    !Array.isArray(generatedQueries) ||
    generatedInventory.length !== GENERATED_QUERY_COUNT ||
    generatedQueries.length !== GENERATED_QUERY_COUNT
  ) {
    throw new Error("compiler output must contain exactly six generated queries");
  }
  const generatedQueryIds = generatedInventory.map(({ id }) => id);
  const compiledQueryIds = generatedQueries.map(({ id }) => id);
  if (JSON.stringify(generatedQueryIds) !== JSON.stringify(compiledQueryIds)) {
    throw new Error(
      "compiled query and Canvas inventories must have identical ordered IDs",
    );
  }
  const compiledInventory = queryDigestEntries(
    generatedInventory,
    generatedQueryIds,
    "compiled generated query inventory",
  );
  generatedQueries.forEach((query, index) => {
    if (typeof query.query !== "string") {
      throw new Error(`compiled generated query[${index}] body must be text`);
    }
    const actualHash = createHash("sha256")
      .update(query.query, "utf8")
      .digest("hex");
    if (actualHash !== compiledInventory[index].sha256) {
      throw new Error(
        `compiled generated query '${query.id}' body SHA-256 differs from its Canvas inventory`,
      );
    }
  });
  return compiledInventory;
}

export async function buildWorkGraphV1Proof() {
  const inputs = JSON.parse(await readFile(INPUTS_PATH, "utf8"));
  const compiled = JSON.parse(await readFile(COMPILED_PATH, "utf8"));
  const canonicalGenericInventory = JSON.parse(
    await readFile(CANONICAL_GENERIC_INVENTORY_PATH, "utf8"),
  );
  exact(
    inputs,
    [
      "runtimeContract",
      "definition",
      "rootIssueAdmission",
      "expectedRootTask",
      "expectedLifecycle",
      "leaseValidation",
      "activation",
    ],
    "proof inputs",
  );
  validateActivation(inputs.activation);

  exact(
    inputs.runtimeContract,
    [
      "sourceId",
      "reactionId",
      "serverConfig",
      "stateStorePath",
      "queryIds",
      "queryContractDigest",
    ],
    "runtimeContract",
  );
  const queryIds = inputs.runtimeContract.queryIds;
  if (
    inputs.runtimeContract.sourceId !== "github-workgraph-v1" ||
    inputs.runtimeContract.reactionId !== "workgraph-v1" ||
    inputs.runtimeContract.serverConfig !==
      "server-config-v1-loopback.yaml" ||
    inputs.runtimeContract.stateStorePath !==
      "data/workgraph-v1-loopback.redb"
  ) {
    throw new Error(
      "proof runtime identities do not match the v1 loopback configuration",
    );
  }

  const definitionPath = localWorkGraphPath(inputs.definition.bodyPath);
  const definitionBody = await readFile(definitionPath, "utf8");
  if (definitionBody !== compiled.canonicalDefinitionBody) {
    throw new Error("workflow definition differs from compiler output");
  }
  const compiledInventory = validateGeneratedQueryInventory(
    compiled.queryBundle,
  );
  const generatedQueryIds = compiledInventory.map(({ id }) => id);
  const expectedQueryIds = [...GENERIC_QUERY_IDS, ...generatedQueryIds];
  if (
    JSON.stringify(queryIds) !== JSON.stringify(expectedQueryIds)
  ) {
    throw new Error(
      "proof query IDs must be the exact ordered generic and generated sets",
    );
  }
  const genericSections = [
    "admissionQueries",
    "lifecycleQueries",
    "detailQueries",
  ];
  if (
    genericSections.some(
      (section) => !Array.isArray(canonicalGenericInventory[section]),
    )
  ) {
    throw new Error(
      "canonical sibling inventory must contain generic query arrays",
    );
  }
  const genericInventory = queryDigestEntries(
    genericSections.flatMap((section) => canonicalGenericInventory[section]),
    GENERIC_QUERY_IDS,
    "canonical sibling generic query inventory",
  );
  const contractDigest = queryContractDigest([
    ...genericInventory,
    ...compiledInventory,
  ]);
  if (inputs.runtimeContract.queryContractDigest !== contractDigest) {
    throw new Error(
      "proof queryContractDigest differs from the canonical query inventories",
    );
  }
  const definition = parseCompiledWorkflowDefinition(definitionBody);
  for (const field of ["workflowDefinitionId", "version", "digest"]) {
    if (definition[field] !== inputs.definition[field]) {
      throw new Error(`workflow definition ${field} differs from proof inputs`);
    }
  }

  const rootIssue = inputs.rootIssueAdmission;
  exact(
    rootIssue,
    [
      "repositoryOwner",
      "repositoryName",
      "repositoryNodeId",
      "issueNumber",
      "issueNodeId",
      "label",
      "deliveryId",
      "admissionId",
      "title",
      "body",
      "contentDigest",
    ],
    "Root Issue admission",
  );
  if (
    rootIssue.repositoryOwner !== "drasi-project" ||
    rootIssue.repositoryName !== "drasi-workgraph-demo" ||
    rootIssue.label !== "workgraph"
  ) {
    throw new Error("Root Issue admission repository or label is not canonical");
  }
  const admissionId = deriveWorkGraphAdmissionId(
    rootIssue.issueNodeId,
    rootIssue.deliveryId,
  );
  const contentDigest = deriveWorkGraphRootIssueContentDigest(
    rootIssue.title,
    rootIssue.body,
  );
  if (
    admissionId !== rootIssue.admissionId ||
    contentDigest !== rootIssue.contentDigest
  ) {
    throw new Error("Root Issue admission identities are not canonical");
  }

  const workflowRunId = deriveWorkGraphWorkflowRunId(
    rootIssue.repositoryNodeId,
    rootIssue.issueNodeId,
    admissionId,
    definition.workflowDefinitionId,
    definition.version,
    definition.digest,
  );
  const taskId = deriveWorkGraphRootTaskId(
    workflowRunId,
    definition.root.taskDefinitionId,
  );
  const rootTask = {
    taskId,
    rootIssueId: rootIssue.issueNodeId,
    workflowRunId,
    workflowDefinitionId: definition.workflowDefinitionId,
    workflowDefinitionVersion: definition.version,
    workflowDefinitionDigest: definition.digest,
    taskDefinitionId: definition.root.taskDefinitionId,
    taskKey: definition.root.taskKey,
    operation: definition.root.operation,
    resolvedInputs: {
      ...definition.root.staticInputs,
      rootIssue: {
        repositoryOwner: rootIssue.repositoryOwner,
        repositoryName: rootIssue.repositoryName,
        repositoryNodeId: rootIssue.repositoryNodeId,
        issueNumber: rootIssue.issueNumber,
        issueNodeId: rootIssue.issueNodeId,
        admissionId,
        contentDigest,
      },
    },
  };
  validateRootRuntimeTask(definition, rootTask);
  if (
    inputs.expectedRootTask.taskId !== taskId ||
    inputs.expectedRootTask.rootIssueId !== rootTask.rootIssueId ||
    inputs.expectedRootTask.workflowRunId !== workflowRunId ||
    inputs.expectedRootTask.taskDefinitionId !== rootTask.taskDefinitionId ||
    inputs.expectedRootTask.taskKey !== rootTask.taskKey ||
    inputs.expectedRootTask.operation !== rootTask.operation ||
    inputs.expectedRootTask.firstLifecycleState !== "FORK" ||
    inputs.expectedRootTask.precreatedChildCount !== 0
  ) {
    throw new Error("expected Root Task does not match Root Issue admission");
  }
  if (
    JSON.stringify(inputs.expectedLifecycle) !==
    JSON.stringify([
      "FORK",
      "JOIN_ALL",
      "ASSIGN",
      "LEASE",
      "DISPATCH",
      "RESULT",
      "EVALUATE",
      "ROUTE",
      "CLOSE",
      "CLOSED",
    ])
  ) {
    throw new Error("proof lifecycle differs from the v1 state progression");
  }
  if (
    inputs.leaseValidation.path !==
      "/github/workgraph-v1/lease/validate" ||
    JSON.stringify(inputs.leaseValidation.requestFields) !==
      JSON.stringify([
        "taskId",
        "leaseId",
        "assignmentId",
        "executorId",
        "slotId",
        "claimId",
      ])
  ) {
    throw new Error("proof Lease validation contract is not canonical");
  }

  return {
    rootIssueAdmission: rootIssue,
    workflowDefinition: definition,
    expectedRootTask: {
      value: rootTask,
      body: formatRuntimeTask(rootTask),
      firstLifecycleState: "FORK",
    },
    expectedAdmissionQuery: {
      queryId: "wg-issues-waiting-for-admission",
      rootIssueId: rootIssue.issueNodeId,
      admissionId,
    },
    activation: inputs.activation,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await buildWorkGraphV1Proof(), null, 2)}\n`,
  );
}
