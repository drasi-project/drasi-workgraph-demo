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
const RUNTIME_TASK_KEYS = [
  "taskId",
  "rootIssueId",
  "workflowRunId",
  "workflowDefinitionId",
  "workflowDefinitionVersion",
  "workflowDefinitionDigest",
  "taskDefinitionId",
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
  return {
    taskId: task.taskId,
    rootIssueId: task.rootIssueId,
    workflowRunId: task.workflowRunId,
    workflowDefinitionId: task.workflowDefinitionId,
    workflowDefinitionVersion: task.workflowDefinitionVersion,
    workflowDefinitionDigest: task.workflowDefinitionDigest,
    taskDefinitionId: task.taskDefinitionId,
    resolvedInputs: dataMap(task.resolvedInputs, "runtime task resolvedInputs"),
  };
}

export function formatRuntimeTask(task) {
  const normalized = normalizeRuntimeTask(task);
  const body = `${RUNTIME_TASK_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
  if (new TextEncoder().encode(body).length > MAX_WORKGRAPH_BODY_BYTES) {
    throw new WorkGraphDefinitionError(
      `${RUNTIME_TASK_MARKER} body exceeds ${MAX_WORKGRAPH_BODY_BYTES} bytes`,
    );
  }
  return body;
}

export function parseRuntimeTask(body) {
  return parseCanonicalBody(body, RUNTIME_TASK_MARKER, formatRuntimeTask);
}

export function validateRootRuntimeTask(definition, task) {
  const normalizedDefinition = normalizeWorkflowDefinition(definition);
  const normalizedTask = normalizeRuntimeTask(task);
  const expected = {
    workflowDefinitionId: normalizedDefinition.workflowDefinitionId,
    workflowDefinitionVersion: normalizedDefinition.version,
    workflowDefinitionDigest: normalizedDefinition.digest,
    taskDefinitionId: normalizedDefinition.root.taskDefinitionId,
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
  "marker",
  "workflowDefinitionId",
  "version",
  "trigger",
  "initialStepId",
  "defaults",
  "steps",
  "transitions",
];
const EVALUATION_KEYS = [
  "evaluationId",
  "rootIssueId",
  "workflowRunId",
  "taskId",
  "resultId",
  "resultDigest",
  "evaluatorId",
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
  "outcome",
  "targetStepId",
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
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new WorkGraphDefinitionError(
      `${context} must be a safe integer from 0 through 4294967295`,
    );
  }
}

function nonEmptyText(value, context) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !ordinaryText(value)
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must be non-empty ordinary text`,
    );
  }
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

function normalizeChildren(value, inherited, context, depth) {
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
      inherited,
      `${context}.tasks.${id}`,
      depth,
    );
  }
  return { join: value.join, tasks };
}

function normalizeChildTask(value, inherited, context, depth) {
  exactAllowedKeys(
    value,
    ["operation", "worker", "inputs"],
    CHILD_TASK_KEYS,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  const normalized = {
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs, `${context}.inputs`),
  };
  const resolved = { ...inherited };
  for (const role of ["evaluator", "orchestrator"]) {
    if (role in value) {
      identifier(value[role], `${context}.${role}`);
      normalized[role] = value[role];
      resolved[role] = value[role];
    }
  }
  if ("maxReworkAttempts" in value) {
    boundedCount(value.maxReworkAttempts, `${context}.maxReworkAttempts`);
    normalized.maxReworkAttempts = value.maxReworkAttempts;
    resolved.maxReworkAttempts = value.maxReworkAttempts;
  }
  if ("children" in value) {
    normalized.children = normalizeChildren(
      value.children,
      resolved,
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
    ["type", "operation", "worker", "inputs"],
    TASK_STEP_KEYS,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  const normalized = {
    type: value.type,
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs, `${context}.inputs`),
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
    const inherited = {
      evaluator: value.evaluator ?? stepIds.defaults.evaluator,
      orchestrator: value.orchestrator ?? stepIds.defaults.orchestrator,
      maxReworkAttempts:
        value.maxReworkAttempts ?? stepIds.defaults.maxReworkAttempts,
    };
    normalized.children = normalizeChildren(
      value.children,
      inherited,
      `${context}.children`,
      1,
    );
  }
  return normalized;
}

function workflowTargets(step) {
  if ("next" in step) return [step.next];
  if ("outcomes" in step) return Object.values(step.outcomes);
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
    (id) =>
      !reachable.has(id) &&
      !(steps[id].type === "terminal" && steps[id].outcome === "error"),
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
  if (
    workflow.spec.defaults.maxReworkAttempts !== DEFAULT_MAX_REWORK_ATTEMPTS
  ) {
    throw new WorkGraphDefinitionError(
      `workflow defaults.maxReworkAttempts must be ${DEFAULT_MAX_REWORK_ATTEMPTS}`,
    );
  }
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

function resolveCompiledChildren(children, inherited) {
  const tasks = {};
  for (const [id, child] of Object.entries(children.tasks)) {
    const effective = {
      evaluator: child.evaluator ?? inherited.evaluator,
      orchestrator: child.orchestrator ?? inherited.orchestrator,
      maxReworkAttempts:
        child.maxReworkAttempts ?? inherited.maxReworkAttempts,
    };
    tasks[id] = {
      operation: child.operation,
      worker: child.worker,
      inputs: child.inputs,
      ...effective,
    };
    if (child.children) {
      tasks[id].children = resolveCompiledChildren(child.children, effective);
    }
  }
  return { join: children.join, tasks };
}

export function compileIssueWorkflowLogical(workflow) {
  const normalized = normalizeIssueWorkflow(workflow);
  const { defaults } = normalized.spec;
  const steps = {};
  const transitions = [];
  for (const [stepIdValue, step] of Object.entries(normalized.spec.steps)) {
    if (step.type === "task") {
      const effective = {
        evaluator: step.evaluator ?? defaults.evaluator,
        orchestrator: step.orchestrator ?? defaults.orchestrator,
        maxReworkAttempts:
          step.maxReworkAttempts ?? defaults.maxReworkAttempts,
      };
      const task = {
        taskDefinitionId: stepIdValue,
        operation: step.operation,
        worker: step.worker,
        inputs: step.inputs,
        ...effective,
      };
      if (step.children) {
        task.children = resolveCompiledChildren(step.children, effective);
      }
      steps[stepIdValue] = {
        stepId: stepIdValue,
        type: step.type,
        task,
      };
    } else if (step.type === "wait") {
      steps[stepIdValue] = {
        stepId: stepIdValue,
        type: step.type,
        event: step.event,
      };
    } else {
      steps[stepIdValue] = {
        stepId: stepIdValue,
        type: step.type,
        outcome: step.outcome,
      };
    }
  }

  for (const [sourceStepId, step] of Object.entries(normalized.spec.steps)) {
    if (step.outcomes) {
      for (const [outcome, targetStepId] of Object.entries(step.outcomes)) {
        transitions.push({ sourceStepId, outcome, targetStepId });
      }
    } else if (step.next) {
      const transition = { sourceStepId };
      const target = normalized.spec.steps[step.next];
      if (step.type === "wait") transition.outcome = step.event;
      if (target.type === "terminal") transition.outcome = target.outcome;
      transition.targetStepId = step.next;
      transitions.push(transition);
    }
  }

  return normalizeCompiledWorkflowDefinition({
    marker: WORKFLOW_DEFINITION_MARKER,
    workflowDefinitionId: normalized.metadata.id,
    version: "v1",
    trigger: normalized.spec.trigger,
    initialStepId: normalized.spec.initial,
    defaults: { ...defaults },
    steps,
    transitions,
  });
}

function normalizeCompiledChild(value, context, depth) {
  const keys = [
    "operation",
    "worker",
    "inputs",
    "evaluator",
    "orchestrator",
    "maxReworkAttempts",
    "children",
  ];
  exactAllowedKeys(
    value,
    keys.slice(0, 6),
    keys,
    context,
  );
  identifier(value.operation, `${context}.operation`);
  identifier(value.worker, `${context}.worker`);
  identifier(value.evaluator, `${context}.evaluator`);
  identifier(value.orchestrator, `${context}.orchestrator`);
  boundedCount(value.maxReworkAttempts, `${context}.maxReworkAttempts`);
  const normalized = {
    operation: value.operation,
    worker: value.worker,
    inputs: dataMap(value.inputs, `${context}.inputs`),
    evaluator: value.evaluator,
    orchestrator: value.orchestrator,
    maxReworkAttempts: value.maxReworkAttempts,
  };
  if ("children" in value) {
    if (depth >= MAX_TASK_DEFINITION_DEPTH) {
      throw new WorkGraphDefinitionError(
        `compiled children exceed maximum depth ${MAX_TASK_DEFINITION_DEPTH}`,
      );
    }
    exactKeys(value.children, CHILDREN_KEYS, `${context}.children`);
    if (
      value.children.join !== "all" ||
      !object(value.children.tasks) ||
      Object.keys(value.children.tasks).length === 0 ||
      Object.keys(value.children.tasks).length > MAX_TASK_DEFINITION_CHILDREN
    ) {
      throw new WorkGraphDefinitionError(
        `${context}.children must join 1-${MAX_TASK_DEFINITION_CHILDREN} tasks`,
      );
    }
    normalized.children = {
      join: "all",
      tasks: Object.fromEntries(
        Object.entries(value.children.tasks).map(([id, child]) => {
          stepId(id, `${context}.children.tasks key`);
          return [
            id,
            normalizeCompiledChild(
              child,
              `${context}.children.tasks.${id}`,
              depth + 1,
            ),
          ];
        }),
      ),
    };
  }
  return normalized;
}

function normalizeCompiledStep(id, value) {
  stepId(id, "compiled step key");
  if (!object(value) || value.stepId !== id) {
    throw new WorkGraphDefinitionError(
      `compiled step '${id}' must carry its direct stepId`,
    );
  }
  if (value.type === "task") {
    exactKeys(value, ["stepId", "type", "task"], `compiled step '${id}'`);
    const taskKeys = [
      "taskDefinitionId",
      "operation",
      "worker",
      "inputs",
      "evaluator",
      "orchestrator",
      "maxReworkAttempts",
      "children",
    ];
    exactAllowedKeys(
      value.task,
      taskKeys.slice(0, 7),
      taskKeys,
      `compiled step '${id}'.task`,
    );
    if (value.task.taskDefinitionId !== id) {
      throw new WorkGraphDefinitionError(
        `compiled step '${id}' taskDefinitionId must equal its stepId`,
      );
    }
    const childShape = { ...value.task };
    delete childShape.taskDefinitionId;
    return {
      stepId: id,
      type: "task",
      task: {
        taskDefinitionId: id,
        ...normalizeCompiledChild(
          childShape,
          `compiled step '${id}'.task`,
          0,
        ),
      },
    };
  }
  if (value.type === "wait") {
    exactKeys(value, ["stepId", "type", "event"], `compiled step '${id}'`);
    if (value.event !== "root-issue-commented") {
      throw new WorkGraphDefinitionError(
        `compiled step '${id}'.event must be root-issue-commented`,
      );
    }
    return { stepId: id, type: "wait", event: value.event };
  }
  if (value.type === "terminal") {
    exactKeys(value, ["stepId", "type", "outcome"], `compiled step '${id}'`);
    if (!["completed", "error", "ignored"].includes(value.outcome)) {
      throw new WorkGraphDefinitionError(
        `compiled step '${id}' has an invalid terminal outcome`,
      );
    }
    return { stepId: id, type: "terminal", outcome: value.outcome };
  }
  throw new WorkGraphDefinitionError(
    `compiled step '${id}'.type must be task, wait, or terminal`,
  );
}

export function normalizeCompiledWorkflowDefinition(definition) {
  exactKeys(
    definition,
    COMPILED_DEFINITION_KEYS,
    "compiled workflow definition",
  );
  if (definition.marker !== WORKFLOW_DEFINITION_MARKER) {
    throw new WorkGraphDefinitionError(
      `compiled workflow marker must be ${WORKFLOW_DEFINITION_MARKER}`,
    );
  }
  identifier(
    definition.workflowDefinitionId,
    "compiled workflow workflowDefinitionId",
  );
  if (definition.version !== "v1" || definition.trigger !== "workgraph") {
    throw new WorkGraphDefinitionError(
      "compiled workflow must use version v1 and trigger workgraph",
    );
  }
  exactKeys(definition.defaults, WORKFLOW_DEFAULT_KEYS, "compiled defaults");
  identifier(definition.defaults.evaluator, "compiled defaults.evaluator");
  identifier(definition.defaults.orchestrator, "compiled defaults.orchestrator");
  boundedCount(
    definition.defaults.maxReworkAttempts,
    "compiled defaults.maxReworkAttempts",
  );
  if (!object(definition.steps) || !Array.isArray(definition.transitions)) {
    throw new WorkGraphDefinitionError(
      "compiled workflow steps must be a map and transitions an array",
    );
  }
  const steps = Object.fromEntries(
    Object.entries(definition.steps).map(([id, step]) => [
      id,
      normalizeCompiledStep(id, step),
    ]),
  );
  if (!(definition.initialStepId in steps)) {
    throw new WorkGraphDefinitionError(
      "compiled workflow initialStepId must reference a step",
    );
  }
  const transitions = definition.transitions.map((transition, index) => {
    const context = `compiled transition[${index}]`;
    exactAllowedKeys(
      transition,
      ["sourceStepId", "targetStepId"],
      ["sourceStepId", "outcome", "targetStepId"],
      context,
    );
    for (const field of ["sourceStepId", "targetStepId"]) {
      stepId(transition[field], `${context}.${field}`);
      if (!(transition[field] in steps)) {
        throw new WorkGraphDefinitionError(
          `${context}.${field} must reference a compiled step`,
        );
      }
    }
    if (steps[transition.sourceStepId].type === "terminal") {
      throw new WorkGraphDefinitionError(
        `${context} cannot leave a terminal step`,
      );
    }
    const needsOutcome =
      steps[transition.sourceStepId].type === "wait" ||
      steps[transition.targetStepId].type === "terminal";
    if ("outcome" in transition) {
      identifier(transition.outcome, `${context}.outcome`);
    } else if (needsOutcome) {
      throw new WorkGraphDefinitionError(
        `${context} must preserve the wait or terminal outcome`,
      );
    }
    if (
      steps[transition.sourceStepId].type === "wait" &&
      transition.outcome !== steps[transition.sourceStepId].event
    ) {
      throw new WorkGraphDefinitionError(
        `${context} must preserve the wait event as its outcome`,
      );
    }
    if (
      steps[transition.targetStepId].type === "terminal" &&
      transition.outcome !== steps[transition.targetStepId].outcome
    ) {
      throw new WorkGraphDefinitionError(
        `${context} must preserve the terminal outcome`,
      );
    }
    const normalizedTransition = {
      sourceStepId: transition.sourceStepId,
    };
    if ("outcome" in transition) {
      normalizedTransition.outcome = transition.outcome;
    }
    normalizedTransition.targetStepId = transition.targetStepId;
    return normalizedTransition;
  });
  const transitionKeys = transitions.map(
    ({ sourceStepId, outcome }) => `${sourceStepId}\0${outcome ?? ""}`,
  );
  if (new Set(transitionKeys).size !== transitionKeys.length) {
    throw new WorkGraphDefinitionError(
      "compiled workflow repeats a source/outcome transition",
    );
  }
  for (const [id, step] of Object.entries(steps)) {
    const count = transitions.filter(
      ({ sourceStepId }) => sourceStepId === id,
    ).length;
    if (step.type === "terminal" ? count !== 0 : count === 0) {
      throw new WorkGraphDefinitionError(
        `compiled step '${id}' has an invalid transition count`,
      );
    }
  }
  const graphSteps = Object.fromEntries(
    Object.entries(steps).map(([id, step]) => [
      id,
      step.type === "terminal"
        ? { type: "terminal", outcome: step.outcome }
        : {
            type: step.type,
            outcomes: Object.fromEntries(
              transitions
                .filter(({ sourceStepId }) => sourceStepId === id)
                .map((transition, index) => [
                  transition.outcome ?? `next-${index}`,
                  transition.targetStepId,
                ]),
            ),
          },
    ]),
  );
  validateWorkflowGraph(definition.initialStepId, graphSteps);
  return {
    marker: definition.marker,
    workflowDefinitionId: definition.workflowDefinitionId,
    version: definition.version,
    trigger: definition.trigger,
    initialStepId: definition.initialStepId,
    defaults: { ...definition.defaults },
    steps,
    transitions,
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
  if (!["accepted", "rejected"].includes(value.verdict)) {
    throw new WorkGraphDefinitionError(
      "task evaluation verdict must be accepted or rejected",
    );
  }
  nonEmptyText(value.summary, "task evaluation summary");
  if (typeof value.feedback !== "string" || !ordinaryText(value.feedback)) {
    throw new WorkGraphDefinitionError(
      "task evaluation feedback must be ordinary text",
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
  const expectedKeys = value.action === "advance"
    ? value.targetTaskDefinitionId === undefined
      ? [...ROUTE_BASE_KEYS, "outcome", "targetStepId"]
      : ROUTE_ADVANCE_KEYS
    : ROUTE_BASE_KEYS;
  exactKeys(value, expectedKeys, "task route");
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
  boundedCount(value.attempt, "task route attempt");
  if (value.action === "advance") {
    identifier(value.outcome, "task route outcome");
    stepId(value.targetStepId, "task route targetStepId");
    if ("targetTaskDefinitionId" in value) {
      identifier(
        value.targetTaskDefinitionId,
        "task route targetTaskDefinitionId",
      );
      if (value.targetTaskDefinitionId !== value.targetStepId) {
        throw new WorkGraphDefinitionError(
          "task route task target must bind matching step and task definition IDs",
        );
      }
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
    normalized.outcome = value.outcome;
    normalized.targetStepId = value.targetStepId;
    if ("targetTaskDefinitionId" in value) {
      normalized.targetTaskDefinitionId = value.targetTaskDefinitionId;
    }
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

export function validateTaskRouteAgainstDefinition(value, definition) {
  const route = normalizeTaskRoute(value);
  const workflow = normalizeCompiledWorkflowDefinition(definition);
  if (route.action !== "advance") return route;
  const target = workflow.steps[route.targetStepId];
  if (!target) {
    throw new WorkGraphDefinitionError(
      "task route targetStepId must reference a compiled step",
    );
  }
  if (target.type === "task") {
    if (route.targetTaskDefinitionId !== target.task.taskDefinitionId) {
      throw new WorkGraphDefinitionError(
        "task route to a task requires its targetTaskDefinitionId",
      );
    }
  } else if ("targetTaskDefinitionId" in route) {
    throw new WorkGraphDefinitionError(
      "task route targetTaskDefinitionId is forbidden for wait and terminal steps",
    );
  }
  if (
    !workflow.transitions.some(
      (transition) =>
        transition.targetStepId === route.targetStepId &&
        transition.outcome === route.outcome,
    )
  ) {
    throw new WorkGraphDefinitionError(
      "task route outcome and targetStepId must match a compiled transition",
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
  boundedCount(current.attempt, "rework attempt");
  boundedCount(maxReworkAttempts, "rework maximum");
  if (current.attempt >= maxReworkAttempts) {
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
