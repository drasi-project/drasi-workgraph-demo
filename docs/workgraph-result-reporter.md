# WorkGraph v1 reporter

`.github/mcp/workgraph-reporter.mjs` is the testbed's narrow MCP boundary for
worker and lifecycle reporting. It exposes exactly five tools:

| Tool | Purpose | GitHub write |
|---|---|---|
| `get_root_issue` | Verify a validator child, its Root Task, and the immutable Root Issue snapshot | No |
| `submit_task_result` | Verify a task, Dispatch, and active Lease, then create or reconcile its Result | One comment when absent |
| `get_task_snapshot` | Verify the current Dispatch, Result, direct identities, attempt, and effective compiled lifecycle policy | No |
| `submit_task_evaluation` | Create or reconcile the current Result's canonical Evaluation | One comment when absent |
| `submit_task_route` | Create or reconcile an authorized Route for the current Evaluation | One comment when absent |

The reporter is fixed to `drasi-project/drasi-workgraph-demo`. It rejects
unknown arguments, unexpected Issue identities, foreign actors, noncanonical
bodies, duplicate protocol comments, a missing exact `workgraph` admission label,
closed task ancestry for new work, changed Root Issue content, stale Leases, and
conflicting retries.

Lifecycle tools pin
`.github/workgraph/fixtures/v1/issue-lifecycle.expected.json`. They resolve the
task's source step and effective evaluator, orchestrator, and rework maximum
from that compiled definition. They require the latest immutable Dispatch and
its exact canonical Result, derive the compact normalized Result value digest,
and verify direct
Root Issue, run, task, Result, and Evaluation identities. Accepted Evaluations
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

Evaluation and Route writes use a deterministic artifact claim identity.
Identical concurrent calls in one reporter process share the write and
reconcile its immutable comment; conflicting claims fail closed. Exact existing
artifacts reconcile before task openness checks. New comments require open task
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
top-level task. The reporter separately finds the unique initial task among
the Root Issue's direct children to verify run and admission integrity. It
re-reads every referenced object from GitHub; caller-supplied locator values
are never sufficient proof.

## Root Issue reader

`get_root_issue` accepts exactly `taskLocator` and `taskId`. It requires the
validator task to be a canonical `WorkGraphTask/v1` created by the configured
launcher. It follows native GitHub parent links from the validator to the Root
Task and from the Root Task to the Root Issue.

The Root Task must:

- carry the same top-level `rootIssueId` and workflow run as the validator;
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
  "taskId": "task-id",
  "dispatchId": "dispatch-id",
  "leaseId": "lease-id",
  "outcome": "succeeded",
  "output": {}
}
```

The reporter requires every Dispatch attempt to be a unique, canonical,
assignment-reporter-authored, never-edited `WorkGraphTaskDispatch/v1` comment,
with exactly `dispatchId`, `launchId`, `rootIssueId`, `workflowRunId`, `taskId`,
`task`, and `lease`. All three top-level identities must match the task and its
nested identity. It
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
  "taskId": "task-id",
  "leaseId": "lease-id",
  "assignmentId": "assignment-id",
  "executorId": "issue-validator",
  "slotId": "issue-validator-slot-1",
  "claimId": "per-invocation UUID"
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
workgraph-v1:result:sha256:<64 lowercase hex>
```

It writes the canonical body:

````text
WorkGraphTaskResult/v1

```json
{
  "resultId": "workgraph-v1:result:sha256:...",
  "rootIssueId": "root-issue-id",
  "workflowRunId": "workflow-run-id",
  "taskId": "task-id",
  "dispatchId": "dispatch-id",
  "leaseId": "lease-id",
  "attempt": 1,
  "outcome": "succeeded",
  "output": {}
}
```
````

An exact existing Result is returned as reconciled without another write.
Malformed, foreign, duplicate, or conflicting Results fail closed. The
output domain is bounded graph-safe JSON: strings, booleans, null, arrays,
objects, and JavaScript-safe integers only. The
reporter never closes tasks, evaluates Results, allocates Leases, or mutates the
Root Issue.

Evaluation `resultDigest` is SHA-256 over compact `serde_json` serialization of
the normalized Result payload. The reporter emits this digest input explicitly,
sorting every object key recursively by UTF-8 bytes (including integer-like
keys). It does not rely on JavaScript object enumeration. Markdown marker,
fence, indentation, and trailing newline bytes are not part of the digest.

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

Run the offline contract tests with:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
```
