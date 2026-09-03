import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextEncoder } from "node:util";

export const WORKFLOW_DEFINITION_MARKER = "WorkGraphWorkflowDefinition/v1";
export const RUNTIME_TASK_MARKER = "WorkGraphTask/v1";
export const TASK_ASSIGNMENT_MARKER = "WorkGraphTaskAssignment/v1";
export const TASK_FORK_MARKER = "WorkGraphTaskFork/v1";
export const TASK_JOIN_MARKER = "WorkGraphTaskJoin/v1";
export const TASK_DISPATCH_MARKER = "WorkGraphTaskDispatch/v1";
export const TASK_RESULT_MARKER = "WorkGraphTaskResult/v1";
export const TASK_EVALUATION_MARKER = "WorkGraphTaskEvaluation/v1";
export const TASK_ROUTE_MARKER = "WorkGraphTaskRoute/v1";
export const TASK_ERROR_MARKER = "WorkGraphTaskError/v1";
export const WORKGRAPH_API_VERSION = "workgraph.drasi.io/v1";
export const WORKFLOW_AUTHORING_API_VERSION = WORKGRAPH_API_VERSION;
export const DEFAULT_MAX_REWORK_ATTEMPTS = 3;
export const MAX_TASK_DEFINITION_CHILDREN = 16;
export const MAX_TASK_DEFINITION_DEPTH = 4;
export const MAX_WORKGRAPH_BODY_BYTES = 64 * 1024;
export const MAX_TASK_DEFINITION_EXECUTORS = 8;
// Runtime writes these into `resolvedInputs` for generated entry, routed
// scope, and routed successor tasks, so a definition may not author them.
export const RESERVED_SUCCESSOR_INPUT_KEY = "workgraphPredecessorTaskId";
export const RESERVED_SCOPE_INPUT_KEYS = [
  "workgraphScopeEntryStepId",
  "workgraphScopeEntryTaskId",
  "workgraphScopeParentTaskId",
];
export const RESERVED_RUNTIME_INPUT_KEYS = [
  RESERVED_SUCCESSOR_INPUT_KEY,
  ...RESERVED_SCOPE_INPUT_KEYS,
];
export const WORKGRAPH_ID_NAMESPACE = "urn:drasi:workgraph:id:v1";

const MAX_DATA_DEPTH = 32;
const RESERVED_MARKERS = [
  WORKFLOW_DEFINITION_MARKER,
  RUNTIME_TASK_MARKER,
  TASK_ASSIGNMENT_MARKER,
  TASK_FORK_MARKER,
  TASK_JOIN_MARKER,
  TASK_DISPATCH_MARKER,
  TASK_RESULT_MARKER,
  TASK_EVALUATION_MARKER,
  TASK_ROUTE_MARKER,
  TASK_ERROR_MARKER,
];
const DEFINITION_KEYS = [
  "workflowDefinitionId",
  "version",
  "digest",
  "root",
];
const TASK_DEFINITION_KEYS = [
  "taskDefinitionId",
  "taskKey",
  "operation",
  "routing",
  "staticInputs",
  "children",
];
// `flowEntries` is additive: a definition that owns no routed scope omits it
// entirely, so every pre-flow canonical body and digest stays byte-identical.
const TASK_DEFINITION_OPTIONAL_KEYS = ["flowEntries"];
const ROUTING_KEYS = ["permittedExecutors"];
const RUNTIME_TASK_KEYS = [
  "taskId",
  "rootIssueId",
  "workflowRunId",
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
  "taskKey",
  "operation",
  "resolvedInputs",
];
const ENVELOPE_KEYS = [
  "apiVersion",
  "kind",
  "id",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "workflowContext",
  "references",
  "data",
];
const CONTEXT_KEYS = [
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
  "taskKey",
  "operation",
];
const TASK_IDENTITY_KEYS = ["taskId", "workflowRunId", ...CONTEXT_KEYS];
const EMPTY_KEYS = [];

export class WorkGraphDefinitionError extends Error {}

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, context) {
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must be an object`);
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new WorkGraphDefinitionError(
      `${context} properties must be exactly ${[...keys].sort().join(", ")}`,
    );
  }
}

function taskDefinitionKeys(value, context) {
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must be an object`);
  }
  const keys = Object.keys(value);
  const known = new Set([
    ...TASK_DEFINITION_KEYS,
    ...TASK_DEFINITION_OPTIONAL_KEYS,
  ]);
  if (
    TASK_DEFINITION_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !known.has(key))
  ) {
    throw new WorkGraphDefinitionError(
      `${context} properties must be exactly ${[...TASK_DEFINITION_KEYS]
        .sort()
        .join(", ")} with optional ${TASK_DEFINITION_OPTIONAL_KEYS.join(", ")}`,
    );
  }
}

// Declaration-local `flowEntries` invariants: ordered unique step IDs sharing
// one direct-child bound with the fixed children of the same definition.
function normalizeFlowEntries(value, childCount, taskDefinitionId, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkGraphDefinitionError(`${context}.flowEntries must be an array`);
  }
  if (childCount + value.length > MAX_TASK_DEFINITION_CHILDREN) {
    throw new WorkGraphDefinitionError(
      `task definition '${taskDefinitionId}' exceeds ${MAX_TASK_DEFINITION_CHILDREN} direct children`,
    );
  }
  for (const [index, entry] of value.entries()) {
    identifier(entry, `${context}.flowEntries entry`);
    if (index > 0 && value[index - 1] >= entry) {
      throw new WorkGraphDefinitionError(
        `task definition '${taskDefinitionId}' flowEntries must be ordered by unique step ID`,
      );
    }
  }
  return [...value];
}

function identifier(value, context) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value) ||
    value.endsWith("-")
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must be 1-64 lowercase letters, digits, or hyphens and cannot end in a hyphen`,
    );
  }
}

function workflowRunIdentifier(value, context) {
  const byteLength =
    typeof value === "string" ? new TextEncoder().encode(value).length : 0;
  if (
    typeof value !== "string" ||
    byteLength < 1 ||
    byteLength > 256 ||
    /[\p{White_Space}\p{Cc}]/u.test(value) ||
    !wellFormedUnicode(value)
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must contain 1-256 characters without whitespace or controls`,
    );
  }
}

export function validateWorkGraphTaskId(value, context = "taskId") {
  return validateWorkGraphProtocolId(value, "task", context);
}

function wellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(value, context) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new WorkGraphDefinitionError(`${context} must be a sha256 digest`);
  }
}

function ordinaryText(value) {
  return (
    wellFormedUnicode(value) &&
    !value.includes("\r") &&
    !value.includes("```") &&
    !RESERVED_MARKERS.some((marker) => value.includes(marker))
  );
}

function canonicalData(value, context, depth) {
  if (depth > MAX_DATA_DEPTH) {
    throw new WorkGraphDefinitionError(
      `${context} must not exceed ${MAX_DATA_DEPTH} nested levels`,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!ordinaryText(value)) {
      throw new WorkGraphDefinitionError(
        `${context} strings must be ordinary LF text without protocol markers`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new WorkGraphDefinitionError(
        `${context} numbers must be JavaScript-safe integers`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalData(entry, `${context}[${index}]`, depth + 1),
    );
  }
  if (!object(value)) {
    throw new WorkGraphDefinitionError(
      `${context} must contain only JSON values`,
    );
  }
  const keys = Object.keys(value).sort(utf8Compare);
  for (const key of keys) {
    if (key === "" || !ordinaryText(key)) {
      throw new WorkGraphDefinitionError(
        `${context} property names must be non-empty ordinary LF text`,
      );
    }
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      canonicalData(value[key], `${context}.${key}`, depth + 1),
    ]),
  );
}

function dataMap(value, context) {
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must be an object`);
  }
  return canonicalData(value, context, 0);
}

function lifecycleData(value, context, depth = 0) {
  if (depth > MAX_DATA_DEPTH) {
    throw new WorkGraphDefinitionError(
      `${context} must not exceed ${MAX_DATA_DEPTH} nested levels`,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!lifecycleText(value)) {
      throw new WorkGraphDefinitionError(
        `${context} strings must be ordinary LF text`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new WorkGraphDefinitionError(
        `${context} numbers must be JavaScript-safe integers`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      lifecycleData(entry, `${context}[${index}]`, depth + 1),
    );
  }
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must contain only JSON values`);
  }
  const keys = Object.keys(value).sort(utf8Compare);
  for (const key of keys) {
    if (key === "" || !lifecycleText(key)) {
      throw new WorkGraphDefinitionError(
        `${context} property names must be non-empty ordinary LF text`,
      );
    }
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      lifecycleData(value[key], `${context}.${key}`, depth + 1),
    ]),
  );
}

function prettyJson(value, depth = 0, dataMode = false) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((entry) => `${childIndent}${prettyJson(entry, depth + 1, dataMode)}`)
      .join(",\n")}\n${indent}]`;
  }
  const keys = dataMode
    ? Object.getOwnPropertyNames(value).sort(utf8Compare)
    : Object.keys(value);
  if (keys.length === 0) return "{}";
  return `{\n${keys
    .map((key) => {
      const childDataMode =
        dataMode ||
        key === "staticInputs" ||
        key === "resolvedInputs" ||
        key === "output" ||
        key === "details";
      return `${childIndent}${JSON.stringify(key)}: ${prettyJson(
        value[key],
        depth + 1,
        childDataMode,
      )}`;
    })
    .join(",\n")}\n${indent}}`;
}

function normalizeTaskDefinition(task, context, depth, identities) {
  taskDefinitionKeys(task, context);
  if (depth > MAX_TASK_DEFINITION_DEPTH) {
    throw new WorkGraphDefinitionError(
      `task definition nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    );
  }
  validateWorkGraphProtocolId(
    task.taskDefinitionId,
    "task-definition",
    `${context}.taskDefinitionId`,
  );
  identifier(task.taskKey, `${context}.taskKey`);
  identifier(task.operation, `${context}.operation`);
  if (identities.definitionIds.has(task.taskDefinitionId)) {
    throw new WorkGraphDefinitionError(
      `workflow definition repeats taskDefinitionId '${task.taskDefinitionId}'`,
    );
  }
  if (identities.taskKeys.has(task.taskKey)) {
    throw new WorkGraphDefinitionError(
      `workflow definition repeats taskKey '${task.taskKey}'`,
    );
  }
  identities.definitionIds.add(task.taskDefinitionId);
  identities.taskKeys.add(task.taskKey);

  exactKeys(task.routing, ROUTING_KEYS, `${context}.routing`);
  if (
    !Array.isArray(task.routing.permittedExecutors) ||
    task.routing.permittedExecutors.length < 1 ||
    task.routing.permittedExecutors.length > MAX_TASK_DEFINITION_EXECUTORS
  ) {
    throw new WorkGraphDefinitionError(
      `${context}.routing.permittedExecutors must contain 1-${MAX_TASK_DEFINITION_EXECUTORS} entries`,
    );
  }
  const executors = new Set();
  for (const executor of task.routing.permittedExecutors) {
    identifier(executor, `${context}.routing.permittedExecutors`);
    if (executors.has(executor)) {
      throw new WorkGraphDefinitionError(
        `task definition repeats permitted executor '${executor}'`,
      );
    }
    executors.add(executor);
  }
  if (!Array.isArray(task.children)) {
    throw new WorkGraphDefinitionError(`${context}.children must be an array`);
  }
  if (task.children.length > MAX_TASK_DEFINITION_CHILDREN) {
    throw new WorkGraphDefinitionError(
      `task definition '${task.taskDefinitionId}' exceeds ${MAX_TASK_DEFINITION_CHILDREN} direct children`,
    );
  }
  for (let index = 1; index < task.children.length; index += 1) {
    if (task.children[index - 1].taskKey >= task.children[index].taskKey) {
      throw new WorkGraphDefinitionError(
        `task definition '${task.taskDefinitionId}' children must be ordered by unique taskKey`,
      );
    }
  }
  const flowEntries = normalizeFlowEntries(
    task.flowEntries,
    task.children.length,
    task.taskDefinitionId,
    context,
  );

  return {
    taskDefinitionId: task.taskDefinitionId,
    taskKey: task.taskKey,
    operation: task.operation,
    routing: {
      permittedExecutors: [...task.routing.permittedExecutors],
    },
    staticInputs: dataMap(task.staticInputs, `${context}.staticInputs`),
    children: task.children.map((child, index) =>
      normalizeTaskDefinition(
        child,
        `${context}.children[${index}]`,
        depth + 1,
        identities,
      ),
    ),
    ...(flowEntries.length > 0 ? { flowEntries } : {}),
  };
}

export function normalizeWorkflowDefinition(definition) {
  exactKeys(definition, DEFINITION_KEYS, "workflow definition");
  identifier(
    definition.workflowDefinitionId,
    "workflow definition workflowDefinitionId",
  );
  identifier(definition.version, "workflow definition version");
  digest(definition.digest, "workflow definition digest");
  return {
    workflowDefinitionId: definition.workflowDefinitionId,
    version: definition.version,
    digest: definition.digest,
    root: normalizeTaskDefinition(
      definition.root,
      "workflow definition root",
      0,
      { definitionIds: new Set(), taskKeys: new Set() },
    ),
  };
}

export function formatWorkflowDefinition(definition) {
  const normalized = normalizeWorkflowDefinition(definition);
  const body = `${WORKFLOW_DEFINITION_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
  if (new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES) {
    throw new WorkGraphDefinitionError(
      `${WORKFLOW_DEFINITION_MARKER} body exceeds ${MAX_WORKGRAPH_BODY_BYTES} bytes`,
    );
  }
  return body;
}

function parseCanonicalBody(body, marker, formatter) {
  if (
    typeof body !== "string" ||
    body.includes("\r") ||
    new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES
  ) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  const prefix = `${marker}\n\n\`\`\`json\n`;
  const suffix = "\n```\n";
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  let value;
  try {
    value = JSON.parse(body.slice(prefix.length, -suffix.length));
  } catch {
    throw new WorkGraphDefinitionError(`${marker} body is invalid JSON`);
  }
  if (formatter(value) !== body) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  return value;
}

export function parseWorkflowDefinition(body) {
  return parseCanonicalBody(
    body,
    WORKFLOW_DEFINITION_MARKER,
    formatWorkflowDefinition,
  );
}

export function formatCompiledWorkflowDefinition(definition) {
  const normalized = normalizeCompiledWorkflowDefinition(definition);
  const body = `${WORKFLOW_DEFINITION_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
  if (new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES) {
    throw new WorkGraphDefinitionError(
      `${WORKFLOW_DEFINITION_MARKER} body exceeds ${MAX_WORKGRAPH_BODY_BYTES} bytes`,
    );
  }
  return body;
}

export function parseCompiledWorkflowDefinition(body) {
  return parseCanonicalBody(
    body,
    WORKFLOW_DEFINITION_MARKER,
    formatCompiledWorkflowDefinition,
  );
}

function normalizeTaskContext(value, context = "message context") {
  exactKeys(value, CONTEXT_KEYS, context);
  identifier(value.workflowDefinitionId, `${context} workflowDefinitionId`);
  identifier(value.workflowDefinitionVersion, `${context} workflowDefinitionVersion`);
  digest(value.workflowDefinitionDigest, `${context} workflowDefinitionDigest`);
  validateWorkGraphProtocolId(
    value.taskDefinitionId,
    "task-definition",
    `${context} taskDefinitionId`,
  );
  identifier(value.taskKey, `${context} taskKey`);
  identifier(value.operation, `${context} operation`);
  return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, value[key]]));
}

export function normalizeTaskIdentity(value, context = "task identity") {
  exactKeys(value, TASK_IDENTITY_KEYS, context);
  validateWorkGraphTaskId(value.taskId, `${context} taskId`);
  validateWorkGraphProtocolId(
    value.workflowRunId,
    "workflow-run",
    `${context} workflowRunId`,
  );
  return {
    taskId: value.taskId,
    workflowRunId: value.workflowRunId,
    ...normalizeTaskContext(
      Object.fromEntries(CONTEXT_KEYS.map((key) => [key, value[key]])),
      context,
    ),
  };
}

function taskIdentity(value) {
  return {
    taskId: value.taskId,
    workflowRunId: value.workflowRunId,
    ...Object.fromEntries(CONTEXT_KEYS.map((key) => [key, value[key]])),
  };
}

function envelopeObject(kind, id, value, references, data) {
  directId(id, `${kind} message id`);
  workflowRunIdentifier(value.rootIssueId, `${kind} rootIssueId`);
  validateWorkGraphProtocolId(
    value.workflowRunId,
    "workflow-run",
    `${kind} workflowRunId`,
  );
  validateWorkGraphTaskId(value.taskId, `${kind} taskId`);
  const identity = normalizeTaskIdentity(
    value.task ?? taskIdentity(value),
    `${kind} task`,
  );
  if (
    identity.taskId !== value.taskId ||
    identity.workflowRunId !== value.workflowRunId
  ) {
    throw new WorkGraphDefinitionError(
      `${kind} direct identity must match its task identity`,
    );
  }
  return {
    apiVersion: WORKGRAPH_API_VERSION,
    kind,
    id,
    rootIssueId: value.rootIssueId,
    workflowRunId: value.workflowRunId,
    taskId: value.taskId,
    workflowContext: Object.fromEntries(
      CONTEXT_KEYS.map((key) => [key, identity[key]]),
    ),
    references,
    data,
  };
}

function formatEnvelope(marker, kind, id, value, references, data) {
  return formatArtifact(
    marker,
    envelopeObject(kind, id, value, references, data),
  );
}

function parseEnvelopeBody(
  body,
  marker,
  kind,
  referenceKeys,
  dataKeys,
  fromEnvelope,
  formatter,
) {
  if (
    typeof body !== "string" ||
    body.includes("\r") ||
    new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES
  ) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  const prefix = `${marker}\n\n\`\`\`json\n`;
  const suffix = "\n```\n";
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  let envelope;
  try {
    envelope = JSON.parse(body.slice(prefix.length, -suffix.length));
  } catch {
    throw new WorkGraphDefinitionError(`${marker} body is invalid JSON`);
  }
  exactKeys(envelope, ENVELOPE_KEYS, `${kind} envelope`);
  if (envelope.apiVersion !== WORKGRAPH_API_VERSION || envelope.kind !== kind) {
    throw new WorkGraphDefinitionError(
      `${kind} envelope apiVersion or kind is invalid`,
    );
  }
  directId(envelope.id, `${kind} envelope id`);
  workflowRunIdentifier(envelope.rootIssueId, `${kind} envelope rootIssueId`);
  validateWorkGraphProtocolId(
    envelope.workflowRunId,
    "workflow-run",
    `${kind} envelope workflowRunId`,
  );
  validateWorkGraphTaskId(envelope.taskId, `${kind} envelope taskId`);
  envelope.workflowContext = normalizeTaskContext(
    envelope.workflowContext,
    `${kind} workflowContext`,
  );
  exactKeys(envelope.references, referenceKeys, `${kind} references`);
  exactKeys(envelope.data, dataKeys, `${kind} data`);
  const value = fromEnvelope(envelope);
  if (formatter(value) !== body) {
    throw new WorkGraphDefinitionError(`${marker} body is not canonical`);
  }
  return value;
}

export function normalizeRuntimeTask(task) {
  exactKeys(task, RUNTIME_TASK_KEYS, "runtime task");
  validateWorkGraphTaskId(task.taskId, "runtime task taskId");
  workflowRunIdentifier(task.rootIssueId, "runtime task rootIssueId");
  validateWorkGraphProtocolId(
    task.workflowRunId,
    "workflow-run",
    "runtime task workflowRunId",
  );
  identifier(
    task.workflowDefinitionId,
    "runtime task workflowDefinitionId",
  );
  identifier(
    task.workflowDefinitionVersion,
    "runtime task workflowDefinitionVersion",
  );
  digest(
    task.workflowDefinitionDigest,
    "runtime task workflowDefinitionDigest",
  );
  validateWorkGraphProtocolId(
    task.taskDefinitionId,
    "task-definition",
    "runtime task taskDefinitionId",
  );
  identifier(task.taskKey, "runtime task taskKey");
  identifier(task.operation, "runtime task operation");
  return {
    taskId: task.taskId,
    rootIssueId: task.rootIssueId,
    workflowRunId: task.workflowRunId,
    workflowDefinitionId: task.workflowDefinitionId,
    workflowDefinitionVersion: task.workflowDefinitionVersion,
    workflowDefinitionDigest: task.workflowDefinitionDigest,
    taskDefinitionId: task.taskDefinitionId,
    taskKey: task.taskKey,
    operation: task.operation,
    resolvedInputs: dataMap(task.resolvedInputs, "runtime task resolvedInputs"),
  };
}

export function formatRuntimeTask(task) {
  const normalized = normalizeRuntimeTask(task);
  return formatEnvelope(
    RUNTIME_TASK_MARKER,
    "Task",
    normalized.taskId,
    normalized,
    {},
    { resolvedInputs: normalized.resolvedInputs },
  );
}

export function parseRuntimeTask(body) {
  return parseEnvelopeBody(
    body,
    RUNTIME_TASK_MARKER,
    "Task",
    EMPTY_KEYS,
    ["resolvedInputs"],
    (envelope) => {
      if (envelope.id !== envelope.taskId) {
        throw new WorkGraphDefinitionError("Task message id must equal taskId");
      }
      return {
        taskId: envelope.taskId,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        ...envelope.workflowContext,
        resolvedInputs: envelope.data.resolvedInputs,
      };
    },
    formatRuntimeTask,
  );
}

export function validateRootRuntimeTask(definition, task) {
  const normalizedDefinition =
    "steps" in definition
      ? normalizeCompiledWorkflowDefinition(definition)
      : normalizeWorkflowDefinition(definition);
  const normalizedTask = normalizeRuntimeTask(task);
  const expected = {
    workflowDefinitionId: normalizedDefinition.workflowDefinitionId,
    workflowDefinitionVersion: normalizedDefinition.version,
    workflowDefinitionDigest: normalizedDefinition.digest,
    taskDefinitionId: normalizedDefinition.root.taskDefinitionId,
    taskKey: normalizedDefinition.root.taskKey,
    operation: normalizedDefinition.root.operation,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (normalizedTask[field] !== value) {
      throw new WorkGraphDefinitionError(
        `runtime task ${field} must match the pinned root definition`,
      );
    }
  }
  return normalizedTask;
}

const WORKFLOW_KEYS = ["apiVersion", "kind", "metadata", "spec"];
const WORKFLOW_METADATA_KEYS = ["id"];
const WORKFLOW_SPEC_KEYS = ["trigger", "initial", "defaults", "steps"];
const WORKFLOW_DEFAULT_KEYS = [
  "evaluator",
  "orchestrator",
  "maxReworkAttempts",
];
const TASK_STEP_KEYS = [
  "type",
  "operation",
  "worker",
  "inputs",
  "next",
  "evaluator",
  "orchestrator",
  "maxReworkAttempts",
  "outcomes",
  "children",
  "flowEntries",
];
const CHILD_TASK_KEYS = [
  "operation",
  "worker",
  "inputs",
  "evaluator",
  "orchestrator",
  "maxReworkAttempts",
  "children",
  "flowEntries",
];
const CHILDREN_KEYS = ["join", "tasks"];
const WAIT_STEP_KEYS = ["type", "event", "next"];
const TERMINAL_STEP_KEYS = ["type", "outcome"];
const COMPILED_DEFINITION_KEYS = [
  "workflowDefinitionId",
  "version",
  "digest",
  "trigger",
  "defaults",
  "initialStepId",
  "root",
  "steps",
];
const ASSIGNMENT_KEYS = [
  "assignmentId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "joinId",
  "permittedExecutors",
];
const FORK_KEYS = [
  "forkId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "children",
];
const FORK_CHILD_KEYS = ["taskDefinitionId", "taskId"];
const JOIN_KEYS = [
  "joinId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "forkId",
  "strategy",
  "children",
];
const JOIN_CHILD_KEYS = [
  "taskDefinitionId",
  "taskId",
  "resultId",
  "evaluationId",
];
const DISPATCH_KEYS = [
  "dispatchId",
  "launchId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "lease",
];
const RESULT_KEYS = [
  "resultId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "dispatchId",
  "leaseId",
  "attempt",
  "outcome",
  "output",
];
const EVALUATION_KEYS = [
  "evaluationId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "resultId",
  "resultDigest",
  "evaluatorId",
  "attempt",
  "verdict",
  "summary",
  "feedback",
];
const ROUTE_BASE_KEYS = [
  "routeId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "resultId",
  "evaluationId",
  "evaluationVerdict",
  "orchestratorId",
  "action",
  "attempt",
];
const ROUTE_ADVANCE_KEYS = [
  ...ROUTE_BASE_KEYS,
  "transitionKind",
  "targetStepId",
  "targetStepKind",
  "outcome",
  "targetTaskDefinitionId",
];
const ERROR_KEYS = [
  "errorId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "task",
  "references",
  "stage",
  "code",
  "category",
  "summary",
  "retryable",
  "attempt",
  "details",
];
const ERROR_REFERENCE_KEYS = [
  "forkId",
  "joinId",
  "assignmentId",
  "dispatchId",
  "leaseId",
  "resultId",
  "evaluationId",
  "routeId",
];
const ERROR_REFERENCE_ROLES = [
  "fork",
  "join",
  "assignment",
  "dispatch",
  "lease",
  "result",
  "evaluation",
  "route",
];

function exactAllowedKeys(value, required, allowed, context) {
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must be an object`);
  }
  const keys = Object.keys(value);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new WorkGraphDefinitionError(
      `${context} has invalid properties (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

function stepId(value, context) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value) ||
    value.endsWith("-")
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must be a lowercase step ID`,
    );
  }
}

function boundedCount(value, context) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 16) {
    throw new WorkGraphDefinitionError(
      `${context} must be a safe integer from 0 through 16`,
    );
  }
}

function executionAttempt(value, context) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 17) {
    throw new WorkGraphDefinitionError(
      `${context} must be a safe integer from 1 through 17`,
    );
  }
}

function nonEmptyText(value, context) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !lifecycleText(value)
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must be non-empty ordinary text`,
    );
  }
}

function lifecycleText(value) {
  return (
    typeof value === "string" &&
    wellFormedUnicode(value) &&
    !value.includes("\r") &&
    !value.includes("```")
  );
}

function directId(value, context) {
  workflowRunIdentifier(value, context);
}

function formatArtifact(marker, value) {
  const body = `${marker}\n\n\`\`\`json\n${prettyJson(value)}\n\`\`\`\n`;
  if (new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES) {
    throw new WorkGraphDefinitionError(
      `${marker} body exceeds ${MAX_WORKGRAPH_BODY_BYTES} bytes`,
    );
  }
  return body;
}

function normalizeAuthoredFlowEntries(value, childCount, label, context) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkGraphDefinitionError(`${context}.flowEntries must be an array`);
  }
  if (childCount + value.length > MAX_TASK_DEFINITION_CHILDREN) {
    throw new WorkGraphDefinitionError(
      `${label} children and flowEntries must total at most ${MAX_TASK_DEFINITION_CHILDREN} tasks`,
    );
  }
  for (const [index, entry] of value.entries()) {
    identifier(entry, `${label} flowEntries entry`);
    if (index > 0 && value[index - 1] >= entry) {
      throw new WorkGraphDefinitionError(
        `${label} flowEntries must be ordered by unique step id`,
      );
    }
  }
  return [...value];
}

function normalizeChildren(value, workflowDefaults, context, depth, label) {
  if (depth > MAX_TASK_DEFINITION_DEPTH) {
    throw new WorkGraphDefinitionError(
      `recursive children exceed maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    );
  }
  exactKeys(value, CHILDREN_KEYS, context);
  if (value.join !== "all") {
    throw new WorkGraphDefinitionError(`${context}.join must be all`);
  }
  if (!object(value.tasks) || Object.keys(value.tasks).length === 0) {
    throw new WorkGraphDefinitionError(`${context}.tasks must be a non-empty map`);
  }
  if (Object.keys(value.tasks).length > MAX_TASK_DEFINITION_CHILDREN) {
    throw new WorkGraphDefinitionError(
      `${context}.tasks exceeds ${MAX_TASK_DEFINITION_CHILDREN} children`,
    );
  }
  const tasks = {};
  for (const [id, task] of Object.entries(value.tasks)) {
    stepId(id, `${context}.tasks key`);
    tasks[id] = normalizeChildTask(
      task,
      workflowDefaults,
      `${context}.tasks.${id}`,
      depth,
      `${label} child task '${id}'`,
    );
  }
  return { join: value.join, tasks };
}

function normalizeChildTask(value, workflowDefaults, context, depth, label) {
  exactAllowedKeys(
    value,
    ["operation", "worker"],
    CHILD_TASK_KEYS,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  const children =
    "children" in value
      ? normalizeChildren(
          value.children,
          workflowDefaults,
          `${context}.children`,
          depth + 1,
          label,
        )
      : null;
  const flowEntries = normalizeAuthoredFlowEntries(
    value.flowEntries,
    children ? Object.keys(children.tasks).length : 0,
    label,
    context,
  );
  const normalized = {
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs ?? {}, `${context}.inputs`),
    evaluator: null,
    orchestrator: null,
    maxReworkAttempts: null,
    children,
    ...(flowEntries.length > 0 ? { flowEntries } : {}),
  };
  for (const role of ["evaluator", "orchestrator"]) {
    if (role in value) {
      identifier(value[role], `${context}.${role}`);
      normalized[role] = value[role];
    }
  }
  if ("maxReworkAttempts" in value) {
    boundedCount(value.maxReworkAttempts, `${context}.maxReworkAttempts`);
    normalized.maxReworkAttempts = value.maxReworkAttempts;
  }
  return normalized;
}

function normalizeWorkflowStep(id, value, stepIds) {
  stepId(id, `workflow step '${id}'`);
  const context = `workflow step '${id}'`;
  if (!object(value)) {
    throw new WorkGraphDefinitionError(`${context} must be an object`);
  }
  if (value.type === "wait") {
    exactKeys(value, WAIT_STEP_KEYS, context);
    if (value.event !== "root-issue-commented") {
      throw new WorkGraphDefinitionError(
        `${context}.event must be root-issue-commented`,
      );
    }
    stepId(value.next, `${context}.next`);
    stepIds.references.push([value.next, `${context}.next`]);
    return { type: value.type, event: value.event, next: value.next };
  }
  if (value.type === "terminal") {
    exactKeys(value, TERMINAL_STEP_KEYS, context);
    if (!["completed", "error", "ignored"].includes(value.outcome)) {
      throw new WorkGraphDefinitionError(
        `${context}.outcome must be completed, error, or ignored`,
      );
    }
    return { type: value.type, outcome: value.outcome };
  }
  if (value.type !== "task") {
    throw new WorkGraphDefinitionError(
      `${context}.type must be task, wait, or terminal`,
    );
  }
  exactAllowedKeys(
    value,
    ["type", "operation", "worker"],
    TASK_STEP_KEYS,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  const label = `step '${id}'`;
  const children =
    "children" in value
      ? normalizeChildren(
          value.children,
          stepIds.defaults,
          `${context}.children`,
          1,
          label,
        )
      : null;
  const flowEntries = normalizeAuthoredFlowEntries(
    value.flowEntries,
    children ? Object.keys(children.tasks).length : 0,
    label,
    context,
  );
  const normalized = {
    type: value.type,
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs ?? {}, `${context}.inputs`),
    evaluator: null,
    orchestrator: null,
    maxReworkAttempts: null,
    children,
    ...(flowEntries.length > 0 ? { flowEntries } : {}),
    next: null,
    outcomes: {},
  };
  if (!("next" in value) && !("outcomes" in value)) {
    throw new WorkGraphDefinitionError(
      `${context} requires exactly one of next or outcomes`,
    );
  }
  if ("next" in value && "outcomes" in value) {
    throw new WorkGraphDefinitionError(
      `${context} requires exactly one of next or outcomes`,
    );
  }
  if ("next" in value) {
    stepId(value.next, `${context}.next`);
    stepIds.references.push([value.next, `${context}.next`]);
    normalized.next = value.next;
  }

  for (const role of ["evaluator", "orchestrator"]) {
    if (role in value) {
      identifier(value[role], `${context}.${role}`);
      normalized[role] = value[role];
    }
  }
  if ("maxReworkAttempts" in value) {
    boundedCount(value.maxReworkAttempts, `${context}.maxReworkAttempts`);
    normalized.maxReworkAttempts = value.maxReworkAttempts;
  }

  if ("outcomes" in value) {
    if (!object(value.outcomes) || Object.keys(value.outcomes).length === 0) {
      throw new WorkGraphDefinitionError(
        `${context}.outcomes must be a non-empty map`,
      );
    }
    normalized.outcomes = {};
    for (const [outcome, target] of Object.entries(value.outcomes)) {
      identifier(outcome, `${context}.outcomes key`);
      stepId(target, `${context}.outcomes.${outcome}`);
      stepIds.references.push([target, `${context}.outcomes.${outcome}`]);
      normalized.outcomes[outcome] = target;
    }
  }

  return normalized;
}

// Nesting levels an authored task tree adds beneath its own step: 0 for a task
// that declares no children.
function authoredTreeDepth(task) {
  const children = Object.values(task.children?.tasks ?? {});
  return children.length === 0
    ? 0
    : 1 + Math.max(...children.map(authoredTreeDepth));
}

// Every authored task that declares `flowEntries`: the step task itself plus
// each nested child, keyed by the step whose fork realizes them.
function authoredFlowOwners(steps) {  const owners = new Map();
  for (const [id, step] of Object.entries(steps)) {
    if (step.type !== "task") continue;
    const declarations = [];
    const visit = (task, label, depth) => {
      if (task.flowEntries?.length) {
        declarations.push({ label, depth, entries: task.flowEntries });
      }
      for (const [key, child] of Object.entries(task.children?.tasks ?? {})) {
        visit(child, `${label} child task '${key}'`, depth + 1);
      }
    };
    visit(step, `step '${id}'`, 0);
    if (declarations.length > 0) owners.set(id, declarations);
  }
  return owners;
}

function workflowTargets(step) {
  if (step.next) return [step.next];
  if (step.outcomes) return Object.values(step.outcomes);
  return [];
}

function reachableFrom(edges, start) {
  const reachable = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const target of edges.get(id) ?? []) pending.push(target);
  }
  return reachable;
}

// Validates every declared flow entry against the step graph it launches
// into. Mirrors the canonical Rust `collect_owners` checks.
function validateFlowOwners(steps, owners) {
  for (const [stepId, declarations] of owners) {
    for (const { label, entries } of declarations) {
      for (const entry of entries) {
        if (entry === stepId) {
          throw new WorkGraphDefinitionError(
            `${label} flow entry '${entry}' must not reference its own step`,
          );
        }
        if (!(entry in steps)) {
          throw new WorkGraphDefinitionError(
            `${label} flow entry '${entry}' is not a declared step`,
          );
        }
        if (steps[entry].type !== "task") {
          throw new WorkGraphDefinitionError(
            `${label} flow entry '${entry}' must reference a task step`,
          );
        }
      }
    }
  }
}

// Resolves the disjoint routed scopes a workflow declares. The trunk is the
// transition closure of `initial`; every entry contributes the transition
// closure of its own step, which may not overlap the trunk or another scope.
function resolveFlowTopology(initial, steps, owners) {
  validateFlowOwners(steps, owners);
  const transitionEdges = new Map(
    Object.entries(steps).map(([id, step]) => [id, workflowTargets(step)]),
  );
  const controlEdges = new Map(
    [...transitionEdges].map(([id, targets]) => [id, [...targets]]),
  );
  for (const [stepId, declarations] of owners) {
    const targets = controlEdges.get(stepId);
    for (const { entries } of declarations) {
      for (const entry of entries) {
        if (!targets.includes(entry)) targets.push(entry);
      }
    }
  }

  const trunk = reachableFrom(transitionEdges, initial);
  const forkDepths = new Map([...trunk].map((id) => [id, 0]));
  const scopes = new Map();
  const scopeByStep = new Map();
  const pending = [...trunk].sort();
  while (pending.length > 0) {
    const stepId = pending.shift();
    const declarations = owners.get(stepId);
    if (!declarations) continue;
    const ownerForkDepth = forkDepths.get(stepId) ?? 0;
    for (const { label, depth, entries, taskDefinitionId } of declarations) {
      for (const entry of entries) {
        const members = [...reachableFrom(transitionEdges, entry)].sort();
        for (const member of members) {
          if (trunk.has(member)) {
            throw new WorkGraphDefinitionError(
              `flow entry '${entry}' claims step '${member}', which is already reachable from the workflow trunk`,
            );
          }
          const owningEntry = scopeByStep.get(member);
          if (owningEntry !== undefined) {
            throw new WorkGraphDefinitionError(
              `flow entry '${entry}' claims step '${member}', which is already owned by flow entry '${owningEntry}'`,
            );
          }
        }
        if (!members.some((member) => steps[member].type === "terminal")) {
          throw new WorkGraphDefinitionError(
            `flow entry '${entry}' must reach at least one terminal step`,
          );
        }
        const forkDepth = ownerForkDepth + depth + 1;
        for (const member of members) {
          scopeByStep.set(member, entry);
          forkDepths.set(member, forkDepth);
          pending.push(member);
        }
        scopes.set(entry, {
          ownerStepId: stepId,
          ownerLabel: label,
          ownerTaskDefinitionId: taskDefinitionId ?? null,
          entryStepId: entry,
          stepIds: new Set(members),
          forkDepth,
        });
      }
    }
  }
  return { controlEdges, trunk, scopes, scopeByStep, forkDepths };
}

// Rejects a definition that authors any input the runtime reserves for the
// tasks it generates. A step that some transition targets is realized as a
// routed successor and receives `workgraphPredecessorTaskId`; every task of a
// routed scope, including the nested children that inherit the scope, receives
// the three reserved scope strings.
function validateReservedRuntimeInputs(graphSteps, topology, view) {
  const successors = new Set();
  for (const step of Object.values(graphSteps)) {
    for (const target of workflowTargets(step)) successors.add(target);
  }
  const reject = (task, keys) => {
    const inputs = view.inputs(task);
    for (const key of keys) {
      if (object(inputs) && key in inputs) {
        const kind =
          key === RESERVED_SUCCESSOR_INPUT_KEY ? "successor" : "scope";
        throw new WorkGraphDefinitionError(
          `${view.label(task)} uses reserved routed ${kind} input '${key}'`,
        );
      }
    }
  };
  for (const [stepId, step] of Object.entries(graphSteps)) {
    if (step.type !== "task") continue;
    if (successors.has(stepId)) {
      reject(view.root(stepId), [RESERVED_SUCCESSOR_INPUT_KEY]);
    }
    if (!topology.scopeByStep.has(stepId)) continue;
    // Every task of a routed scope carries runtime scope metadata, and the
    // entry root must stay free of a routed predecessor, so a scoped task may
    // not author any reserved key.
    for (const task of view.tree(stepId)) {
      reject(task, RESERVED_RUNTIME_INPUT_KEYS);
    }
  }
}

function validateWorkflowGraph(initial, steps, owners = new Map()) {
  const topology = resolveFlowTopology(initial, steps, owners);

  if (![...topology.trunk].some((id) => steps[id].type === "terminal")) {
    throw new WorkGraphDefinitionError(
      "issue workflow must reach at least one terminal",
    );
  }
  const complete = new Set();
  const stack = [];
  const active = new Map();
  const detectCycle = (id) => {
    if (complete.has(id)) return;
    if (active.has(id)) {
      const cycle = stack.slice(active.get(id));
      if (!cycle.some((step) => steps[step].type === "wait")) {
        throw new WorkGraphDefinitionError(
          `issue workflow has a cycle without a wait: ${cycle.join(" -> ")}`,
        );
      }
      return;
    }
    active.set(id, stack.length);
    stack.push(id);
    for (const target of topology.controlEdges.get(id) ?? []) detectCycle(target);
    stack.pop();
    active.delete(id);
    complete.add(id);
  };
  detectCycle(initial);
  for (const entry of topology.scopes.keys()) detectCycle(entry);
  const unreachable = Object.keys(steps).filter(
    (id) => !topology.forkDepths.has(id),
  );
  if (unreachable.length > 0) {
    throw new WorkGraphDefinitionError(
      `issue workflow has unreachable steps: ${unreachable.join(", ")}`,
    );
  }
  return topology;
}

export function normalizeIssueWorkflow(workflow) {
  exactKeys(workflow, WORKFLOW_KEYS, "issue workflow");
  if (workflow.apiVersion !== WORKFLOW_AUTHORING_API_VERSION) {
    throw new WorkGraphDefinitionError(
      `issue workflow apiVersion must be ${WORKFLOW_AUTHORING_API_VERSION}`,
    );
  }
  if (workflow.kind !== "IssueWorkflow") {
    throw new WorkGraphDefinitionError("issue workflow kind must be IssueWorkflow");
  }
  exactKeys(workflow.metadata, WORKFLOW_METADATA_KEYS, "issue workflow metadata");
  identifier(workflow.metadata.id, "issue workflow metadata.id");
  exactKeys(workflow.spec, WORKFLOW_SPEC_KEYS, "issue workflow spec");
  if (workflow.spec.trigger !== "workgraph") {
    throw new WorkGraphDefinitionError(
      "issue workflow spec.trigger must be workgraph",
    );
  }
  exactKeys(workflow.spec.defaults, WORKFLOW_DEFAULT_KEYS, "workflow defaults");
  identifier(workflow.spec.defaults.evaluator, "workflow defaults.evaluator");
  identifier(
    workflow.spec.defaults.orchestrator,
    "workflow defaults.orchestrator",
  );
  boundedCount(
    workflow.spec.defaults.maxReworkAttempts,
    "workflow defaults.maxReworkAttempts",
  );
  if (!object(workflow.spec.steps) || Object.keys(workflow.spec.steps).length === 0) {
    throw new WorkGraphDefinitionError("issue workflow steps must be a non-empty map");
  }

  const entries = Object.entries(workflow.spec.steps);
  const ids = new Set(entries.map(([id]) => id));
  if (!ids.has(workflow.spec.initial)) {
    throw new WorkGraphDefinitionError(
      "issue workflow initial must reference a declared step",
    );
  }
  const tracking = {
    ids: new Set(ids),
    references: [],
    defaults: workflow.spec.defaults,
  };
  const normalizedSteps = Object.fromEntries(
    entries.map(([id, step]) => [
      id,
      normalizeWorkflowStep(id, step, tracking),
    ]),
  );
  if (normalizedSteps[workflow.spec.initial].type !== "task") {
    throw new WorkGraphDefinitionError(
      "issue workflow initial step must be a task",
    );
  }
  for (const [target, context] of tracking.references) {
    if (!tracking.ids.has(target)) {
      throw new WorkGraphDefinitionError(
        `${context} must reference a declared workflow step`,
      );
    }
  }
  const topology = validateWorkflowGraph(
    workflow.spec.initial,
    normalizedSteps,
    authoredFlowOwners(normalizedSteps),
  );
  // A routed scope forks its tasks beneath the container that launched it, so
  // an authored child tree is bounded by the scope's physical fork depth
  // exactly as the compiled definition is.
  for (const [id, step] of Object.entries(normalizedSteps)) {
    if (step.type !== "task") continue;
    const forkDepth = topology.forkDepths.get(id) ?? 0;
    if (forkDepth + authoredTreeDepth(step) > MAX_TASK_DEFINITION_DEPTH) {
      throw new WorkGraphDefinitionError(
        `step '${id}' recursive children exceed maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
      );
    }
  }
  validateReservedRuntimeInputs(normalizedSteps, topology, {
    root: (stepId) => ({ stepId, task: normalizedSteps[stepId] }),
    inputs: ({ task }) => task.inputs,
    label: ({ label, stepId }) => label ?? `step '${stepId}'`,
    tree: (stepId) => {
      const tasks = [];
      const descend = (task, label) => {
        tasks.push({ task, label });
        for (const [key, child] of Object.entries(task.children?.tasks ?? {})) {
          descend(child, `${label} child task '${key}'`);
        }
      };
      descend(normalizedSteps[stepId], `step '${stepId}'`);
      return tasks;
    },
  });
  return {
    apiVersion: workflow.apiVersion,
    kind: workflow.kind,
    metadata: { id: workflow.metadata.id },
    spec: {
      trigger: workflow.spec.trigger,
      initial: workflow.spec.initial,
      defaults: {
        evaluator: workflow.spec.defaults.evaluator,
        orchestrator: workflow.spec.defaults.orchestrator,
        maxReworkAttempts: workflow.spec.defaults.maxReworkAttempts,
      },
      steps: normalizedSteps,
    },
  };
}

function normalizeCompiledTaskDefinition(value, context, depth = 0) {
  taskDefinitionKeys(value, context);
  if (depth > MAX_TASK_DEFINITION_DEPTH) {
    throw new WorkGraphDefinitionError(
      `compiled task nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    );
  }
  validateWorkGraphProtocolId(
    value.taskDefinitionId,
    "task-definition",
    `${context}.taskDefinitionId`,
  );
  identifier(value.taskKey, `${context}.taskKey`);
  identifier(value.operation, `${context}.operation`);
  exactKeys(value.routing, ROUTING_KEYS, `${context}.routing`);
  if (
    !Array.isArray(value.routing.permittedExecutors) ||
    value.routing.permittedExecutors.length < 1 ||
    value.routing.permittedExecutors.length > MAX_TASK_DEFINITION_EXECUTORS
  ) {
    throw new WorkGraphDefinitionError(
      `${context}.routing.permittedExecutors must contain 1-${MAX_TASK_DEFINITION_EXECUTORS} entries`,
    );
  }
  for (const executor of value.routing.permittedExecutors) {
    identifier(executor, `${context}.routing.permittedExecutors`);
  }
  if (
    !Array.isArray(value.children) ||
    value.children.length > MAX_TASK_DEFINITION_CHILDREN
  ) {
    throw new WorkGraphDefinitionError(
      `${context}.children must contain 0-${MAX_TASK_DEFINITION_CHILDREN} entries`,
    );
  }
  const flowEntries = normalizeFlowEntries(
    value.flowEntries,
    value.children.length,
    value.taskDefinitionId,
    context,
  );
  return {
    taskDefinitionId: value.taskDefinitionId,
    taskKey: value.taskKey,
    operation: value.operation,
    routing: { permittedExecutors: [...value.routing.permittedExecutors] },
    staticInputs: dataMap(value.staticInputs, `${context}.staticInputs`),
    children: value.children.map((child, index) =>
      normalizeCompiledTaskDefinition(
        child,
        `${context}.children[${index}]`,
        depth + 1,
      ),
    ),
    ...(flowEntries.length > 0 ? { flowEntries } : {}),
  };
}

function normalizeExecutionPolicies(value, context) {
  if (!object(value) || Object.keys(value).length < 1) {
    throw new WorkGraphDefinitionError(`${context} must be a non-empty map`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([taskDefinitionId, policy]) => {
      validateWorkGraphProtocolId(
        taskDefinitionId,
        "task-definition",
        `${context} key`,
      );
      exactKeys(
        policy,
        ["workerId", "evaluatorId", "orchestratorId", "maxReworkAttempts"],
        `${context}.${taskDefinitionId}`,
      );
      for (const role of ["workerId", "evaluatorId", "orchestratorId"]) {
        identifier(policy[role], `${context}.${taskDefinitionId}.${role}`);
      }
      boundedCount(
        policy.maxReworkAttempts,
        `${context}.${taskDefinitionId}.maxReworkAttempts`,
      );
      return [
        taskDefinitionId,
        {
          workerId: policy.workerId,
          evaluatorId: policy.evaluatorId,
          orchestratorId: policy.orchestratorId,
          maxReworkAttempts: policy.maxReworkAttempts,
        },
      ];
    }),
  );
}

function collectCompiledTasks(task, tasks = new Map()) {
  if (tasks.has(task.taskDefinitionId)) {
    throw new WorkGraphDefinitionError(
      `compiled definition repeats taskDefinitionId '${task.taskDefinitionId}'`,
    );
  }
  tasks.set(task.taskDefinitionId, task);
  for (const child of task.children) collectCompiledTasks(child, tasks);
  return tasks;
}

function taskTreeDepth(task) {
  return task.children.length === 0
    ? 0
    : 1 + Math.max(...task.children.map(taskTreeDepth));
}

// Every compiled task definition that declares `flowEntries`, keyed by the
// step whose fork realizes it. Nested children own scopes at their own tree
// depth, so a scope's physical fork depth counts its owner's nesting too.
function compiledFlowOwners(steps) {
  const owners = new Map();
  for (const [id, step] of Object.entries(steps)) {
    if (step.type !== "task") continue;
    const declarations = [];
    const visit = (task, depth) => {
      if (task.flowEntries?.length) {
        declarations.push({
          label: `compiled task definition '${task.taskDefinitionId}'`,
          taskDefinitionId: task.taskDefinitionId,
          depth,
          entries: task.flowEntries,
        });
      }
      for (const child of task.children) visit(child, depth + 1);
    };
    visit(step.taskDefinition, 0);
    if (declarations.length > 0) owners.set(id, declarations);
  }
  return owners;
}

function validateCompiledPolicies(taskDefinition, policies, context) {
  const tasks = collectCompiledTasks(taskDefinition);
  const taskIds = [...tasks.keys()].sort();
  const policyIds = Object.keys(policies).sort();
  if (!isDeepStrictEqual(taskIds, policyIds)) {
    throw new WorkGraphDefinitionError(
      `${context} keys must exactly match all recursive taskDefinitionIds`,
    );
  }
  for (const [taskDefinitionId, task] of tasks) {
    const policy = policies[taskDefinitionId];
    if (
      !isDeepStrictEqual(task.routing.permittedExecutors, [policy.workerId])
    ) {
      throw new WorkGraphDefinitionError(
        `${context}.${taskDefinitionId}.workerId must match the task routing executor`,
      );
    }
  }
}

function normalizeCompiledTransition(value, context, steps) {
  if (value.type === "next") {
    exactKeys(value, ["type", "targetStepId"], context);
    stepId(value.targetStepId, `${context}.targetStepId`);
    if (!(value.targetStepId in steps)) {
      throw new WorkGraphDefinitionError(
        `${context}.targetStepId must reference a compiled step`,
      );
    }
    return { type: "next", targetStepId: value.targetStepId };
  }
  if (value.type === "outcomes") {
    exactKeys(value, ["type", "targets"], context);
    if (!object(value.targets) || Object.keys(value.targets).length < 1) {
      throw new WorkGraphDefinitionError(`${context}.targets must be non-empty`);
    }
    return {
      type: "outcomes",
      targets: Object.fromEntries(
        Object.entries(value.targets).map(([outcome, target]) => {
          identifier(outcome, `${context}.targets key`);
          stepId(target, `${context}.targets.${outcome}`);
          if (!(target in steps)) {
            throw new WorkGraphDefinitionError(
              `${context}.targets.${outcome} must reference a compiled step`,
            );
          }
          return [outcome, target];
        }),
      ),
    };
  }
  throw new WorkGraphDefinitionError(
    `${context}.type must be next or outcomes`,
  );
}

// The routed scopes a compiled definition declares, resolved once so callers
// can ask which scope owns a step and which entries an owner launches.
export function resolveCompiledFlowScopes(definition) {
  const graphSteps = Object.fromEntries(
    Object.entries(definition.steps).map(([id, step]) => {
      if (step.type === "terminal") return [id, { type: "terminal" }];
      if (step.type === "wait") {
        return [id, { type: "wait", next: step.nextStepId }];
      }
      return [
        id,
        step.transition.type === "next"
          ? { type: "task", next: step.transition.targetStepId }
          : { type: "task", outcomes: step.transition.targets },
      ];
    }),
  );
  const topology = resolveFlowTopology(
    definition.initialStepId,
    graphSteps,
    compiledFlowOwners(definition.steps),
  );
  const entriesByOwner = new Map();
  for (const scope of topology.scopes.values()) {
    const list = entriesByOwner.get(scope.ownerTaskDefinitionId) ?? [];
    list.push(scope.entryStepId);
    entriesByOwner.set(scope.ownerTaskDefinitionId, list);
  }
  return {
    scopes: topology.scopes,
    scopeByStep: topology.scopeByStep,
    trunk: topology.trunk,
    entriesByOwner,
    scopeForStep: (stepId) =>
      topology.scopes.get(topology.scopeByStep.get(stepId)) ?? null,
  };
}

export function normalizeCompiledWorkflowDefinition(definition) {
  exactKeys(definition, COMPILED_DEFINITION_KEYS, "compiled workflow definition");
  identifier(
    definition.workflowDefinitionId,
    "compiled workflow workflowDefinitionId",
  );
  if (definition.version !== "v1" || definition.trigger !== "workgraph") {
    throw new WorkGraphDefinitionError(
      "compiled workflow must use version v1 and trigger workgraph",
    );
  }
  digest(definition.digest, "compiled workflow digest");
  exactKeys(definition.defaults, WORKFLOW_DEFAULT_KEYS, "compiled defaults");
  identifier(definition.defaults.evaluator, "compiled defaults.evaluator");
  identifier(definition.defaults.orchestrator, "compiled defaults.orchestrator");
  boundedCount(
    definition.defaults.maxReworkAttempts,
    "compiled defaults.maxReworkAttempts",
  );
  if (!object(definition.steps) || !(definition.initialStepId in definition.steps)) {
    throw new WorkGraphDefinitionError(
      "compiled workflow initialStepId must reference its steps map",
    );
  }
  const steps = {};
  for (const [id, step] of Object.entries(definition.steps)) {
    stepId(id, "compiled step key");
    if (step.type === "task") {
      exactKeys(
        step,
        ["type", "taskDefinition", "executionPolicies", "transition"],
        `compiled step '${id}'`,
      );
      steps[id] = {
        type: "task",
        taskDefinition: normalizeCompiledTaskDefinition(
          step.taskDefinition,
          `compiled step '${id}'.taskDefinition`,
        ),
        executionPolicies: normalizeExecutionPolicies(
          step.executionPolicies,
          `compiled step '${id}'.executionPolicies`,
        ),
        transition: step.transition,
      };
      validateCompiledPolicies(
        steps[id].taskDefinition,
        steps[id].executionPolicies,
        `compiled step '${id}'.executionPolicies`,
      );
    } else if (step.type === "wait") {
      exactKeys(step, ["type", "event", "nextStepId"], `compiled step '${id}'`);
      if (step.event !== "root-issue-commented") {
        throw new WorkGraphDefinitionError(
          `compiled step '${id}'.event must be root-issue-commented`,
        );
      }
      steps[id] = {
        type: "wait",
        event: step.event,
        nextStepId: step.nextStepId,
      };
    } else if (step.type === "terminal") {
      exactKeys(step, ["type", "outcome"], `compiled step '${id}'`);
      if (!["completed", "error", "ignored"].includes(step.outcome)) {
        throw new WorkGraphDefinitionError(
          `compiled step '${id}' has an invalid terminal outcome`,
        );
      }
      steps[id] = { type: "terminal", outcome: step.outcome };
    } else {
      throw new WorkGraphDefinitionError(
        `compiled step '${id}'.type must be task, wait, or terminal`,
      );
    }
  }
  for (const [id, step] of Object.entries(steps)) {
    if (step.type === "task") {
      step.transition = normalizeCompiledTransition(
        step.transition,
        `compiled step '${id}'.transition`,
        steps,
      );
      if (!(step.taskDefinition.taskDefinitionId in step.executionPolicies)) {
        throw new WorkGraphDefinitionError(
          `compiled step '${id}' lacks its root execution policy`,
        );
      }
    } else if (step.type === "wait") {
      stepId(step.nextStepId, `compiled step '${id}'.nextStepId`);
      if (!(step.nextStepId in steps)) {
        throw new WorkGraphDefinitionError(
          `compiled step '${id}'.nextStepId must reference a compiled step`,
        );
      }
    }
  }
  const root = normalizeCompiledTaskDefinition(
    definition.root,
    "compiled workflow root",
  );
  const initial = steps[definition.initialStepId];
  if (
    initial.type !== "task" ||
    !isDeepStrictEqual(root, initial.taskDefinition)
  ) {
    throw new WorkGraphDefinitionError(
      "compiled workflow root must equal its initial task definition",
    );
  }
  const graphSteps = Object.fromEntries(
    Object.entries(steps).map(([id, step]) => {
      if (step.type === "terminal") return [id, step];
      if (step.type === "wait") {
        return [id, { type: "wait", next: step.nextStepId }];
      }
      return [
        id,
        step.transition.type === "next"
          ? { type: "task", next: step.transition.targetStepId }
          : { type: "task", outcomes: step.transition.targets },
      ];
    }),
  );
  const topology = validateWorkflowGraph(
    definition.initialStepId,
    graphSteps,
    compiledFlowOwners(steps),
  );
  for (const [id, step] of Object.entries(steps)) {
    if (step.type !== "task") continue;
    const forkDepth = topology.forkDepths.get(id) ?? 0;
    if (
      forkDepth + taskTreeDepth(step.taskDefinition) >
      MAX_TASK_DEFINITION_DEPTH
    ) {
      throw new WorkGraphDefinitionError(
        `compiled task nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
      );
    }
  }
  validateReservedRuntimeInputs(graphSteps, topology, {
    root: (stepId) => steps[stepId].taskDefinition,
    inputs: (task) => task.staticInputs,
    label: (task) => `task definition '${task.taskDefinitionId}'`,
    tree: (stepId) => {
      const tasks = [];
      const descend = (task) => {
        tasks.push(task);
        for (const child of task.children) descend(child);
      };
      descend(steps[stepId].taskDefinition);
      return tasks;
    },
  });
  return {
    workflowDefinitionId: definition.workflowDefinitionId,
    version: definition.version,
    digest: definition.digest,
    trigger: definition.trigger,
    defaults: { ...definition.defaults },
    initialStepId: definition.initialStepId,
    root,
    steps,
  };
}

function normalizeLifecycleBase(value, keys, label, idField, idType) {
  exactKeys(value, keys, label);
  validateWorkGraphProtocolId(value[idField], idType, `${label} ${idField}`);
  workflowRunIdentifier(value.rootIssueId, `${label} rootIssueId`);
  validateWorkGraphProtocolId(
    value.workflowRunId,
    "workflow-run",
    `${label} workflowRunId`,
  );
  validateWorkGraphTaskId(value.taskId, `${label} taskId`);
  const task = normalizeTaskIdentity(value.task, `${label} task`);
  if (task.taskId !== value.taskId || task.workflowRunId !== value.workflowRunId) {
    throw new WorkGraphDefinitionError(
      `${label} direct identity must match its task identity`,
    );
  }
  return {
    rootIssueId: value.rootIssueId,
    workflowRunId: value.workflowRunId,
    taskId: value.taskId,
    task,
  };
}

function taskFromEnvelope(envelope) {
  return {
    taskId: envelope.taskId,
    workflowRunId: envelope.workflowRunId,
    ...envelope.workflowContext,
  };
}

function framedSha256(parts) {
  const hash = createHash("sha256");
  for (const value of parts) {
    const bytes = Buffer.from(value, "utf8");
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(frame);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function validateWorkGraphProtocolId(value, type, context = type) {
  if (
    typeof type !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(type) ||
    typeof value !== "string" ||
    value !==
      `${WORKGRAPH_ID_NAMESPACE}:${type}:sha256:${value.slice(-64)}` ||
    !/^[0-9a-f]{64}$/.test(value.slice(-64))
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must be ${WORKGRAPH_ID_NAMESPACE}:${type}:sha256:<64 lowercase hex>`,
    );
  }
  return value;
}

export function deriveWorkGraphProtocolId(type, semanticInputs) {
  if (
    typeof type !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(type) ||
    !Array.isArray(semanticInputs)
  ) {
    throw new WorkGraphDefinitionError("protocol ID type or inputs are invalid");
  }
  for (const [index, input] of semanticInputs.entries()) {
    directId(input, `protocol ID input ${index}`);
  }
  return `${WORKGRAPH_ID_NAMESPACE}:${type}:sha256:${framedSha256([
    WORKGRAPH_ID_NAMESPACE,
    type,
    ...semanticInputs,
  ])}`;
}

const REFERENCE_KINDS = {
  task: ["Task", "task"],
  taskDefinition: ["TaskDefinition", "task-definition"],
  fork: ["TaskFork", "fork"],
  join: ["TaskJoin", "join"],
  assignment: ["TaskAssignment", "assignment"],
  dispatch: ["TaskDispatch", "dispatch"],
  lease: ["TaskLease", "lease"],
  result: ["TaskResult", "result"],
  evaluation: ["TaskEvaluation", "evaluation"],
  route: ["TaskRoute", "route"],
};

function typedReference(role, id) {
  const [kind, type] = REFERENCE_KINDS[role];
  validateWorkGraphProtocolId(id, type, `${role} reference id`);
  return { kind, id };
}

function validateTypedReference(value, role, nullable = false) {
  if (nullable && value === null) return null;
  exactKeys(value, ["kind", "id"], `${role} reference`);
  const [kind, type] = REFERENCE_KINDS[role];
  if (value.kind !== kind) {
    throw new WorkGraphDefinitionError(
      `${role} reference kind must be ${kind}`,
    );
  }
  validateWorkGraphProtocolId(value.id, type, `${role} reference id`);
  return value;
}

export function normalizeTaskAssignment(value) {
  const base = normalizeLifecycleBase(
    value,
    ASSIGNMENT_KEYS,
    "task assignment",
    "assignmentId",
    "assignment",
  );
  if (value.joinId !== null) {
    validateWorkGraphProtocolId(value.joinId, "join", "task assignment joinId");
  }
  if (
    !Array.isArray(value.permittedExecutors) ||
    value.permittedExecutors.length < 1 ||
    value.permittedExecutors.length > MAX_TASK_DEFINITION_EXECUTORS
  ) {
    throw new WorkGraphDefinitionError(
      `task assignment permittedExecutors must contain 1-${MAX_TASK_DEFINITION_EXECUTORS} entries`,
    );
  }
  const executors = new Set();
  for (const executor of value.permittedExecutors) {
    identifier(executor, "task assignment permitted executor");
    if (executors.has(executor)) {
      throw new WorkGraphDefinitionError(
        `task assignment repeats permitted executor '${executor}'`,
      );
    }
    executors.add(executor);
  }
  return {
    assignmentId: value.assignmentId,
    ...base,
    joinId: value.joinId,
    permittedExecutors: [...value.permittedExecutors],
  };
}

export function formatTaskAssignment(value) {
  const normalized = normalizeTaskAssignment(value);
  return formatEnvelope(
    TASK_ASSIGNMENT_MARKER,
    "TaskAssignment",
    normalized.assignmentId,
    normalized,
    {
      join:
        normalized.joinId === null
          ? null
          : typedReference("join", normalized.joinId),
    },
    { permittedExecutors: normalized.permittedExecutors },
  );
}

export function parseTaskAssignment(body) {
  return parseEnvelopeBody(
    body,
    TASK_ASSIGNMENT_MARKER,
    "TaskAssignment",
    ["join"],
    ["permittedExecutors"],
    (envelope) => ({
      assignmentId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      joinId: validateTypedReference(
        envelope.references.join,
        "join",
        true,
      )?.id ?? null,
      permittedExecutors: envelope.data.permittedExecutors,
    }),
    formatTaskAssignment,
  );
}

function normalizeForkChildren(children, context) {
  if (
    !Array.isArray(children) ||
    children.length < 1 ||
    children.length > MAX_TASK_DEFINITION_CHILDREN
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must contain 1-${MAX_TASK_DEFINITION_CHILDREN} entries`,
    );
  }
  const definitions = new Set();
  const tasks = new Set();
  let previousDefinition = null;
  return children.map((child, index) => {
    exactKeys(child, FORK_CHILD_KEYS, `${context}[${index}]`);
    validateWorkGraphProtocolId(
      child.taskDefinitionId,
      "task-definition",
      `${context}[${index}].taskDefinitionId`,
    );
    validateWorkGraphTaskId(child.taskId, `${context}[${index}].taskId`);
    if (
      definitions.has(child.taskDefinitionId) ||
      tasks.has(child.taskId) ||
      (previousDefinition !== null &&
        previousDefinition >= child.taskDefinitionId)
    ) {
      throw new WorkGraphDefinitionError(
        `${context} must contain unique children ordered by taskDefinitionId`,
      );
    }
    definitions.add(child.taskDefinitionId);
    tasks.add(child.taskId);
    previousDefinition = child.taskDefinitionId;
    return { ...child };
  });
}

export function deriveWorkGraphTaskForkId(taskId, children) {
  validateWorkGraphTaskId(taskId, "task Fork taskId");
  const normalized = normalizeForkChildren(children, "task Fork children");
  return deriveWorkGraphProtocolId("fork", [
    taskId,
    ...normalized.flatMap((child) => [
      child.taskDefinitionId,
      child.taskId,
    ]),
  ]);
}

export function normalizeTaskFork(value) {
  const base = normalizeLifecycleBase(
    value,
    FORK_KEYS,
    "task Fork",
    "forkId",
    "fork",
  );
  const children = normalizeForkChildren(value.children, "task Fork children");
  if (value.forkId !== deriveWorkGraphTaskForkId(value.taskId, children)) {
    throw new WorkGraphDefinitionError(
      "task Fork forkId does not match its ordered child references",
    );
  }
  return { forkId: value.forkId, ...base, children };
}

export function formatTaskFork(value) {
  const normalized = normalizeTaskFork(value);
  return formatEnvelope(
    TASK_FORK_MARKER,
    "TaskFork",
    normalized.forkId,
    normalized,
    {
      children: normalized.children.map((child) => ({
        taskDefinition: typedReference(
          "taskDefinition",
          child.taskDefinitionId,
        ),
        task: typedReference("task", child.taskId),
      })),
    },
    { childCount: normalized.children.length },
  );
}

export function parseTaskFork(body) {
  return parseEnvelopeBody(
    body,
    TASK_FORK_MARKER,
    "TaskFork",
    ["children"],
    ["childCount"],
    (envelope) => {
      if (
        !Array.isArray(envelope.references.children) ||
        envelope.data.childCount !== envelope.references.children.length
      ) {
        throw new WorkGraphDefinitionError(
          "TaskFork childCount does not match references.children",
        );
      }
      return {
        forkId: envelope.id,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        children: envelope.references.children.map((child, index) => {
          exactKeys(
            child,
            ["taskDefinition", "task"],
            `TaskFork references.children[${index}]`,
          );
          return {
            taskDefinitionId: validateTypedReference(
              child.taskDefinition,
              "taskDefinition",
            ).id,
            taskId: validateTypedReference(child.task, "task").id,
          };
        }),
      };
    },
    formatTaskFork,
  );
}

function normalizeJoinChildren(children, context) {
  if (!Array.isArray(children)) {
    throw new WorkGraphDefinitionError(
      `${context} must contain 1-${MAX_TASK_DEFINITION_CHILDREN} entries`,
    );
  }
  children.forEach((child, index) =>
    exactKeys(child, JOIN_CHILD_KEYS, `${context}[${index}]`),
  );
  const base = normalizeForkChildren(
    children.map((child) => ({
      taskDefinitionId: child.taskDefinitionId,
      taskId: child.taskId,
    })),
    context,
  );
  const results = new Set();
  const evaluations = new Set();
  return children.map((child, index) => {
    validateWorkGraphProtocolId(
      child.resultId,
      "result",
      `${context}[${index}].resultId`,
    );
    validateWorkGraphProtocolId(
      child.evaluationId,
      "evaluation",
      `${context}[${index}].evaluationId`,
    );
    if (results.has(child.resultId) || evaluations.has(child.evaluationId)) {
      throw new WorkGraphDefinitionError(
        `${context} must contain unique Result and Evaluation references`,
      );
    }
    results.add(child.resultId);
    evaluations.add(child.evaluationId);
    return { ...base[index], resultId: child.resultId, evaluationId: child.evaluationId };
  });
}

export function deriveWorkGraphTaskJoinId(taskId, forkId, children) {
  validateWorkGraphTaskId(taskId, "task Join taskId");
  validateWorkGraphProtocolId(forkId, "fork", "task Join forkId");
  const normalized = normalizeJoinChildren(children, "task Join children");
  return deriveWorkGraphProtocolId("join", [
    taskId,
    forkId,
    ...normalized.flatMap((child) => [
      child.taskDefinitionId,
      child.taskId,
      child.resultId,
      child.evaluationId,
    ]),
  ]);
}

export function normalizeTaskJoin(value) {
  const base = normalizeLifecycleBase(
    value,
    JOIN_KEYS,
    "task Join",
    "joinId",
    "join",
  );
  validateWorkGraphProtocolId(value.forkId, "fork", "task Join forkId");
  if (value.strategy !== "all") {
    throw new WorkGraphDefinitionError("task Join strategy must be all");
  }
  const children = normalizeJoinChildren(value.children, "task Join children");
  if (
    value.joinId !==
    deriveWorkGraphTaskJoinId(value.taskId, value.forkId, children)
  ) {
    throw new WorkGraphDefinitionError(
      "task Join joinId does not match its Fork and ordered child actions",
    );
  }
  return {
    joinId: value.joinId,
    ...base,
    forkId: value.forkId,
    strategy: value.strategy,
    children,
  };
}

export function formatTaskJoin(value) {
  const normalized = normalizeTaskJoin(value);
  return formatEnvelope(
    TASK_JOIN_MARKER,
    "TaskJoin",
    normalized.joinId,
    normalized,
    {
      fork: typedReference("fork", normalized.forkId),
      children: normalized.children.map((child) => ({
        taskDefinition: typedReference(
          "taskDefinition",
          child.taskDefinitionId,
        ),
        task: typedReference("task", child.taskId),
        result: typedReference("result", child.resultId),
        evaluation: typedReference("evaluation", child.evaluationId),
      })),
    },
    { strategy: normalized.strategy, childCount: normalized.children.length },
  );
}

export function parseTaskJoin(body) {
  return parseEnvelopeBody(
    body,
    TASK_JOIN_MARKER,
    "TaskJoin",
    ["fork", "children"],
    ["strategy", "childCount"],
    (envelope) => {
      const fork = validateTypedReference(envelope.references.fork, "fork");
      if (
        !Array.isArray(envelope.references.children) ||
        envelope.data.childCount !== envelope.references.children.length
      ) {
        throw new WorkGraphDefinitionError(
          "TaskJoin childCount does not match references.children",
        );
      }
      return {
        joinId: envelope.id,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        forkId: fork.id,
        strategy: envelope.data.strategy,
        children: envelope.references.children.map((child, index) => {
          exactKeys(
            child,
            ["taskDefinition", "task", "result", "evaluation"],
            `TaskJoin references.children[${index}]`,
          );
          return {
            taskDefinitionId: validateTypedReference(
              child.taskDefinition,
              "taskDefinition",
            ).id,
            taskId: validateTypedReference(child.task, "task").id,
            resultId: validateTypedReference(child.result, "result").id,
            evaluationId: validateTypedReference(
              child.evaluation,
              "evaluation",
            ).id,
          };
        }),
      };
    },
    formatTaskJoin,
  );
}

export function normalizeTaskDispatch(value) {
  const base = normalizeLifecycleBase(
    value,
    DISPATCH_KEYS,
    "task dispatch",
    "dispatchId",
    "dispatch",
  );
  validateWorkGraphProtocolId(
    value.launchId,
    "dispatch-launch",
    "task dispatch launchId",
  );
  exactKeys(
    value.lease,
    ["leaseId", "assignmentId", "executorId", "slotId"],
    "task dispatch lease",
  );
  validateWorkGraphProtocolId(
    value.lease.leaseId,
    "lease",
    "task dispatch leaseId",
  );
  validateWorkGraphProtocolId(
    value.lease.assignmentId,
    "assignment",
    "task dispatch assignmentId",
  );
  identifier(value.lease.executorId, "task dispatch executorId");
  directId(value.lease.slotId, "task dispatch slotId");
  return {
    dispatchId: value.dispatchId,
    launchId: value.launchId,
    ...base,
    lease: {
      leaseId: value.lease.leaseId,
      assignmentId: value.lease.assignmentId,
      executorId: value.lease.executorId,
      slotId: value.lease.slotId,
    },
  };
}

export function formatTaskDispatch(value) {
  const normalized = normalizeTaskDispatch(value);
  return formatEnvelope(
    TASK_DISPATCH_MARKER,
    "TaskDispatch",
    normalized.dispatchId,
    normalized,
    { assignment: typedReference("assignment", normalized.lease.assignmentId) },
    {
      launchId: normalized.launchId,
      lease: {
        id: normalized.lease.leaseId,
        executorId: normalized.lease.executorId,
        slotId: normalized.lease.slotId,
      },
    },
  );
}

export function parseTaskDispatch(body) {
  return parseEnvelopeBody(
    body,
    TASK_DISPATCH_MARKER,
    "TaskDispatch",
    ["assignment"],
    ["launchId", "lease"],
    (envelope) => {
      exactKeys(envelope.data.lease, ["id", "executorId", "slotId"], "TaskDispatch lease");
      validateTypedReference(envelope.references.assignment, "assignment");
      return {
        dispatchId: envelope.id,
        launchId: envelope.data.launchId,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        lease: {
          leaseId: envelope.data.lease.id,
          assignmentId: envelope.references.assignment.id,
          executorId: envelope.data.lease.executorId,
          slotId: envelope.data.lease.slotId,
        },
      };
    },
    formatTaskDispatch,
  );
}

export function deriveWorkGraphTaskResultId(taskId, dispatchId, leaseId) {
  validateWorkGraphTaskId(taskId, "task Result taskId");
  validateWorkGraphProtocolId(dispatchId, "dispatch", "task Result dispatchId");
  validateWorkGraphProtocolId(leaseId, "lease", "task Result leaseId");
  return deriveWorkGraphProtocolId("result", [taskId, dispatchId, leaseId]);
}

export function normalizeTaskResult(value) {
  const base = normalizeLifecycleBase(
    value,
    RESULT_KEYS,
    "task Result",
    "resultId",
    "result",
  );
  validateWorkGraphProtocolId(
    value.dispatchId,
    "dispatch",
    "task Result dispatchId",
  );
  validateWorkGraphProtocolId(value.leaseId, "lease", "task Result leaseId");
  executionAttempt(value.attempt, "task Result attempt");
  if (!["succeeded", "failed", "cancelled"].includes(value.outcome)) {
    throw new WorkGraphDefinitionError(
      "task Result outcome must be succeeded, failed, or cancelled",
    );
  }
  return {
    resultId: value.resultId,
    ...base,
    dispatchId: value.dispatchId,
    leaseId: value.leaseId,
    attempt: value.attempt,
    outcome: value.outcome,
    output: lifecycleData(value.output, "task Result output"),
  };
}

export function formatTaskResult(value) {
  return formatArtifact(TASK_RESULT_MARKER, taskResultEnvelope(value));
}

export function taskResultEnvelope(value) {
  const normalized = normalizeTaskResult(value);
  return envelopeObject(
    "TaskResult",
    normalized.resultId,
    normalized,
    {
      dispatch: typedReference("dispatch", normalized.dispatchId),
      lease: typedReference("lease", normalized.leaseId),
    },
    {
      attempt: normalized.attempt,
      outcome: normalized.outcome,
      output: normalized.output,
    },
  );
}

function compactCanonicalJson(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(compactCanonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(utf8Compare)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${compactCanonicalJson(value[key])}`,
    )
    .join(",")}}`;
}

export function canonicalTaskResultEnvelopeJson(value) {
  return compactCanonicalJson(taskResultEnvelope(value));
}

export function taskResultDigest(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalTaskResultEnvelopeJson(value), "utf8")
    .digest("hex")}`;
}

export function deriveWorkGraphTaskEvaluationId(
  taskId,
  resultId,
  resultDigest,
) {
  validateWorkGraphTaskId(taskId, "task evaluation taskId");
  validateWorkGraphProtocolId(resultId, "result", "task evaluation resultId");
  digest(resultDigest, "task evaluation resultDigest");
  return deriveWorkGraphProtocolId("evaluation", [
    taskId,
    resultId,
    resultDigest,
  ]);
}

export function deriveWorkGraphTaskRouteId(taskId, evaluationId) {
  validateWorkGraphTaskId(taskId, "task route taskId");
  validateWorkGraphProtocolId(
    evaluationId,
    "evaluation",
    "task route evaluationId",
  );
  return deriveWorkGraphProtocolId("route", [taskId, evaluationId]);
}

export function parseTaskResult(body) {
  return parseEnvelopeBody(
    body,
    TASK_RESULT_MARKER,
    "TaskResult",
    ["dispatch", "lease"],
    ["attempt", "outcome", "output"],
    (envelope) => {
      validateTypedReference(envelope.references.dispatch, "dispatch");
      validateTypedReference(envelope.references.lease, "lease");
      return {
        resultId: envelope.id,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        dispatchId: envelope.references.dispatch.id,
        leaseId: envelope.references.lease.id,
        attempt: envelope.data.attempt,
        outcome: envelope.data.outcome,
        output: envelope.data.output,
      };
    },
    formatTaskResult,
  );
}

export function normalizeTaskEvaluation(value) {
  const base = normalizeLifecycleBase(
    value,
    EVALUATION_KEYS,
    "task evaluation",
    "evaluationId",
    "evaluation",
  );
  validateWorkGraphProtocolId(
    value.resultId,
    "result",
    "task evaluation resultId",
  );
  digest(value.resultDigest, "task evaluation resultDigest");
  if (
    value.evaluationId !==
    deriveWorkGraphTaskEvaluationId(
      value.taskId,
      value.resultId,
      value.resultDigest,
    )
  ) {
    throw new WorkGraphDefinitionError(
      "task evaluation evaluationId is not canonical",
    );
  }
  identifier(value.evaluatorId, "task evaluation evaluatorId");
  executionAttempt(value.attempt, "task evaluation attempt");
  if (!["accepted", "rejected"].includes(value.verdict)) {
    throw new WorkGraphDefinitionError(
      "task evaluation verdict must be accepted or rejected",
    );
  }
  nonEmptyText(value.summary, "task evaluation summary");
  if (new TextEncoder().encode(value.summary).length > 4096) {
    throw new WorkGraphDefinitionError(
      "task evaluation summary must not exceed 4096 bytes",
    );
  }
  if (!lifecycleText(value.feedback)) {
    throw new WorkGraphDefinitionError(
      "task evaluation feedback must be ordinary text",
    );
  }
  if (new TextEncoder().encode(value.feedback).length > 16384) {
    throw new WorkGraphDefinitionError(
      "task evaluation feedback must not exceed 16384 bytes",
    );
  }
  if (value.verdict === "accepted" && value.feedback !== "") {
    throw new WorkGraphDefinitionError(
      "an accepted task evaluation requires empty feedback",
    );
  }
  if (value.verdict === "rejected" && value.feedback.trim() === "") {
    throw new WorkGraphDefinitionError(
      "a rejected task evaluation requires feedback",
    );
  }
  return {
    evaluationId: value.evaluationId,
    ...base,
    resultId: value.resultId,
    resultDigest: value.resultDigest,
    evaluatorId: value.evaluatorId,
    attempt: value.attempt,
    verdict: value.verdict,
    summary: value.summary,
    feedback: value.feedback,
  };
}

export function formatTaskEvaluation(value) {
  const normalized = normalizeTaskEvaluation(value);
  return formatEnvelope(
    TASK_EVALUATION_MARKER,
    "TaskEvaluation",
    normalized.evaluationId,
    normalized,
    { result: typedReference("result", normalized.resultId) },
    {
      resultDigest: normalized.resultDigest,
      evaluatorId: normalized.evaluatorId,
      attempt: normalized.attempt,
      verdict: normalized.verdict,
      summary: normalized.summary,
      feedback: normalized.feedback,
    },
  );
}

export function parseTaskEvaluation(body) {
  return parseEnvelopeBody(
    body,
    TASK_EVALUATION_MARKER,
    "TaskEvaluation",
    ["result"],
    ["resultDigest", "evaluatorId", "attempt", "verdict", "summary", "feedback"],
    (envelope) => {
      validateTypedReference(envelope.references.result, "result");
      return {
        evaluationId: envelope.id,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        resultId: envelope.references.result.id,
        resultDigest: envelope.data.resultDigest,
        evaluatorId: envelope.data.evaluatorId,
        attempt: envelope.data.attempt,
        verdict: envelope.data.verdict,
        summary: envelope.data.summary,
        feedback: envelope.data.feedback,
      };
    },
    formatTaskEvaluation,
  );
}

export function normalizeTaskRoute(value) {
  if (!object(value)) {
    throw new WorkGraphDefinitionError("task route must be an object");
  }
  if (value.action === "advance") {
    exactAllowedKeys(
      value,
      [...ROUTE_BASE_KEYS, "transitionKind", "targetStepId", "targetStepKind"],
      ROUTE_ADVANCE_KEYS,
      "task route",
    );
  } else {
    exactKeys(value, ROUTE_BASE_KEYS, "task route");
  }
  const base = normalizeLifecycleBase(
    value,
    Object.keys(value),
    "task route",
    "routeId",
    "route",
  );
  validateWorkGraphProtocolId(value.resultId, "result", "task route resultId");
  validateWorkGraphProtocolId(
    value.evaluationId,
    "evaluation",
    "task route evaluationId",
  );
  if (
    value.routeId !==
    deriveWorkGraphTaskRouteId(value.taskId, value.evaluationId)
  ) {
    throw new WorkGraphDefinitionError("task route routeId is not canonical");
  }
  if (!["accepted", "rejected"].includes(value.evaluationVerdict)) {
    throw new WorkGraphDefinitionError(
      "task route evaluationVerdict must be accepted or rejected",
    );
  }
  identifier(value.orchestratorId, "task route orchestratorId");
  const actions = ["advance", "rework", "complete", "error", "ignore"];
  if (!actions.includes(value.action)) {
    throw new WorkGraphDefinitionError(
      `task route action must be ${actions.join(", ")}`,
    );
  }
  if (
    (value.evaluationVerdict === "accepted" && value.action === "rework") ||
    (value.evaluationVerdict === "rejected" &&
      ["advance", "complete"].includes(value.action))
  ) {
    throw new WorkGraphDefinitionError(
      `task route action ${value.action} is invalid for verdict ${value.evaluationVerdict}`,
    );
  }
  executionAttempt(value.attempt, "task route attempt");
  if (value.action === "advance") {
    if (!["next", "outcome"].includes(value.transitionKind)) {
      throw new WorkGraphDefinitionError(
        "task route transitionKind must be next or outcome",
      );
    }
    stepId(value.targetStepId, "task route targetStepId");
    if (!["task", "wait", "terminal"].includes(value.targetStepKind)) {
      throw new WorkGraphDefinitionError(
        "task route targetStepKind must be task, wait, or terminal",
      );
    }
    if (value.transitionKind === "next" && "outcome" in value) {
      throw new WorkGraphDefinitionError(
        "next task route transition must not include outcome",
      );
    }
    if (value.transitionKind === "outcome") {
      if (!("outcome" in value)) {
        throw new WorkGraphDefinitionError(
          "outcome task route transition requires outcome",
        );
      }
      identifier(value.outcome, "task route outcome");
    }
    if (value.targetStepKind === "task") {
      if (!("targetTaskDefinitionId" in value)) {
        throw new WorkGraphDefinitionError(
          "task target requires targetTaskDefinitionId",
        );
      }
      validateWorkGraphProtocolId(
        value.targetTaskDefinitionId,
        "task-definition",
        "task route targetTaskDefinitionId",
      );
    } else if ("targetTaskDefinitionId" in value) {
      throw new WorkGraphDefinitionError(
        "wait or terminal target must not include targetTaskDefinitionId",
      );
    }
  }
  const normalized = {
    routeId: value.routeId,
    ...base,
    resultId: value.resultId,
    evaluationId: value.evaluationId,
    evaluationVerdict: value.evaluationVerdict,
    orchestratorId: value.orchestratorId,
    action: value.action,
  };
  if (value.action === "advance") {
    normalized.transitionKind = value.transitionKind;
    normalized.targetStepId = value.targetStepId;
    normalized.targetStepKind = value.targetStepKind;
    if ("outcome" in value) normalized.outcome = value.outcome;
    if ("targetTaskDefinitionId" in value)
      normalized.targetTaskDefinitionId = value.targetTaskDefinitionId;
  }
  normalized.attempt = value.attempt;
  return normalized;
}

export function formatTaskRoute(value) {
  const normalized = normalizeTaskRoute(value);
  return formatEnvelope(
    TASK_ROUTE_MARKER,
    "TaskRoute",
    normalized.routeId,
    normalized,
    {
      result: typedReference("result", normalized.resultId),
      evaluation: typedReference("evaluation", normalized.evaluationId),
    },
    {
      evaluationVerdict: normalized.evaluationVerdict,
      orchestratorId: normalized.orchestratorId,
      action: normalized.action,
      attempt: normalized.attempt,
      transitionKind: normalized.transitionKind ?? null,
      targetStepId: normalized.targetStepId ?? null,
      targetStepKind: normalized.targetStepKind ?? null,
      selectedOutcome: normalized.outcome ?? null,
      targetTaskDefinitionId: normalized.targetTaskDefinitionId ?? null,
    },
  );
}

export function parseTaskRoute(body) {
  return parseEnvelopeBody(
    body,
    TASK_ROUTE_MARKER,
    "TaskRoute",
    ["result", "evaluation"],
    [
      "evaluationVerdict",
      "orchestratorId",
      "action",
      "attempt",
      "transitionKind",
      "targetStepId",
      "targetStepKind",
      "selectedOutcome",
      "targetTaskDefinitionId",
    ],
    (envelope) => {
      validateTypedReference(envelope.references.result, "result");
      validateTypedReference(envelope.references.evaluation, "evaluation");
      return {
      routeId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      resultId: envelope.references.result.id,
      evaluationId: envelope.references.evaluation.id,
      evaluationVerdict: envelope.data.evaluationVerdict,
      orchestratorId: envelope.data.orchestratorId,
      action: envelope.data.action,
      ...(envelope.data.transitionKind === null
        ? {}
        : { transitionKind: envelope.data.transitionKind }),
      ...(envelope.data.targetStepId === null
        ? {}
        : { targetStepId: envelope.data.targetStepId }),
      ...(envelope.data.targetStepKind === null
        ? {}
        : { targetStepKind: envelope.data.targetStepKind }),
      ...(envelope.data.selectedOutcome === null
        ? {}
        : { outcome: envelope.data.selectedOutcome }),
      ...(envelope.data.targetTaskDefinitionId === null
        ? {}
        : { targetTaskDefinitionId: envelope.data.targetTaskDefinitionId }),
      attempt: envelope.data.attempt,
      };
    },
    formatTaskRoute,
  );
}

export function deriveWorkGraphTaskErrorId(taskId, stage, code, causeId) {
  validateWorkGraphTaskId(taskId, "task Error taskId");
  if (!["fork", "join", "assignment", "dispatch", "execution", "evaluation", "routing", "closure"].includes(stage)) {
    throw new WorkGraphDefinitionError("task Error stage is invalid");
  }
  identifier(code, "task Error code");
  directId(causeId, "task Error causeId");
  return deriveWorkGraphProtocolId("error", [taskId, stage, code, causeId]);
}

export function normalizeTaskError(value) {
  const base = normalizeLifecycleBase(
    value,
    ERROR_KEYS,
    "task Error",
    "errorId",
    "error",
  );
  exactKeys(value.references, ERROR_REFERENCE_KEYS, "task Error references");
  const references = {};
  for (const [index, key] of ERROR_REFERENCE_KEYS.entries()) {
    const role = ERROR_REFERENCE_ROLES[index];
    if (value.references[key] !== null) {
      validateWorkGraphProtocolId(
        value.references[key],
        REFERENCE_KINDS[role][1],
        `task Error references ${key}`,
      );
    }
    references[key] = value.references[key];
  }
  const stages = ["fork", "join", "assignment", "dispatch", "execution", "evaluation", "routing", "closure"];
  const categories = ["task", "protocol", "system"];
  if (!stages.includes(value.stage)) {
    throw new WorkGraphDefinitionError("task Error stage is invalid");
  }
  identifier(value.code, "task Error code");
  if (!categories.includes(value.category)) {
    throw new WorkGraphDefinitionError("task Error category is invalid");
  }
  nonEmptyText(value.summary, "task Error summary");
  if (new TextEncoder().encode(value.summary).length > 4096) {
    throw new WorkGraphDefinitionError("task Error summary must not exceed 4096 bytes");
  }
  if (typeof value.retryable !== "boolean") {
    throw new WorkGraphDefinitionError("task Error retryable must be boolean");
  }
  if (value.attempt !== null) executionAttempt(value.attempt, "task Error attempt");
  const causeId =
    references.routeId ??
    references.evaluationId ??
    references.resultId ??
    references.dispatchId ??
    references.assignmentId ??
    references.joinId ??
    references.forkId ??
    references.leaseId;
  if (causeId === null || causeId === undefined) {
    throw new WorkGraphDefinitionError("task Error requires a causal reference");
  }
  if (
    value.errorId !==
    deriveWorkGraphTaskErrorId(value.taskId, value.stage, value.code, causeId)
  ) {
    throw new WorkGraphDefinitionError(
      "task Error id does not match its canonical cause",
    );
  }
  return {
    errorId: value.errorId,
    ...base,
    references,
    stage: value.stage,
    code: value.code,
    category: value.category,
    summary: value.summary,
    retryable: value.retryable,
    attempt: value.attempt,
    details: dataMap(value.details, "task Error details"),
  };
}

export function formatTaskError(value) {
  const normalized = normalizeTaskError(value);
  const references = Object.fromEntries(
    ERROR_REFERENCE_ROLES.map((role, index) => [
      role,
      normalized.references[ERROR_REFERENCE_KEYS[index]] === null
        ? null
        : typedReference(
            role,
            normalized.references[ERROR_REFERENCE_KEYS[index]],
          ),
    ]),
  );
  return formatEnvelope(
    TASK_ERROR_MARKER,
    "TaskError",
    normalized.errorId,
    normalized,
    references,
    {
      stage: normalized.stage,
      code: normalized.code,
      category: normalized.category,
      summary: normalized.summary,
      retryable: normalized.retryable,
      attempt: normalized.attempt,
      details: normalized.details,
    },
  );
}

export function parseTaskError(body) {
  return parseEnvelopeBody(
    body,
    TASK_ERROR_MARKER,
    "TaskError",
    ERROR_REFERENCE_ROLES,
    ["stage", "code", "category", "summary", "retryable", "attempt", "details"],
    (envelope) => {
      const references = {};
      for (const [index, role] of ERROR_REFERENCE_ROLES.entries()) {
        const reference = validateTypedReference(
          envelope.references[role],
          role,
          true,
        );
        references[ERROR_REFERENCE_KEYS[index]] = reference?.id ?? null;
      }
      return {
        errorId: envelope.id,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        references,
        stage: envelope.data.stage,
        code: envelope.data.code,
        category: envelope.data.category,
        summary: envelope.data.summary,
        retryable: envelope.data.retryable,
        attempt: envelope.data.attempt,
        details: envelope.data.details,
      };
    },
    formatTaskError,
  );
}

const TASK_ACTION_CODECS = {
  TaskFork: [TASK_FORK_MARKER, formatTaskFork, parseTaskFork],
  TaskJoin: [TASK_JOIN_MARKER, formatTaskJoin, parseTaskJoin],
  TaskAssignment: [
    TASK_ASSIGNMENT_MARKER,
    formatTaskAssignment,
    parseTaskAssignment,
  ],
  TaskDispatch: [TASK_DISPATCH_MARKER, formatTaskDispatch, parseTaskDispatch],
  TaskResult: [TASK_RESULT_MARKER, formatTaskResult, parseTaskResult],
  TaskEvaluation: [
    TASK_EVALUATION_MARKER,
    formatTaskEvaluation,
    parseTaskEvaluation,
  ],
  TaskRoute: [TASK_ROUTE_MARKER, formatTaskRoute, parseTaskRoute],
  TaskError: [TASK_ERROR_MARKER, formatTaskError, parseTaskError],
};

export function formatWorkGraphTaskAction(action) {
  exactKeys(action, ["kind", "value"], "WorkGraphTaskAction");
  const codec = TASK_ACTION_CODECS[action.kind];
  if (!codec) {
    throw new WorkGraphDefinitionError(
      "WorkGraphTaskAction kind is not supported",
    );
  }
  return codec[1](action.value);
}

export function parseWorkGraphTaskAction(body) {
  const marker = typeof body === "string" ? body.split("\n", 1)[0] : "";
  const entry = Object.entries(TASK_ACTION_CODECS).find(
    ([, [candidate]]) => candidate === marker,
  );
  if (!entry) {
    throw new WorkGraphDefinitionError(
      "body does not begin with a WorkGraphTaskAction/v1 marker",
    );
  }
  const [kind, [, , parse]] = entry;
  return { kind, value: parse(body) };
}

export function validateTaskRouteAgainstDefinition(
  value,
  definition,
  sourceContext,
) {
  const route = normalizeTaskRoute(value);
  const workflow = normalizeCompiledWorkflowDefinition(definition);
  exactKeys(
    sourceContext,
    ["sourceStepId", "taskDefinitionId"],
    "task route source context",
  );
  stepId(sourceContext.sourceStepId, "task route sourceStepId");
  validateWorkGraphProtocolId(
    sourceContext.taskDefinitionId,
    "task-definition",
    "task route source taskDefinitionId",
  );
  const source = workflow.steps[sourceContext.sourceStepId];
  if (source?.type !== "task") {
    throw new WorkGraphDefinitionError(
      "task route source context must identify the routed compiled task step",
    );
  }
  const policy = source.executionPolicies[sourceContext.taskDefinitionId];
  if (!policy) {
    throw new WorkGraphDefinitionError(
      "task route source context must identify a task in the compiled source step",
    );
  }
  if (route.orchestratorId !== policy.orchestratorId) {
    throw new WorkGraphDefinitionError(
      "task route orchestratorId must match the source task policy",
    );
  }
  if (
    route.action === "rework" &&
    route.attempt - 1 >= policy.maxReworkAttempts
  ) {
    throw new WorkGraphDefinitionError(
      "rework task route attempt exceeds the source task policy",
    );
  }
  if (route.action !== "advance") return route;
  if (
    source.taskDefinition.taskDefinitionId !== sourceContext.taskDefinitionId
  ) {
    throw new WorkGraphDefinitionError(
      "recursive child task routes cannot advance a top-level workflow transition",
    );
  }
  const target = workflow.steps[route.targetStepId];
  if (!target) {
    throw new WorkGraphDefinitionError(
      "task route targetStepId must reference a compiled step",
    );
  }
  if (route.targetStepKind !== target.type) {
    throw new WorkGraphDefinitionError(
      "task route targetStepKind must match the compiled target step",
    );
  }
  if (target.type === "task") {
    if (
      route.targetTaskDefinitionId !==
      target.taskDefinition.taskDefinitionId
    ) {
      throw new WorkGraphDefinitionError(
        "task route to a task requires its targetTaskDefinitionId",
      );
    }
  } else if ("targetTaskDefinitionId" in route) {
    throw new WorkGraphDefinitionError(
      "task route targetTaskDefinitionId is forbidden for wait and terminal steps",
    );
  }
  const transitionMatches =
    route.transitionKind === "next"
      ? source.transition.type === "next" &&
        source.transition.targetStepId === route.targetStepId
      : source.transition.type === "outcomes" &&
        source.transition.targets[route.outcome] === route.targetStepId;
  if (!transitionMatches) {
    throw new WorkGraphDefinitionError(
      "task route transition must match the source task's compiled transition",
    );
  }
  return route;
}

export function nextReworkAttempt(
  current,
  maxReworkAttempts = DEFAULT_MAX_REWORK_ATTEMPTS,
) {
  exactKeys(current, ["taskId", "assignmentId", "attempt"], "rework attempt");
  validateWorkGraphTaskId(current.taskId, "rework attempt taskId");
  directId(current.assignmentId, "rework attempt assignmentId");
  executionAttempt(current.attempt, "rework attempt");
  boundedCount(maxReworkAttempts, "rework maximum");
  if (current.attempt - 1 >= maxReworkAttempts) {
    throw new WorkGraphDefinitionError(
      `rework exceeds maximum of ${maxReworkAttempts} attempts`,
    );
  }
  return {
    taskId: current.taskId,
    assignmentId: current.assignmentId,
    attempt: current.attempt + 1,
  };
}
