# WorkGraph agent and reporter contract

This is a closed, breaking contract for `drasi-project/drasi-workgraph-demo`.
All GitHub WorkGraph comment protocols are v1-only. There are no aliases,
migration parsers, arbitrary repository selectors, raw comment bodies, generic
mutation tools, or GitHub Lease comments.

The GitHub WorkGraph Source owns worker queues and active Leases. It projects
worker capacity from `.github/workgraph/workers.yaml`, creates synthetic active
Lease graph nodes, validates exact active allocations, and remains the final
authority for Result ingestion, release, and stale rejection. The reporter
keeps narrow GitHub validation and idempotent writes; it never allocates,
persists, releases, polls, or retries a Lease.

## Task body: `WorkGraphTask/v1`

A task is a native child Issue with exact configured Issue Type node ID and type
name `WorkGraphTask`. Its launcher is verified by immutable numeric user ID.
The complete body is one of:

````text
WorkGraphTask/v1

```yaml
taskType: validate-issue
inputs:
  validationProfile: new-issue-default
```
````

````text
WorkGraphTask/v1

```yaml
taskType: request-info
inputs:
  validationResultCommentNodeId: IC_validation_result
```
````

The minimal canonical YAML grammar allows no quotes, comments, aliases, tags,
blank payload lines, alternate indentation, extra fields, or generic task
registry. Transition titles provide exact create/retry correlation:

```text
WorkGraph: validate-issue parent #<number> start-validation
WorkGraph: request-info parent #<number> validation-result <Result node ID>
WorkGraph: validate-issue parent #<number> human-reply <reply node ID>
```

## Source worker capacity

`.github/workgraph/workers.yaml` is desired capacity only:

```yaml
version: 1
workers:
  - workerId: issue-validation-01
    agentProfile: issue-validator
    slots: 1
    leaseDuration: PT30M
  - workerId: issue-information-01
    agentProfile: issue-info-requester
    slots: 1
    leaseDuration: PT30M
```

The Assignment reporter fetches this file from the fixed repository's `main`
ref and verifies deterministic worker selection. The Source independently
loads its configured ref and owns queue depth, slots, and active allocations.
`workerId` remains deliberately distinct from `agentProfile`.

## GitHub comment protocols

Every JSON comment uses a lowercase `json` fence, two-space indentation, the
displayed property order, and exactly one LF after the closing fence. Unknown
or reordered fields and noncanonical bytes are rejected.

### `WorkGraphTaskAssignment/v1`

Assignment is durable ownership by a configured worker queue. It does not
consume a slot or launch a worker.

````text
WorkGraphTaskAssignment/v1

```json
{
  "agentProfile": "issue-validator",
  "workerId": "issue-validation-01"
}
```
````

The fields are exactly `agentProfile` and `workerId`. Mapping is fixed:
`validate-issue` -> `issue-validator`; `request-info` ->
`issue-info-requester`. Selection from the trusted compatible-worker envelope
uses lowest queue depth, then lexicographically lowest worker ID. An identical
Assignment reconciles; malformed, foreign, conflicting, or stale state fails
closed.

### Source-issued active Lease

A Lease is synthetic Source graph state, not a GitHub comment protocol. The
active dispatch envelope contains exactly:

```json
{
  "leaseId": "lease-001",
  "taskNodeId": "I_task",
  "assignmentCommentNodeId": "IC_assignment",
  "workerId": "issue-validation-01",
  "slotId": "issue-validation-01/1",
  "taskType": "validate-issue",
  "acquiredAt": "2026-08-19T00:00:00Z",
  "expiresAt": "2026-08-19T00:30:00Z"
}
```

Agents pass every field unchanged. Reporter tool arguments call `taskNodeId`
`taskIssueNodeId`; all other names match the envelope. The reporter validates
the canonical timestamps, requires `acquiredAt < expiresAt`, and rejects a
locally expired Lease before contacting Source.

Immediately before each irreversible GitHub Result POST/PATCH or parent-info
POST, the reporter sends:

```http
POST {webhook.path}/lease/validate
Authorization: Bearer <COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN>
Content-Type: application/json
```

```json
{
  "taskNodeId": "I_task",
  "leaseId": "lease-001",
  "assignmentCommentNodeId": "IC_assignment",
  "workerId": "issue-validation-01",
  "slotId": "issue-validation-01/1"
}
```

The request has exactly those five fields. A `200` response must be the exact
eight-field active Lease snapshot shown above, byte-for-value equal to the
dispatch envelope and validated task type. `401` is authentication failure,
`409` is stale/mismatched/expired allocation, and `503` is Source state
failure. Any non-200, malformed JSON, extra field, or mismatch fails closed.
The reporter does not retry. The bearer token is separate from the GitHub token
and webhook HMAC and is never logged.

Point-in-time validation plus the local deadline check is the accepted
prototype boundary. Atomic coordination across the subsequent GitHub write is
out of scope; Source remains authoritative when it ingests the Result.

### `WorkGraphTaskResult/v1`

Result fields are exactly `taskType`, `leaseId`, `outcome`, `summary`, and
task-specific `result`. There is no `assignmentId` or wire `bodyDigest`.

````text
WorkGraphTaskResult/v1

```json
{
  "taskType": "validate-issue",
  "leaseId": "lease-001",
  "outcome": "succeeded",
  "summary": "Validated both required fields.",
  "result": {
    "criteria": [
      {
        "criterion": "The Issue has a non-empty title",
        "passed": true,
        "evidence": "The title contains non-whitespace text."
      },
      {
        "criterion": "The Issue body is present",
        "passed": false,
        "evidence": "The body is empty."
      }
    ]
  }
}
```
````

A request-info Result has `taskType: "request-info"` and exactly
`result.requestCommentNodeId`, identifying the configured-author parent
request. Outcome is `succeeded`, `failed`, or `blocked`.

`submit_task_result` performs all existing read-only GitHub reconciliation
first: repository, task type, launcher, native parent, exact Assignment,
configured authors, Result, Feedback, Acceptance, destination, and revision
safety. An exact existing Result returns idempotently without Source
validation. For a write, it rechecks GitHub state, validates Source immediately
before the GitHub POST/PATCH, and performs no intervening work except issuing
that request.

The reporter POSTs when no Result exists. It PATCHes the canonical Result only
for exact digest-bound Feedback followed by a new active Lease. The semantic
Result must materially change. It rejects malformed, foreign, multiple,
accepted, or conflicting Results. A Result never changes Issue state and never
closes the task.

### Feedback and Acceptance

`WorkGraphTaskFeedback/v1` binds actionable feedback to the exact current
Result comment ID and SHA-256 body digest. `submit_task_feedback` posts or
patches one canonical feedback comment. It does not return a queue request or
allocate a Lease. Source may observe Feedback and later allocate a new Lease.

`WorkGraphTaskResultAcceptance/v1` contains exactly
`resultCommentNodeId`, `resultBodyDigest`, and `summary`. The digest is SHA-256
over the exact UTF-8 Result comment bytes. Acceptance verifies the exact current
Result immediately before and after writing. Neither Result nor Acceptance
closes the task; an external WorkGraph runtime may close it after consuming
Acceptance.

## Narrow tools and state machine

The MCP exposes only:

```text
get_result_snapshot
submit_task_assignment
submit_task_result
submit_result_acceptance
transition_issue
post_parent_info_request
submit_task_feedback
```

`get_result_snapshot` is read-only and returns the typed Result, exact comment
node ID, and reporter-computed SHA-256 digest. `post_parent_info_request`
preserves task/parent/type/author/Assignment/Result/Feedback/Acceptance
reconciliation, validates Source immediately before the parent POST, and
reconciles an identical existing request without validation. Its later
`submit_task_result` call independently validates Source again.

`transition_issue` preserves the strict parent state machine:

- `status:new` -> create validation -> `status:awaiting-validation`
- accepted failed validation -> create request-info ->
  `status:awaiting-need-info`
- accepted request-info plus later human reply -> create validation ->
  `status:awaiting-validation`
- accepted passing validation -> `status:awaiting-triage`

Canonical title/body correlation reconciles partial create, native-child
attachment, and status writes without creating another task. No tool exposes
Issue Type mutation. The Source launch envelope supplies opaque graph node IDs;
agents pass them unchanged while reporters independently re-fetch GitHub state.

GitHub REST cannot transact Result and Acceptance writes. The reporter performs
fail-closed pre/post reconciliation and no compensating delete. A detected race
requires manual remediation while preserving comments as an audit trail.

## Configuration and least privilege

All profiles configure:

- `COPILOT_MCP_WORKGRAPH_TOKEN`
- `COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID`
- `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID`
- `COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID`

The validator and info-requester profiles additionally configure:

- `COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL`
- `COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN`

The URL must be HTTPS, have no embedded credentials, query, or fragment, and end in
`/lease/validate`. Tests alone may use loopback HTTP. Reporter identity values
are immutable positive numeric GitHub user IDs. Tokens need only fixed-
repository metadata reads, the profile's narrow Issue routes, and, for the
Source token, read-only exact active-Lease validation.

## Validation

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```
