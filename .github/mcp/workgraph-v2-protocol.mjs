import { isDeepStrictEqual, TextEncoder } from "node:util";

const TASK_MARKER = "WorkGraphTask/v2";
const ASSIGNMENT_MARKER = "WorkGraphTaskAssignment/v1";
const RESULT_MARKER = "WorkGraphTaskResult/v1";
const RESERVED_MARKERS = [
  "WorkGraphTask/v1",
  TASK_MARKER,
  ASSIGNMENT_MARKER,
  RESULT_MARKER,
  "WorkGraphTaskFeedback/v1",
  "WorkGraphTaskResultAcceptance/v1",
  "WorkGraphInfoRequest/v1",
  "WorkGraphInfoRequest/v2",
];
const MAX_ID = 256;
const MAX_AGENT_ID = 64;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 4096;
const MAX_DATA_DEPTH = 32;
const OUTCOMES = new Set(["succeeded", "failed", "blocked"]);
const REQUIRED_INPUT_KEYS = [
  "workflowId",
  "workflowRunId",
  "stepId",
  "definitionCommit",
  "definitionDigest",
  "generation",
  "operation",
  "agent",
  "inputs",
];
const OPTIONAL_INPUT_KEYS = [
  "branchId",
  "join",
  "expectedChildCount",
  "children",
];

class WorkGraphV2ProtocolError extends Error {}

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!object(value)) {
    throw new WorkGraphV2ProtocolError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new WorkGraphV2ProtocolError(
      `${label} properties must be exactly ${expected.join(", ")}`,
    );
  }
}

function exactAllowed(value, required, optional, label) {
  if (!object(value)) {
    throw new WorkGraphV2ProtocolError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter(
    (key) => !required.includes(key) && !optional.includes(key),
  );
  if (missing.length || unknown.length) {
    throw new WorkGraphV2ProtocolError(
      `${label} has missing [${missing.join(", ")}] or unknown [${unknown.join(", ")}] properties`,
    );
  }
}

function agentIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_AGENT_ID ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new WorkGraphV2ProtocolError(
      `${label} must contain 1-64 ASCII letters, digits, '.', '_', or '-'`,
    );
  }
}

function opaque(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_ID ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new WorkGraphV2ProtocolError(
      `${label} must be a bounded non-whitespace identifier`,
    );
  }
}

function digest(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new WorkGraphV2ProtocolError(
      `${label} must be sha256:<64 lowercase hex>`,
    );
  }
}

function ordinaryDataString(value) {
  return (
    !value.includes("\r") &&
    !value.includes("```") &&
    !RESERVED_MARKERS.some((marker) => value.includes(marker))
  );
}

function canonicalData(value, label = "value", depth = 0) {
  if (depth > MAX_DATA_DEPTH) {
    throw new WorkGraphV2ProtocolError(
      `${label} must not exceed ${MAX_DATA_DEPTH} nested levels`,
    );
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (!ordinaryDataString(value)) {
      throw new WorkGraphV2ProtocolError(
        `${label} strings must be ordinary LF text`,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkGraphV2ProtocolError(`${label} numbers must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalData(entry, `${label}[${index}]`, depth + 1),
    );
  }
  if (!object(value)) {
    throw new WorkGraphV2ProtocolError(`${label} must contain only JSON values`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key === "" || !ordinaryDataString(key))) {
    throw new WorkGraphV2ProtocolError(
      `${label} property names must be non-empty ordinary LF text`,
    );
  }
  return Object.fromEntries(
    keys
      .sort()
      .map((key) => [
        key,
        canonicalData(value[key], `${label}.${key}`, depth + 1),
      ]),
  );
}

function normalizeChild(child, index) {
  exact(child, ["branchId", "operation", "agent", "inputs"], `children[${index}]`);
  agentIdentifier(child.branchId, `children[${index}].branchId`);
  agentIdentifier(child.operation, `children[${index}].operation`);
  agentIdentifier(child.agent, `children[${index}].agent`);
  if (!object(child.inputs)) {
    throw new WorkGraphV2ProtocolError(`children[${index}].inputs must be an object`);
  }
  return {
    branchId: child.branchId,
    operation: child.operation,
    agent: child.agent,
    inputs: canonicalData(child.inputs, `children[${index}].inputs`),
  };
}

function normalizeInputs(inputs) {
  exactAllowed(
    inputs,
    REQUIRED_INPUT_KEYS,
    OPTIONAL_INPUT_KEYS,
    "task.inputs",
  );
  agentIdentifier(inputs.workflowId, "task.inputs.workflowId");
  opaque(inputs.workflowRunId, "task.inputs.workflowRunId");
  agentIdentifier(inputs.stepId, "task.inputs.stepId");
  opaque(inputs.definitionCommit, "task.inputs.definitionCommit");
  digest(inputs.definitionDigest, "task.inputs.definitionDigest");
  if (!Number.isSafeInteger(inputs.generation) || inputs.generation <= 0) {
    throw new WorkGraphV2ProtocolError(
      "task.inputs.generation must be a positive safe integer",
    );
  }
  agentIdentifier(inputs.operation, "task.inputs.operation");
  agentIdentifier(inputs.agent, "task.inputs.agent");
  if (!object(inputs.inputs)) {
    throw new WorkGraphV2ProtocolError("task.inputs.inputs must be an object");
  }
  if (inputs.branchId !== undefined) {
    agentIdentifier(inputs.branchId, "task.inputs.branchId");
  }

  const hasJoin = inputs.join !== undefined;
  const hasCount = inputs.expectedChildCount !== undefined;
  const hasChildren = inputs.children !== undefined;
  if (hasJoin || hasCount || hasChildren) {
    if (!(hasJoin && hasCount && hasChildren)) {
      throw new WorkGraphV2ProtocolError(
        "task.inputs join, expectedChildCount, and children must appear together",
      );
    }
    if (inputs.join !== "all") {
      throw new WorkGraphV2ProtocolError("task.inputs.join must be all");
    }
    if (
      !Number.isSafeInteger(inputs.expectedChildCount) ||
      inputs.expectedChildCount < 2
    ) {
      throw new WorkGraphV2ProtocolError(
        "task.inputs.expectedChildCount must be at least two",
      );
    }
    if (
      !Array.isArray(inputs.children) ||
      inputs.children.length !== inputs.expectedChildCount
    ) {
      throw new WorkGraphV2ProtocolError(
        "task.inputs.children length must equal expectedChildCount",
      );
    }
  }

  const normalized = {
    workflowId: inputs.workflowId,
    workflowRunId: inputs.workflowRunId,
    stepId: inputs.stepId,
    definitionCommit: inputs.definitionCommit,
    definitionDigest: inputs.definitionDigest,
    generation: inputs.generation,
    operation: inputs.operation,
    agent: inputs.agent,
    inputs: canonicalData(inputs.inputs, "task.inputs.inputs"),
  };
  if (inputs.branchId !== undefined) normalized.branchId = inputs.branchId;
  if (hasJoin) {
    if (inputs.branchId !== undefined) {
      throw new WorkGraphV2ProtocolError(
        "composite task branchId must be absent",
      );
    }
    const children = inputs.children.map(normalizeChild);
    const branchIds = new Set(children.map((child) => child.branchId));
    const agents = new Set(children.map((child) => child.agent));
    if (branchIds.size !== children.length) {
      throw new WorkGraphV2ProtocolError(
        "task.inputs.children branchId values must be unique",
      );
    }
    if (agents.size !== children.length) {
      throw new WorkGraphV2ProtocolError(
        "task.inputs.children agent values must be unique",
      );
    }
    if (agents.has(inputs.agent)) {
      throw new WorkGraphV2ProtocolError(
        "composite task agent must differ from every child agent",
      );
    }
    normalized.join = "all";
    normalized.expectedChildCount = inputs.expectedChildCount;
    normalized.children = children;
  }
  return normalized;
}

function fenced(marker, language, payload) {
  return `${marker}\n\n\`\`\`${language}\n${payload}\n\`\`\`\n`;
}

export function formatWorkflowTask(task) {
  exact(task, ["taskType", "inputs"], "task");
  if (task.taskType !== "workflow-task") {
    throw new WorkGraphV2ProtocolError("task.taskType must be workflow-task");
  }
  const inputs = normalizeInputs(task.inputs);
  const body = fenced(
    TASK_MARKER,
    "yaml",
    `taskType: workflow-task\ninputs: ${JSON.stringify(inputs, null, 2)}`,
  );
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new WorkGraphV2ProtocolError(
      `WorkGraphTask/v2 body must not exceed ${MAX_BODY_BYTES} bytes`,
    );
  }
  return body;
}

export function parseWorkflowTask(body) {
  if (
    typeof body !== "string" ||
    body.includes("\r") ||
    new TextEncoder().encode(body).length > MAX_BODY_BYTES
  ) {
    throw new WorkGraphV2ProtocolError("WorkGraphTask/v2 body is not canonical");
  }
  const match = body.match(
    /^WorkGraphTask\/v2\n\n```yaml\ntaskType: workflow-task\ninputs: (\{[\s\S]+\})\n```\n$/,
  );
  if (!match) {
    throw new WorkGraphV2ProtocolError("WorkGraphTask/v2 body is not canonical");
  }
  let inputs;
  try {
    inputs = JSON.parse(match[1]);
  } catch {
    throw new WorkGraphV2ProtocolError("WorkGraphTask/v2 inputs are not JSON-compatible YAML");
  }
  const task = { taskType: "workflow-task", inputs };
  if (body !== formatWorkflowTask(task)) {
    throw new WorkGraphV2ProtocolError("WorkGraphTask/v2 body is not canonical");
  }
  return task;
}

export function validateParallelTaskFamily(parentTask, childTasks) {
  const parent = parseWorkflowTask(formatWorkflowTask(parentTask));
  if (
    parent.inputs.join !== "all" ||
    !Array.isArray(parent.inputs.children)
  ) {
    throw new WorkGraphV2ProtocolError("parent task must define an all-of join");
  }
  if (!Array.isArray(childTasks)) {
    throw new WorkGraphV2ProtocolError("childTasks must be an array");
  }
  if (childTasks.length !== parent.inputs.expectedChildCount) {
    throw new WorkGraphV2ProtocolError(
      "observed child count must equal expectedChildCount",
    );
  }

  const expected = new Map(
    parent.inputs.children.map((child) => [child.branchId, child]),
  );
  const observed = new Set();
  for (const rawChild of childTasks) {
    const child = parseWorkflowTask(formatWorkflowTask(rawChild));
    const branchId = child.inputs.branchId;
    if (!branchId || observed.has(branchId) || !expected.has(branchId)) {
      throw new WorkGraphV2ProtocolError(
        "child branchId values must be expected and unique",
      );
    }
    observed.add(branchId);
    validateWorkflowChildTask(parent, child);
  }
  return true;
}

export function validateWorkflowChildTask(parentTask, childTask) {
  const parent = parseWorkflowTask(formatWorkflowTask(parentTask));
  const child = parseWorkflowTask(formatWorkflowTask(childTask));
  if (
    parent.inputs.join !== "all" ||
    !Array.isArray(parent.inputs.children)
  ) {
    throw new WorkGraphV2ProtocolError("parent task must define an all-of join");
  }
  const branchId = child.inputs.branchId;
  const manifest = parent.inputs.children.find(
    (candidate) => candidate.branchId === branchId,
  );
  if (!branchId || !manifest) {
    throw new WorkGraphV2ProtocolError(
      "child branchId must appear in its parent manifest",
    );
  }
  for (const field of [
    "workflowId",
    "workflowRunId",
    "stepId",
    "definitionCommit",
    "definitionDigest",
    "generation",
  ]) {
    if (child.inputs[field] !== parent.inputs[field]) {
      throw new WorkGraphV2ProtocolError(
        `child ${branchId} ${field} must match its parent`,
      );
    }
  }
  if (
    child.inputs.join !== undefined ||
    child.inputs.operation !== manifest.operation ||
    child.inputs.agent !== manifest.agent ||
    !isDeepStrictEqual(child.inputs.inputs, manifest.inputs)
  ) {
    throw new WorkGraphV2ProtocolError(
      `child ${branchId} must match its parent manifest`,
    );
  }
  return child;
}

function normalizeResult(value) {
  exact(
    value,
    ["taskType", "leaseId", "outcome", "summary", "result"],
    "Result",
  );
  if (value.taskType !== "workflow-task") {
    throw new WorkGraphV2ProtocolError("Result.taskType must be workflow-task");
  }
  opaque(value.leaseId, "Result.leaseId");
  if (!OUTCOMES.has(value.outcome)) {
    throw new WorkGraphV2ProtocolError(
      "Result.outcome must be succeeded, failed, or blocked",
    );
  }
  if (
    typeof value.summary !== "string" ||
    value.summary.trim() === "" ||
    !ordinaryDataString(value.summary)
  ) {
    throw new WorkGraphV2ProtocolError(
      "Result.summary must be non-empty ordinary LF text",
    );
  }
  if (new TextEncoder().encode(value.summary).length > MAX_TEXT_BYTES) {
    throw new WorkGraphV2ProtocolError(
      `Result.summary must not exceed ${MAX_TEXT_BYTES} bytes`,
    );
  }
  if (!object(value.result) || Object.keys(value.result).length === 0) {
    throw new WorkGraphV2ProtocolError("Result.result must be a non-empty object");
  }
  return {
    taskType: "workflow-task",
    leaseId: value.leaseId,
    outcome: value.outcome,
    summary: value.summary,
    result: canonicalData(value.result, "Result.result"),
  };
}

export function formatWorkflowResult(value) {
  const body = fenced(
    RESULT_MARKER,
    "json",
    JSON.stringify(normalizeResult(value), null, 2),
  );
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new WorkGraphV2ProtocolError(
      `workflow Result body must not exceed ${MAX_BODY_BYTES} bytes`,
    );
  }
  return body;
}

export function parseWorkflowResult(body) {
  if (
    typeof body !== "string" ||
    body.includes("\r") ||
    new TextEncoder().encode(body).length > MAX_BODY_BYTES
  ) {
    return null;
  }
  const match = body.match(
    /^WorkGraphTaskResult\/v1\n\n```json\n(\{[\s\S]+\})\n```\n$/,
  );
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return body === formatWorkflowResult(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatWorkflowAssignment(agentId) {
  agentIdentifier(agentId, "Assignment.agentId");
  return fenced(
    ASSIGNMENT_MARKER,
    "json",
    JSON.stringify({ agentId }, null, 2),
  );
}

export function parseWorkflowAssignment(body) {
  if (typeof body !== "string" || body.includes("\r")) return null;
  const match = body.match(
    /^WorkGraphTaskAssignment\/v1\n\n```json\n(\{[\s\S]+\})\n```\n$/,
  );
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    exact(value, ["agentId"], "Assignment");
    return body === formatWorkflowAssignment(value.agentId) ? value : null;
  } catch {
    return null;
  }
}
