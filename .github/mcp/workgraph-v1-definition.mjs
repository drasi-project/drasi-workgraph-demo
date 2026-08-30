import { isDeepStrictEqual, TextEncoder } from "node:util";

export const WORKFLOW_DEFINITION_MARKER = "WorkGraphWorkflowDefinition/v1";
export const RUNTIME_TASK_MARKER = "WorkGraphTask/v1";
export const TASK_EVALUATION_MARKER = "WorkGraphTaskEvaluate/v1";
export const TASK_ROUTE_MARKER = "WorkGraphTaskRoute/v1";
export const WORKFLOW_AUTHORING_API_VERSION = "workgraph.drasi.io/v1";
export const DEFAULT_MAX_REWORK = 3;
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
const WORKFLOW_SPEC_KEYS = [
  "trigger",
  "initial",
  "defaults",
  "steps",
  "terminals",
];
const WORKFLOW_DEFAULT_KEYS = [
  "evaluator",
  "orchestrator",
  "maxRework",
  "rework",
];
const REWORK_KEYS = ["task", "assignment", "attempt"];
const STEP_KEYS = [
  "name",
  "type",
  "operation",
  "agent",
  "next",
  "evaluator",
  "orchestrator",
  "maxRework",
  "outcomes",
  "children",
  "join",
];
const CHILD_KEYS = ["id", "name", "operation", "agent"];
const OUTCOME_KEYS = ["outcome", "verdict", "target"];
const WAIT_KEYS = ["waitFor", "where", "target"];
const WAIT_WHERE_KEYS = ["rootIssue", "authorType"];
const JOIN_KEYS = ["mode", "require", "coordinator"];
const TERMINAL_KEYS = ["status"];
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
  if (typeof value !== "string" || !/^[A-Z](?:-[a-z][a-z0-9-]*)?$/.test(value)) {
    throw new WorkGraphDefinitionError(
      `${context} must be an uppercase step ID with an optional semantic suffix`,
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

function normalizeWait(value, context, stepIds) {
  exactKeys(value, WAIT_KEYS, context);
  if (value.waitFor !== "root-issue-comment") {
    throw new WorkGraphDefinitionError(
      `${context}.waitFor must be root-issue-comment`,
    );
  }
  exactKeys(value.where, WAIT_WHERE_KEYS, `${context}.where`);
  if (
    value.where.rootIssue !== true ||
    value.where.authorType !== "non-agent-human"
  ) {
    throw new WorkGraphDefinitionError(
      `${context} must qualify a non-agent-human Root Issue comment`,
    );
  }
  stepId(value.target, `${context}.target`);
  stepIds.references.push([value.target, `${context}.target`]);
  return {
    waitFor: value.waitFor,
    where: {
      rootIssue: true,
      authorType: value.where.authorType,
    },
    target: value.target,
  };
}

function normalizeWorkflowStep(id, value, stepIds) {
  stepId(id, `workflow step '${id}'`);
  exactAllowedKeys(
    value,
    ["name", "type", "operation", "agent"],
    STEP_KEYS,
    `workflow step '${id}'`,
  );
  if (value.type !== "task") {
    throw new WorkGraphDefinitionError(`workflow step '${id}'.type must be task`);
  }
  identifier(value.name, `workflow step '${id}'.name`);
  identifier(value.operation, `workflow step '${id}'.operation`);
  identifier(value.agent, `workflow step '${id}'.agent`);

  const normalized = {
    name: value.name,
    type: value.type,
    operation: value.operation,
    agent: value.agent,
  };
  if (!("next" in value) && !("outcomes" in value)) {
    throw new WorkGraphDefinitionError(
      `workflow step '${id}' requires next or outcomes`,
    );
  }
  if ("next" in value && "outcomes" in value) {
    throw new WorkGraphDefinitionError(
      `workflow step '${id}' cannot declare both next and outcomes`,
    );
  }
  if (typeof value.next === "string") {
    if (!stepIds.terminals.has(value.next)) {
      stepId(value.next, `workflow step '${id}'.next`);
      stepIds.references.push([value.next, `workflow step '${id}'.next`]);
    }
    normalized.next = value.next;
  } else if ("next" in value) {
    normalized.next = normalizeWait(
      value.next,
      `workflow step '${id}'.next`,
      stepIds,
    );
  }

  for (const role of ["evaluator", "orchestrator"]) {
    if (role in value) {
      identifier(value[role], `workflow step '${id}'.${role}`);
      normalized[role] = value[role];
    }
  }
  if ("maxRework" in value) {
    if (!Number.isInteger(value.maxRework) || value.maxRework < 0) {
      throw new WorkGraphDefinitionError(
        `workflow step '${id}'.maxRework must be a non-negative integer`,
      );
    }
    normalized.maxRework = value.maxRework;
  }

  if ("outcomes" in value) {
    if (!Array.isArray(value.outcomes) || value.outcomes.length < 1) {
      throw new WorkGraphDefinitionError(
        `workflow step '${id}'.outcomes must be a non-empty array`,
      );
    }
    const outcomes = new Set();
    normalized.outcomes = value.outcomes.map((outcome, index) => {
      const context = `workflow step '${id}'.outcomes[${index}]`;
      exactKeys(outcome, OUTCOME_KEYS, context);
      identifier(outcome.outcome, `${context}.outcome`);
      if (outcome.verdict !== "accepted") {
        throw new WorkGraphDefinitionError(
          `${context}.verdict must be accepted for a business outcome`,
        );
      }
      if (outcomes.has(outcome.outcome)) {
        throw new WorkGraphDefinitionError(
          `workflow step '${id}' repeats outcome '${outcome.outcome}'`,
        );
      }
      outcomes.add(outcome.outcome);
      stepId(outcome.target, `${context}.target`);
      stepIds.references.push([outcome.target, `${context}.target`]);
      return {
        outcome: outcome.outcome,
        verdict: outcome.verdict,
        target: outcome.target,
      };
    });
  }

  if ("children" in value) {
    if (!Array.isArray(value.children) || value.children.length < 1) {
      throw new WorkGraphDefinitionError(
        `workflow step '${id}'.children must be a non-empty array`,
      );
    }
    const childIds = new Set();
    normalized.children = value.children.map((child, index) => {
      const context = `workflow step '${id}'.children[${index}]`;
      exactKeys(child, CHILD_KEYS, context);
      stepId(child.id, `${context}.id`);
      if (childIds.has(child.id) || stepIds.ids.has(child.id)) {
        throw new WorkGraphDefinitionError(
          `workflow repeats step ID '${child.id}'`,
        );
      }
      childIds.add(child.id);
      stepIds.ids.add(child.id);
      identifier(child.name, `${context}.name`);
      identifier(child.operation, `${context}.operation`);
      identifier(child.agent, `${context}.agent`);
      return { ...child };
    });
    if (!("join" in value)) {
      throw new WorkGraphDefinitionError(
        `workflow step '${id}' with children requires join`,
      );
    }
    exactKeys(value.join, JOIN_KEYS, `workflow step '${id}'.join`);
    if (
      value.join.mode !== "all" ||
      value.join.require !== "accepted" ||
      value.join.coordinator !== "after-children"
    ) {
      throw new WorkGraphDefinitionError(
        `workflow step '${id}'.join must require all children accepted before its coordinator`,
      );
    }
    normalized.join = { ...value.join };
  } else if ("join" in value) {
    throw new WorkGraphDefinitionError(
      `workflow step '${id}' cannot join without children`,
    );
  }
  return normalized;
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
  if (
    !Number.isInteger(workflow.spec.defaults.maxRework) ||
    workflow.spec.defaults.maxRework !== DEFAULT_MAX_REWORK
  ) {
    throw new WorkGraphDefinitionError(
      `workflow defaults.maxRework must be ${DEFAULT_MAX_REWORK}`,
    );
  }
  exactKeys(workflow.spec.defaults.rework, REWORK_KEYS, "workflow defaults.rework");
  if (
    workflow.spec.defaults.rework.task !== "same" ||
    workflow.spec.defaults.rework.assignment !== "same" ||
    workflow.spec.defaults.rework.attempt !== "fresh"
  ) {
    throw new WorkGraphDefinitionError(
      "rework must keep the same task and assignment and create a fresh attempt",
    );
  }
  if (!object(workflow.spec.steps) || !object(workflow.spec.terminals)) {
    throw new WorkGraphDefinitionError(
      "issue workflow steps and terminals must be objects",
    );
  }

  const terminalEntries = Object.entries(workflow.spec.terminals);
  const terminals = new Set(terminalEntries.map(([id]) => id));
  if (
    !isDeepStrictEqual([...terminals].sort(), ["completed", "ignored"])
  ) {
    throw new WorkGraphDefinitionError(
      "issue workflow terminals must be exactly completed and ignored",
    );
  }
  const normalizedTerminals = {};
  for (const [id, terminal] of terminalEntries) {
    identifier(id, `workflow terminal '${id}'`);
    exactKeys(terminal, TERMINAL_KEYS, `workflow terminal '${id}'`);
    if (terminal.status !== id) {
      throw new WorkGraphDefinitionError(
        `workflow terminal '${id}'.status must equal its ID`,
      );
    }
    normalizedTerminals[id] = { status: terminal.status };
  }

  const entries = Object.entries(workflow.spec.steps);
  const ids = new Set(entries.map(([id]) => id));
  if (!ids.has(workflow.spec.initial)) {
    throw new WorkGraphDefinitionError(
      "issue workflow initial must reference a declared step",
    );
  }
  const tracking = { ids: new Set(ids), terminals, references: [] };
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
        maxRework: workflow.spec.defaults.maxRework,
        rework: { ...workflow.spec.defaults.rework },
      },
      steps: normalizedSteps,
      terminals: normalizedTerminals,
    },
  };
}

export function normalizeTaskEvaluation(value) {
  exactKeys(value, EVALUATION_KEYS, "task evaluation");
  for (const field of [
    "evaluationId",
    "rootIssueId",
    "workflowRunId",
    "taskId",
    "resultId",
  ]) {
    directId(value[field], `task evaluation ${field}`);
  }
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
  return { ...value };
}

export function formatTaskEvaluation(value) {
  const normalized = normalizeTaskEvaluation(value);
  return `${TASK_EVALUATION_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
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
  const expectedKeys =
    value.action === "advance"
      ? [...ROUTE_BASE_KEYS, "outcome", "target"]
      : ROUTE_BASE_KEYS;
  exactKeys(value, expectedKeys, "task route");
  for (const field of [
    "routeId",
    "rootIssueId",
    "workflowRunId",
    "taskId",
    "resultId",
    "evaluationId",
  ]) {
    directId(value[field], `task route ${field}`);
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
  if (!Number.isInteger(value.attempt) || value.attempt < 0) {
    throw new WorkGraphDefinitionError(
      "task route attempt must be a non-negative integer",
    );
  }
  if (value.action === "advance") {
    identifier(value.outcome, "task route outcome");
    stepId(value.target, "task route target");
  }
  return { ...value };
}

export function formatTaskRoute(value) {
  const normalized = normalizeTaskRoute(value);
  return `${TASK_ROUTE_MARKER}\n\n\`\`\`json\n${prettyJson(normalized)}\n\`\`\`\n`;
}

export function parseTaskRoute(body) {
  return parseCanonicalBody(body, TASK_ROUTE_MARKER, formatTaskRoute);
}

export function nextReworkAttempt(current, maxRework = DEFAULT_MAX_REWORK) {
  exactKeys(current, ["taskId", "assignmentId", "attempt"], "rework attempt");
  directId(current.taskId, "rework attempt taskId");
  directId(current.assignmentId, "rework attempt assignmentId");
  if (
    !Number.isInteger(current.attempt) ||
    current.attempt < 0 ||
    !Number.isInteger(maxRework) ||
    maxRework < 0
  ) {
    throw new WorkGraphDefinitionError(
      "rework attempt and maximum must be non-negative integers",
    );
  }
  if (current.attempt >= maxRework) {
    throw new WorkGraphDefinitionError(
      `rework exceeds maximum of ${maxRework} attempts`,
    );
  }
  return {
    taskId: current.taskId,
    assignmentId: current.assignmentId,
    attempt: current.attempt + 1,
  };
}
