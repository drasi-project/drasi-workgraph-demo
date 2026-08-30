import { isDeepStrictEqual, TextEncoder } from "node:util";

export const WORKFLOW_DEFINITION_MARKER = "WorkGraphWorkflowDefinition/v1";
export const RUNTIME_TASK_MARKER = "WorkGraphTask/v1";
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
