import { isDeepStrictEqual, TextEncoder } from "node:util";

export const WORKFLOW_DEFINITION_MARKER = "WorkGraphWorkflowDefinition/v1";
export const RUNTIME_TASK_MARKER = "WorkGraphTask/v1";
export const TASK_EVALUATION_MARKER = "WorkGraphTaskEvaluate/v1";
export const TASK_ROUTE_MARKER = "WorkGraphTaskRoute/v1";
export const WORKFLOW_AUTHORING_API_VERSION = "workgraph.drasi.io/v1";
export const DEFAULT_MAX_REWORK_ATTEMPTS = 3;
export const MAX_TASK_DEFINITION_CHILDREN = 16;
export const MAX_TASK_DEFINITION_DEPTH = 4;
export const MAX_WORKGRAPH_BODY_BYTES = 64 * 1024;
export const MAX_TASK_DEFINITION_EXECUTORS = 8;

const MAX_DATA_DEPTH = 32;
const RESERVED_MARKERS = [
  WORKFLOW_DEFINITION_MARKER,
  RUNTIME_TASK_MARKER,
  "WorkGraphTaskAssign/v1",
  "WorkGraphTaskDispatch/v1",
  "WorkGraphTaskResult/v1",
  "WorkGraphTaskEvaluate/v1",
  "WorkGraphTaskRoute/v1",
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
const LEGACY_RUNTIME_TASK_KEYS = [
  "taskId",
  "rootIssueId",
  "workflowRunId",
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
  "resolvedInputs",
];
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
    if (!Number.isSafeInteger(value)) {
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
        dataMode || key === "staticInputs" || key === "resolvedInputs";
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

export function normalizeRuntimeTask(task, { allowLegacy = false } = {}) {
  if (!object(task)) {
    throw new WorkGraphDefinitionError("runtime task must be an object");
  }
  const keys = Object.keys(task).sort();
  const current = isDeepStrictEqual(keys, [...RUNTIME_TASK_KEYS].sort());
  const legacy =
    allowLegacy &&
    isDeepStrictEqual(keys, [...LEGACY_RUNTIME_TASK_KEYS].sort());
  if (!current && !legacy) {
    throw new WorkGraphDefinitionError(
      `runtime task properties must be exactly ${[...RUNTIME_TASK_KEYS].sort().join(", ")}`,
    );
  }
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
  if (current) {
    identifier(task.taskKey, "runtime task taskKey");
    identifier(task.operation, "runtime task operation");
  }
  return {
    taskId: task.taskId,
    rootIssueId: task.rootIssueId,
    workflowRunId: task.workflowRunId,
    workflowDefinitionId: task.workflowDefinitionId,
    workflowDefinitionVersion: task.workflowDefinitionVersion,
    workflowDefinitionDigest: task.workflowDefinitionDigest,
    taskDefinitionId: task.taskDefinitionId,
    ...(current
      ? {
          taskKey: task.taskKey,
          operation: task.operation,
        }
      : {}),
    resolvedInputs: dataMap(task.resolvedInputs, "runtime task resolvedInputs"),
  };
}

function renderRuntimeTask(task, allowLegacy) {
  const normalized = normalizeRuntimeTask(task, { allowLegacy });
  const body = `${RUNTIME_TASK_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
  if (new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES) {
    throw new WorkGraphDefinitionError(
      `${RUNTIME_TASK_MARKER} body exceeds ${MAX_WORKGRAPH_BODY_BYTES} bytes`,
    );
  }
  return body;
}

export function formatRuntimeTask(task) {
  return renderRuntimeTask(task, false);
}

export function parseRuntimeTask(body) {
  return parseCanonicalBody(body, RUNTIME_TASK_MARKER, (task) =>
    renderRuntimeTask(task, true),
  );
}

export function validateRootRuntimeTask(definition, task) {
  const normalizedDefinition =
    "steps" in definition
      ? normalizeCompiledWorkflowDefinition(definition)
      : normalizeWorkflowDefinition(definition);
  const normalizedTask = normalizeRuntimeTask(task, { allowLegacy: true });
  const expected = {
    workflowDefinitionId: normalizedDefinition.workflowDefinitionId,
    workflowDefinitionVersion: normalizedDefinition.version,
    workflowDefinitionDigest: normalizedDefinition.digest,
    taskDefinitionId: normalizedDefinition.root.taskDefinitionId,
    ...(normalizedTask.taskKey === undefined
      ? {}
      : {
          taskKey: normalizedDefinition.root.taskKey,
          operation: normalizedDefinition.root.operation,
        }),
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
const EVALUATION_KEYS = [
  "evaluationId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
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

export function normalizeTaskEvaluation(value) {
  exactKeys(value, EVALUATION_KEYS, "task evaluation");
  for (const field of ["evaluationId", "rootIssueId", "workflowRunId", "resultId"]) {
    directId(value[field], `task evaluation ${field}`);
  }
  identifier(value.taskId, "task evaluation taskId");
  digest(value.resultDigest, "task evaluation resultDigest");
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
    rootIssueId: value.rootIssueId,
    workflowRunId: value.workflowRunId,
    taskId: value.taskId,
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
  return formatArtifact(TASK_EVALUATION_MARKER, normalized);
}

export function parseTaskEvaluation(body) {
  return parseCanonicalBody(
    body,
    TASK_EVALUATION_MARKER,
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
  for (const field of [
    "routeId",
    "rootIssueId",
    "workflowRunId",
    "resultId",
    "evaluationId",
  ]) {
    directId(value[field], `task route ${field}`);
  }
  identifier(value.taskId, "task route taskId");
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
    rootIssueId: value.rootIssueId,
    workflowRunId: value.workflowRunId,
    taskId: value.taskId,
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
  return formatArtifact(TASK_ROUTE_MARKER, normalized);
}

export function parseTaskRoute(body) {
  return parseCanonicalBody(body, TASK_ROUTE_MARKER, formatTaskRoute);
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
