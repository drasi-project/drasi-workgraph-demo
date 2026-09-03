# WorkGraph v1 reporter

`.github/mcp/workgraph-reporter.mjs` is the testbed's narrow MCP boundary for
worker and lifecycle reporting. It exposes exactly five tools:

| Tool | Purpose | GitHub write |
|---|---|---|
| `get_root_issue` | Verify a worker task, its Root Task, and the immutable Root Issue snapshot | No |
| `submit_task_result` | Verify a task, Dispatch, and active Lease, then create or reconcile its Result | One comment when absent |
| `get_task_snapshot` | Verify the current Dispatch, Result, direct identities, attempt, and effective compiled lifecycle policy | No |
| `submit_task_evaluation` | Create or reconcile the current Result's canonical Evaluation | One comment when absent |
| `submit_task_route` | Create or reconcile an authorized Route for the current Evaluation | One comment when absent |

The reporter is fixed to `drasi-project/drasi-workgraph-demo`. It rejects
unknown arguments, unexpected Issue identities, foreign actors, noncanonical
bodies, duplicate protocol comments, a missing exact `workgraph` admission label,
closed task ancestry for new work, changed Root Issue content, stale Leases, and
conflicting retries.

Lifecycle tools pin the committed compiled fixtures in
`.github/workgraph/fixtures/v1/` (`issue-lifecycle`, `fork-join-lifecycle`,
`mixed-control-flow`, and `scoped-control-flow`). They resolve the
task's source step and effective evaluator, orchestrator, and rework maximum
from that compiled definition. They require the latest immutable Dispatch and
its exact canonical Result, derive the canonical TaskResult envelope digest,
and verify direct
Root Issue, run, task, Result, and Evaluation identities, including required
`taskKey` and `operation` context. Accepted Evaluations
have empty feedback; rejected Evaluations require actionable feedback. The
Evaluation and Route carry the same one-based attempt; `reworkCount` is
`attempt - 1`.

The Route writer accepts only actions enabled by the verdict, rework bound,
fixed runtime exclusion policy, and exact compiled transition resolved from
the Result. Advance carries the transition kind and target
step/kind, outcome only for an outcome edge, and a hashed task-definition ID
only for task targets. Rework returns the same task and assignment with the
next bounded attempt and the Evaluation feedback. No lifecycle tool mutates the
Root Issue, creates or closes a task, or performs any effect beyond its one
canonical comment.

Evaluation and Route writes use a deterministic lifecycle claim identity.
Identical concurrent calls in one reporter process share the write and
reconcile its immutable comment; conflicting claims fail closed. Exact existing
messages reconcile before task openness checks. New comments require open task
ancestry immediately before the write, while post-write reconciliation
tolerates a task closure race.
The ordinary Root Issue must always remain open and retain its admission label
and content digest.

## Task locator

All tools receive an opaque `taskLocator` from the Reaction execution context:

```json
{
  "repositoryOwner": "drasi-project",
  "repositoryName": "drasi-workgraph-demo",
  "repositoryNodeId": "R_workgraph_testbed",
  "issueNumber": 101,
  "issueNodeId": "I_child_task",
  "parentIssueNumber": 100,
  "parentIssueNodeId": "I_root_task"
}
```

Every top-level compiled task is a direct child of the ordinary Root Issue.
Recursive tasks follow their declared task-definition parent chain to that
top-level task. A scoped task instead follows its owning container (see
[scoped flow entries](#scoped-flow-entries)) and continues upward from there.
The reporter separately finds the unique initial task among
the Root Issue's direct children to verify run and admission integrity. It
re-reads every referenced object from GitHub; caller-supplied locator values
are never sufficient proof.

`WorkGraphTask/v1` Issue bodies require `taskKey` and `operation` in envelope
`workflowContext`, copied from the pinned task definition. These fields make task
descriptions and titles human-readable; they are validated metadata, not
substitutes for `taskDefinitionId`, definition version, or digest. Flat legacy
task bodies are rejected.

## Scoped flow entries

A task definition that declares `flowEntries` is a container: its Fork names one
entry task per declared entry alongside its fixed children, and its Join waits
for every scope to reach a terminal before the container's own lifecycle
continues. Every task realized by a scope's *steps* is a native direct sub-issue
of that container, so a scope is a flat sibling set rather than a parent chain;
the fixed children those tasks declare nest beneath their own task as usual.

Scoped tasks carry three reserved runtime inputs, all present or all absent:

| Input | Meaning |
|---|---|
| `workgraphScopeParentTaskId` | The owning container task ID |
| `workgraphScopeEntryTaskId` | The direct entry task ID of the scope |
| `workgraphScopeEntryStepId` | The compiled entry step ID of the scope |

A routed successor inside a scope additionally carries the existing
`workgraphPredecessorTaskId`. The reporter validates that:

- the task's compiled source step belongs to `workgraphScopeEntryStepId`'s
  compiled scope, and none of its transitions leave that scope;
- the native parent is a task whose ID is `workgraphScopeParentTaskId` and whose
  task definition owns the entry, sharing the same Root Issue, run, and pinned
  definition;
- the entry task carries no predecessor, realizes the entry step, and is named
  by the owning container's Fork;
- every other member declares a predecessor that is a sibling of the same
  container, sits in the same scope, is not itself a forked child, derives the
  member's task ID, and carries exactly one Route advancing to that member's
  step and task definition;
- the predecessor chain reaches the entry without repeating a task.

Scopes nest: an entry task may own its own `flowEntries`, and ancestry climbs
one container at a time until it reaches an ordinary top-level task. A nested
fixed child inherits its parent's three scope strings but has no step of its
own, so it is validated against its compiled parent chain — its scope strings
must equal its parent's and share the same run — and scope validation happens at
the scoped step root it climbs to. The initial run task stays the unique initial
task directly under the ordinary Root Issue.
Legacy trunk and fixed-child ancestry is unchanged, and Result, Evaluation, and
Route submission are unchanged; only context validation is scope-aware.

## Root Issue reader

`get_root_issue` accepts exactly `taskLocator` and `taskId`. It requires the
worker task to be a canonical `WorkGraphTask/v1` created by the configured
launcher. It follows native GitHub parent links from the worker to the Root Task
and from the Root Task to the Root Issue.

The Root Task must:

- carry the same top-level `rootIssueId` and workflow run as the worker;
- use task definition `root-v1`;
- contain only `proofMode` and `rootIssue` in `resolvedInputs`;
- bind the Root Issue's repository, Issue identity, admission generation, and
  content digest;
- have the workflow run and Root Task IDs derived by the v1 algorithms.

The returned `rootIssue` includes the verified title and normalized body. A
title or body change after admission fails closed.

## Result writer

`submit_task_result` accepts exactly:

```json
{
  "taskLocator": {},
  "taskId": "urn:drasi:workgraph:id:v1:task:sha256:...",
  "dispatchId": "urn:drasi:workgraph:id:v1:dispatch:sha256:...",
  "leaseId": "urn:drasi:workgraph:id:v1:lease:sha256:...",
  "outcome": "succeeded",
  "output": {}
}
```

Before accepting any downstream lifecycle action, the reporter requires one
immutable Assignment authored by the configured assigner. A parent task must
also have an earlier Fork and Join, in that order, and its Assignment must
reference that Join; a leaf must have neither. Every Dispatch must follow and
reference that exact Assignment.

The reporter requires every Dispatch attempt to be a unique, canonical,
assignment-reporter-authored, never-edited `WorkGraphTaskDispatch/v1` comment,
with the unified envelope and exact Dispatch references/data. All direct
identities and all six context fields must match the task. It
then selects the one exact `dispatchId` and `leaseId` supplied by the current
Agent Task. The profile-local executor ID must also match that Dispatch.
This lets an expired attempt remain as immutable history without authorizing it.
It then calls:

```http
POST /github/workgraph-v1/lease/validate
Authorization: Bearer <lease validation token>
Content-Type: application/json
```

with exactly:

```json
{
  "taskId": "urn:drasi:workgraph:id:v1:task:sha256:...",
  "leaseId": "urn:drasi:workgraph:id:v1:lease:sha256:...",
  "assignmentId": "urn:drasi:workgraph:id:v1:assignment:sha256:...",
  "executorId": "issue-worker",
  "slotId": "issue-worker-slot-1",
  "claimId": "urn:drasi:workgraph:id:v1:lease-claim:sha256:..."
}
```

The Source atomically reserves the active Lease for `claimId`; a competing claim
fails closed. Its exact response repeats those six fields, adds the
authoritative one-based `attempt` (bounded by Core to 64), and provides a valid,
unexpired `acquiredAt`/`expiresAt` interval.

The caller never supplies `resultId`, `rootIssueId`, `workflowRunId`, or
`attempt`. The reporter derives the direct identities from the verified task
and takes the attempt only from the validated active-Lease response. Dispatch
comment count is not attempt evidence. `resultId` is
derived from the length-framed UTF-8 values of `taskId`, `dispatchId`, and
`leaseId`:

```text
urn:drasi:workgraph:id:v1:result:sha256:<64 lowercase hex>
```

It writes the canonical body:

````text
WorkGraphTaskResult/v1

```json
{
  "apiVersion": "workgraph.drasi.io/v1",
  "kind": "TaskResult",
  "id": "urn:drasi:workgraph:id:v1:result:sha256:...",
  "rootIssueId": "root-issue-id",
  "workflowRunId": "workflow-run-id",
  "taskId": "urn:drasi:workgraph:id:v1:task:sha256:...",
  "workflowContext": {
    "workflowDefinitionId": "issue-lifecycle",
    "workflowDefinitionVersion": "v1",
    "workflowDefinitionDigest": "sha256:...",
    "taskDefinitionId": "urn:drasi:workgraph:id:v1:task-definition:sha256:...",
    "taskKey": "a",
    "operation": "intake-issue"
  },
  "references": {
    "dispatch": {
      "kind": "TaskDispatch",
      "id": "urn:drasi:workgraph:id:v1:dispatch:sha256:..."
    },
    "lease": {
      "kind": "TaskLease",
      "id": "urn:drasi:workgraph:id:v1:lease:sha256:..."
    }
  },
  "data": {
    "attempt": 1,
    "outcome": "succeeded",
    "output": {}
  }
}
```
````

An exact existing Result is returned as reconciled without another write.
Malformed, foreign, duplicate, or conflicting Results fail closed. The
output domain is bounded graph-safe JSON: strings, booleans, null, arrays,
objects, and JavaScript-safe integers only. The
reporter never closes tasks, evaluates Results, allocates Leases, or mutates the
Root Issue.

Evaluation `resultDigest` is SHA-256 over the recursively key-sorted compact
JSON serialization of the canonical TaskResult envelope object—the exact object
inside the fenced Result JSON. It therefore includes `apiVersion`, `kind`,
envelope identity and context, references, and data, but excludes the Markdown
marker, fence, indentation, and trailing newline bytes. Integer-like object keys
are sorted by UTF-8 bytes rather than JavaScript enumeration order.

Evaluation and Route IDs use
`urn:drasi:workgraph:id:v1:evaluation:sha256:...` and
`urn:drasi:workgraph:id:v1:route:sha256:...`; no legacy form is generated. The reporter
requires every submitted or persisted Evaluation ID to derive from
`(taskId, resultId, resultDigest)` and every Route ID from
`(taskId, evaluationId)`. Error-terminal routing is diagnosed by a
`WorkGraphTaskError/v1` message. Worker failures remain `TaskResult` messages
with `data.outcome` set to `failed`.

## Configuration

Worker profiles retain the existing Result configuration. Lifecycle profiles
add:

- `COPILOT_MCP_WORKGRAPH_TOKEN`
- `COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID`
- `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID`
- exactly one of `COPILOT_MCP_WORKGRAPH_EVALUATOR_ID` or
  `COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID`

`COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID` is read by every tool, because a
worker reading a routed scope member must authenticate the predecessor's Route.
It is required for lifecycle tools and optional elsewhere: when a worker profile
does not inject it, the Route author defaults to
`COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID`, which is correct for the
current single-token deployment where every lifecycle comment authenticates as
the Result reporter user. A profile that names a separated Route identity keeps
using it, and that identity remains authoritative: a Route written by any other
actor is still rejected as foreign. When the variable is set it must be a
positive integer.

Every worker profile that exposes `get_root_issue` or `submit_task_result`
declares it so separated identities work without a reporter change.

Run the offline contract tests with:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
```
