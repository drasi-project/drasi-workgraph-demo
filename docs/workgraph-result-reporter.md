# WorkGraph v1 reporter

`.github/mcp/workgraph-reporter.mjs` is the Demo's narrow MCP boundary for
reading the admitted Root Issue and submitting task Results. It exposes exactly
two tools:

| Tool | Purpose | GitHub write |
|---|---|---|
| `get_root_issue` | Verify a validator child, its Root Task, and the immutable Root Issue snapshot | No |
| `submit_task_result` | Verify a task, Dispatch, and active Lease, then create or reconcile its Result | One comment when absent |

The reporter is fixed to `drasi-project/drasi-workgraph-demo`. It rejects
unknown arguments, unexpected Issue identities, foreign actors, noncanonical
bodies, duplicate protocol comments, a missing exact `workgraph` admission label,
closed task ancestry for new work, changed Root Issue content, stale Leases, and
conflicting retries.

## Task locator

Both tools receive an opaque `taskLocator` from the Reaction execution context:

```json
{
  "repositoryOwner": "drasi-project",
  "repositoryName": "drasi-workgraph-demo",
  "repositoryNodeId": "R_demo",
  "issueNumber": 101,
  "issueNodeId": "I_child_task",
  "parentIssueNumber": 100,
  "parentIssueNodeId": "I_root_task"
}
```

For a child task, the parent is its WorkGraph parent. For the Root Task, the
parent is the ordinary Root Issue. The reporter re-reads every referenced
object from GitHub; caller-supplied locator values are never sufficient proof.

## Root Issue reader

`get_root_issue` accepts exactly `taskLocator` and `taskId`. It requires the
validator task to be a canonical `WorkGraphTask/v1` created by the configured
launcher. It follows native GitHub parent links from the validator to the Root
Task and from the Root Task to the Root Issue.

The Root Task must:

- carry the same top-level `rootIssueId` and workflow run as the validator;
- use task definition `demo-root-v1`;
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
fails closed. Its response must repeat those six fields and provide a valid,
unexpired `acquiredAt`/`expiresAt` interval.

The caller never supplies `resultId`. The reporter derives it from the
length-framed UTF-8 values of `taskId`, `dispatchId`, and `leaseId`:

```text
workgraph-v1:result:sha256:<64 lowercase hex>
```

It writes the canonical body:

````text
WorkGraphTaskResult/v1

```json
{
  "resultId": "workgraph-v1:result:sha256:...",
  "taskId": "task-id",
  "dispatchId": "dispatch-id",
  "leaseId": "lease-id",
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

## Configuration

The two agent profiles expose only:

- `COPILOT_MCP_WORKGRAPH_TOKEN`
- `COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID`
- `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_EXECUTOR_ID`
- `COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL`
- `COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN`

Run the offline contract tests with:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
```
