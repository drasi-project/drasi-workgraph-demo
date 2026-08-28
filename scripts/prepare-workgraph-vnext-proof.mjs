#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRuntimeTask,
  parseWorkflowDefinition,
  validateRootRuntimeTask,
} from "../.github/mcp/workgraph-vnext-definition.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKGRAPH_ROOT = resolve(REPOSITORY_ROOT, ".github/workgraph");
const INPUTS_PATH = resolve(
  WORKGRAPH_ROOT,
  "fixtures/vnext/live-proof-inputs.json",
);
const FROZEN_BODIES = {
  TaskDocument: {
    path: resolve(
      WORKGRAPH_ROOT,
      "fixtures/vnext/workgraph-vnext-live-proof-root-task.body",
    ),
    bytes: 384,
    sha256: "1cc6dfb17b655e26d53e4ade591b56f7b3adf693b01320bc8e371b150c6d936c",
  },
  DefinitionDocument: {
    path: resolve(WORKGRAPH_ROOT, "workflows/issue-lifecycle-vnext.body"),
    bytes: 846,
    sha256: "1cd5b13c8017395dabbf25eb75465034cd54b6545be7d9fe889def1909aa66c7",
  },
};
const RUNTIME_CONTRACT = {
  dogfoodCommit: "a14a210d785604a78b72c663e0d655ce49e8f75c",
  coreCommit: "7be2e1bd895196c1e4fbf99a23dbbcbdb4abc8e8",
  demoCommit: "44e308c547d5471b83e5604eda28440ea855dc52",
  queryInventory: { lifecycle: 10, detail: 6, total: 16 },
  stateStorePath: "data/workgraph-vnext-v6.redb",
  serverConfig: "server-config-vnext.yaml",
  expectedDryRun: {
    mode: "dry-run",
    sourceKey: "github:issue:9001",
    taskId: "demo-run-0001-root",
    nextAction: "FORK",
    writes: [],
  },
};

function exactKeys(value, keys, context) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    throw new Error(`${context} properties must be exactly ${keys.join(", ")}`);
  }
}

function validateDocumentMetadata(entry) {
  exactKeys(entry, ["revision", "kind", "document"], "Source replay entry");
  if (entry.kind === "TaskDocument") {
    exactKeys(
      entry.document,
      ["sourceKey", "bodyPath", "isOpen", "stateReason", "parentSourceKey"],
      "TaskDocument",
    );
    if (
      entry.document.sourceKey !== "github:issue:9001" ||
      entry.document.isOpen !== true ||
      entry.document.stateReason !== "open" ||
      entry.document.parentSourceKey !== null
    ) {
      throw new Error("root TaskDocument metadata must match the frozen proof");
    }
  } else if (entry.kind === "DefinitionDocument") {
    exactKeys(
      entry.document,
      ["sourceKey", "bodyPath"],
      "DefinitionDocument",
    );
    if (
      entry.document.sourceKey !==
      "github:definition:demo-issue-lifecycle:v1"
    ) {
      throw new Error(
        "DefinitionDocument sourceKey must match the frozen proof",
      );
    }
  } else {
    throw new Error(`unsupported VNext Source document kind: ${entry.kind}`);
  }
}

function validateFrozenBody(kind, path, body) {
  const expected = FROZEN_BODIES[kind];
  const bytes = Buffer.byteLength(body, "utf8");
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  if (path !== expected.path || bytes !== expected.bytes || sha256 !== expected.sha256) {
    throw new Error(`${kind} body must match the frozen repository fixture`);
  }
}

function localWorkGraphPath(basePath, configuredPath) {
  const resolved = resolve(dirname(basePath), configuredPath);
  const location = relative(WORKGRAPH_ROOT, resolved);
  if (location.startsWith("..") || resolve(WORKGRAPH_ROOT, location) !== resolved) {
    throw new Error(`proof body path escapes .github/workgraph: ${configuredPath}`);
  }
  return resolved;
}

export async function buildVNextProofDocuments() {
  const inputs = JSON.parse(await readFile(INPUTS_PATH, "utf8"));
  if (JSON.stringify(inputs.runtimeContract) !== JSON.stringify(RUNTIME_CONTRACT)) {
    throw new Error("VNext proof runtime contract does not match the immutable handoff");
  }
  if (
    inputs.activation?.githubWritesAllowed !== false ||
    inputs.activation?.effects !== "disabled-or-mocked-only" ||
    inputs.activation?.resetStateStorePath !== RUNTIME_CONTRACT.stateStorePath ||
    JSON.stringify(inputs.activation?.preserveStateStorePaths) !==
      JSON.stringify(["data/workgraph-vnext-v5.redb"])
  ) {
    throw new Error("VNext proof inputs must remain write-disabled");
  }
  if (inputs.resultIndexStateVersion !== 6) {
    throw new Error("VNext proof requires RESULT_INDEX_STATE_VERSION=6");
  }
  if (!Array.isArray(inputs.sourceReplay) || inputs.sourceReplay.length !== 2) {
    throw new Error("VNext proof must contain exactly root and definition documents");
  }

  const documents = [];
  let definition;
  let rootTask;
  for (const entry of inputs.sourceReplay) {
    validateDocumentMetadata(entry);
    const bodyPath = localWorkGraphPath(INPUTS_PATH, entry.document.bodyPath);
    const body = await readFile(bodyPath, "utf8");
    validateFrozenBody(entry.kind, bodyPath, body);
    const document = { ...entry.document, body };
    delete document.bodyPath;

    if (entry.kind === "TaskDocument") {
      rootTask = parseRuntimeTask(body);
    } else if (entry.kind === "DefinitionDocument") {
      definition = parseWorkflowDefinition(body);
    }
    documents.push({
      revision: entry.revision,
      kind: entry.kind,
      document,
    });
  }

  if (
    documents[0].revision !== 1 ||
    documents[0].kind !== "TaskDocument" ||
    documents[1].revision !== 2 ||
    documents[1].kind !== "DefinitionDocument"
  ) {
    throw new Error("VNext proof replay must remain task-first revisions 1 and 2");
  }
  if (!definition || !rootTask) {
    throw new Error("VNext proof requires one canonical definition and root task");
  }
  validateRootRuntimeTask(definition, rootTask);
  if (
    rootTask.taskId !== inputs.expectedFirstState.taskId ||
    inputs.expectedFirstState.state !== "FORK" ||
    inputs.expectedFirstState.precreatedChildCount !== 0
  ) {
    throw new Error("VNext proof root must enter FORK without pre-created children");
  }
  return documents;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const documents = await buildVNextProofDocuments();
  process.stdout.write(`${JSON.stringify(documents, null, 2)}\n`);
}
