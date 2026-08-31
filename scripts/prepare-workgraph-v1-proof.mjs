#!/usr/bin/env node

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
const QUERY_COUNT = 35;

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

export async function buildWorkGraphV1Proof() {
  const inputs = JSON.parse(await readFile(INPUTS_PATH, "utf8"));
  const compiled = JSON.parse(await readFile(COMPILED_PATH, "utf8"));
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

  const queryIds = inputs.runtimeContract.queryIds;
  if (
    !Array.isArray(queryIds) ||
    queryIds.length !== QUERY_COUNT ||
    new Set(queryIds).size !== QUERY_COUNT ||
    queryIds.some((id) => typeof id !== "string" || !id.startsWith("wg-"))
  ) {
    throw new Error("proof must pin exactly 35 unique wg- query IDs");
  }
  if (
    inputs.runtimeContract.sourceId !== "github-workgraph-v1" ||
    inputs.runtimeContract.reactionId !== "workgraph-v1" ||
    inputs.runtimeContract.serverConfig !== "server-config-v1.yaml" ||
    inputs.runtimeContract.stateStorePath !== "data/workgraph-v1.redb"
  ) {
    throw new Error("proof runtime identities do not match the v1 configuration");
  }

  const definitionPath = localWorkGraphPath(inputs.definition.bodyPath);
  const definitionBody = await readFile(definitionPath, "utf8");
  if (definitionBody !== compiled.canonicalDefinitionBody) {
    throw new Error("workflow definition differs from compiler output");
  }
  const generatedQueryIds = compiled.queryBundle.queries.map(({ id }) => id);
  if (
    JSON.stringify(queryIds.slice(-generatedQueryIds.length)) !==
    JSON.stringify(generatedQueryIds)
  ) {
    throw new Error("proof generated query IDs differ from compiler output");
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
