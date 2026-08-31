import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextEncoder } from "node:util";

export const WORKFLOW_DEFINITION_MARKER = "WorkGraphWorkflowDefinition/v1";
export const RUNTIME_TASK_MARKER = "WorkGraphTask/v1";
export const TASK_ASSIGNMENT_MARKER = "WorkGraphTaskAssignment/v1";
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

const MAX_DATA_DEPTH = 32;
const RESERVED_MARKERS = [
  WORKFLOW_DEFINITION_MARKER,
  RUNTIME_TASK_MARKER,
  TASK_ASSIGNMENT_MARKER,
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
  "context",
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
  exactKeys(task, TASK_DEFINITION_KEYS, context);
  if (depth > MAX_TASK_DEFINITION_DEPTH) {
    throw new WorkGraphDefinitionError(
      `task definition nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    );
  }
  identifier(task.taskDefinitionId, `${context}.taskDefinitionId`);
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
  identifier(value.taskDefinitionId, `${context} taskDefinitionId`);
  identifier(value.taskKey, `${context} taskKey`);
  identifier(value.operation, `${context} operation`);
  return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, value[key]]));
}

export function normalizeTaskIdentity(value, context = "task identity") {
  exactKeys(value, TASK_IDENTITY_KEYS, context);
  identifier(value.taskId, `${context} taskId`);
  workflowRunIdentifier(value.workflowRunId, `${context} workflowRunId`);
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
  workflowRunIdentifier(value.workflowRunId, `${kind} workflowRunId`);
  identifier(value.taskId, `${kind} taskId`);
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
    context: Object.fromEntries(CONTEXT_KEYS.map((key) => [key, identity[key]])),
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
  workflowRunIdentifier(envelope.workflowRunId, `${kind} envelope workflowRunId`);
  identifier(envelope.taskId, `${kind} envelope taskId`);
  envelope.context = normalizeTaskContext(envelope.context, `${kind} context`);
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
  identifier(task.taskId, "runtime task taskId");
  workflowRunIdentifier(task.rootIssueId, "runtime task rootIssueId");
  workflowRunIdentifier(task.workflowRunId, "runtime task workflowRunId");
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
  identifier(task.taskDefinitionId, "runtime task taskDefinitionId");
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
        ...envelope.context,
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
];
const CHILD_TASK_KEYS = [
  "operation",
  "worker",
  "inputs",
  "evaluator",
  "orchestrator",
  "maxReworkAttempts",
  "children",
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
  "permittedExecutors",
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
  "assignmentId",
  "dispatchId",
  "leaseId",
  "resultId",
  "evaluationId",
  "routeId",
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

function normalizeChildren(value, workflowDefaults, context, depth) {
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
    );
  }
  return { join: value.join, tasks };
}

function normalizeChildTask(value, workflowDefaults, context, depth) {
  exactAllowedKeys(
    value,
    ["operation", "worker"],
    CHILD_TASK_KEYS,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  const normalized = {
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs ?? {}, `${context}.inputs`),
    evaluator: null,
    orchestrator: null,
    maxReworkAttempts: null,
    children: null,
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
  if ("children" in value) {
    normalized.children = normalizeChildren(
      value.children,
      workflowDefaults,
      `${context}.children`,
      depth + 1,
    );
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
  const normalized = {
    type: value.type,
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs ?? {}, `${context}.inputs`),
    evaluator: null,
    orchestrator: null,
    maxReworkAttempts: null,
    children: null,
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

  if ("children" in value) {
    normalized.children = normalizeChildren(
      value.children,
      stepIds.defaults,
      `${context}.children`,
      1,
    );
  }
  return normalized;
}

function workflowTargets(step) {
  if (step.next) return [step.next];
  if (step.outcomes) return Object.values(step.outcomes);
  return [];
}

function validateWorkflowGraph(initial, steps) {
  const reachable = new Set();
  const visit = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const target of workflowTargets(steps[id])) visit(target);
  };
  visit(initial);

  if (
    ![...reachable].some((id) => steps[id].type === "terminal")
  ) {
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
    for (const target of workflowTargets(steps[id])) detectCycle(target);
    stack.pop();
    active.delete(id);
    complete.add(id);
  };
  detectCycle(initial);
  const unreachable = Object.keys(steps).filter(
    (id) => !reachable.has(id),
  );
  if (unreachable.length > 0) {
    throw new WorkGraphDefinitionError(
      `issue workflow has unreachable steps: ${unreachable.join(", ")}`,
    );
  }
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
  validateWorkflowGraph(workflow.spec.initial, normalizedSteps);
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
  exactKeys(value, TASK_DEFINITION_KEYS, context);
  if (depth > MAX_TASK_DEFINITION_DEPTH) {
    throw new WorkGraphDefinitionError(
      `compiled task nesting exceeds maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
    );
  }
  identifier(value.taskDefinitionId, `${context}.taskDefinitionId`);
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
  };
}

function normalizeExecutionPolicies(value, context) {
  if (!object(value) || Object.keys(value).length < 1) {
    throw new WorkGraphDefinitionError(`${context} must be a non-empty map`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([taskDefinitionId, policy]) => {
      identifier(taskDefinitionId, `${context} key`);
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
  validateWorkflowGraph(definition.initialStepId, graphSteps);
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

function normalizeLifecycleBase(value, keys, label, idField) {
  exactKeys(value, keys, label);
  directId(value[idField], `${label} ${idField}`);
  workflowRunIdentifier(value.rootIssueId, `${label} rootIssueId`);
  workflowRunIdentifier(value.workflowRunId, `${label} workflowRunId`);
  identifier(value.taskId, `${label} taskId`);
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
    ...envelope.context,
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

export function normalizeTaskAssignment(value) {
  const base = normalizeLifecycleBase(
    value,
    ASSIGNMENT_KEYS,
    "task assignment",
    "assignmentId",
  );
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
    {},
    { permittedExecutors: normalized.permittedExecutors },
  );
}

export function parseTaskAssignment(body) {
  return parseEnvelopeBody(
    body,
    TASK_ASSIGNMENT_MARKER,
    "TaskAssignment",
    EMPTY_KEYS,
    ["permittedExecutors"],
    (envelope) => ({
      assignmentId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      permittedExecutors: envelope.data.permittedExecutors,
    }),
    formatTaskAssignment,
  );
}

export function normalizeTaskDispatch(value) {
  const base = normalizeLifecycleBase(
    value,
    DISPATCH_KEYS,
    "task dispatch",
    "dispatchId",
  );
  directId(value.launchId, "task dispatch launchId");
  exactKeys(
    value.lease,
    ["leaseId", "assignmentId", "executorId", "slotId"],
    "task dispatch lease",
  );
  directId(value.lease.leaseId, "task dispatch leaseId");
  directId(value.lease.assignmentId, "task dispatch assignmentId");
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
    { assignmentId: normalized.lease.assignmentId },
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
    ["assignmentId"],
    ["launchId", "lease"],
    (envelope) => {
      exactKeys(envelope.data.lease, ["id", "executorId", "slotId"], "TaskDispatch lease");
      return {
        dispatchId: envelope.id,
        launchId: envelope.data.launchId,
        rootIssueId: envelope.rootIssueId,
        workflowRunId: envelope.workflowRunId,
        taskId: envelope.taskId,
        task: taskFromEnvelope(envelope),
        lease: {
          leaseId: envelope.data.lease.id,
          assignmentId: envelope.references.assignmentId,
          executorId: envelope.data.lease.executorId,
          slotId: envelope.data.lease.slotId,
        },
      };
    },
    formatTaskDispatch,
  );
}

export function deriveWorkGraphTaskResultId(taskId, dispatchId, leaseId) {
  identifier(taskId, "task Result taskId");
  directId(dispatchId, "task Result dispatchId");
  directId(leaseId, "task Result leaseId");
  return `workgraph-v1:result:sha256:${framedSha256([taskId, dispatchId, leaseId])}`;
}

export function normalizeTaskResult(value) {
  const base = normalizeLifecycleBase(value, RESULT_KEYS, "task Result", "resultId");
  directId(value.dispatchId, "task Result dispatchId");
  directId(value.leaseId, "task Result leaseId");
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
    { dispatchId: normalized.dispatchId, leaseId: normalized.leaseId },
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
  identifier(taskId, "task evaluation taskId");
  directId(resultId, "task evaluation resultId");
  digest(resultDigest, "task evaluation resultDigest");
  return `workgraph-v1:evaluation:sha256:${framedSha256([
    taskId,
    resultId,
    resultDigest,
  ])}`;
}

export function deriveWorkGraphTaskRouteId(taskId, evaluationId) {
  identifier(taskId, "task route taskId");
  directId(evaluationId, "task route evaluationId");
  return `workgraph-v1:route:sha256:${framedSha256([
    taskId,
    evaluationId,
  ])}`;
}

export function parseTaskResult(body) {
  return parseEnvelopeBody(
    body,
    TASK_RESULT_MARKER,
    "TaskResult",
    ["dispatchId", "leaseId"],
    ["attempt", "outcome", "output"],
    (envelope) => ({
      resultId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      dispatchId: envelope.references.dispatchId,
      leaseId: envelope.references.leaseId,
      attempt: envelope.data.attempt,
      outcome: envelope.data.outcome,
      output: envelope.data.output,
    }),
    formatTaskResult,
  );
}

export function normalizeTaskEvaluation(value) {
  const base = normalizeLifecycleBase(
    value,
    EVALUATION_KEYS,
    "task evaluation",
    "evaluationId",
  );
  directId(value.resultId, "task evaluation resultId");
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
    { resultId: normalized.resultId },
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
    ["resultId"],
    ["resultDigest", "evaluatorId", "attempt", "verdict", "summary", "feedback"],
    (envelope) => ({
      evaluationId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      resultId: envelope.references.resultId,
      resultDigest: envelope.data.resultDigest,
      evaluatorId: envelope.data.evaluatorId,
      attempt: envelope.data.attempt,
      verdict: envelope.data.verdict,
      summary: envelope.data.summary,
      feedback: envelope.data.feedback,
    }),
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
  );
  directId(value.resultId, "task route resultId");
  directId(value.evaluationId, "task route evaluationId");
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
      identifier(
        value.targetTaskDefinitionId,
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
    { resultId: normalized.resultId, evaluationId: normalized.evaluationId },
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
    ["resultId", "evaluationId"],
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
    (envelope) => ({
      routeId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      resultId: envelope.references.resultId,
      evaluationId: envelope.references.evaluationId,
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
    }),
    formatTaskRoute,
  );
}

export function deriveWorkGraphTaskErrorId(taskId, stage, code, causeId) {
  identifier(taskId, "task Error taskId");
  if (!["assignment", "dispatch", "execution", "evaluation", "routing", "closure"].includes(stage)) {
    throw new WorkGraphDefinitionError("task Error stage is invalid");
  }
  identifier(code, "task Error code");
  directId(causeId, "task Error causeId");
  return `workgraph-v1:error:sha256:${framedSha256([taskId, stage, code, causeId])}`;
}

export function normalizeTaskError(value) {
  const base = normalizeLifecycleBase(value, ERROR_KEYS, "task Error", "errorId");
  exactKeys(value.references, ERROR_REFERENCE_KEYS, "task Error references");
  const references = {};
  for (const key of ERROR_REFERENCE_KEYS) {
    if (value.references[key] !== null) {
      directId(value.references[key], `task Error references ${key}`);
    }
    references[key] = value.references[key];
  }
  const stages = ["assignment", "dispatch", "execution", "evaluation", "routing", "closure"];
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
  return formatEnvelope(
    TASK_ERROR_MARKER,
    "TaskError",
    normalized.errorId,
    normalized,
    normalized.references,
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
    ERROR_REFERENCE_KEYS,
    ["stage", "code", "category", "summary", "retryable", "attempt", "details"],
    (envelope) => ({
      errorId: envelope.id,
      rootIssueId: envelope.rootIssueId,
      workflowRunId: envelope.workflowRunId,
      taskId: envelope.taskId,
      task: taskFromEnvelope(envelope),
      references: envelope.references,
      stage: envelope.data.stage,
      code: envelope.data.code,
      category: envelope.data.category,
      summary: envelope.data.summary,
      retryable: envelope.data.retryable,
      attempt: envelope.data.attempt,
      details: envelope.data.details,
    }),
    formatTaskError,
  );
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
  identifier(
    sourceContext.taskDefinitionId,
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
  directId(current.taskId, "rework attempt taskId");
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
