# WorkGraph agent and reporter contract

This is a closed, breaking contract for `drasi-project/drasi-workgraph-demo`.
The VNext `submit_task_result` path uses the definition-driven V3 task and
Dispatch contract. The staged workflow retains its V2 task manifest and v1
Result marker, and the legacy inspection/transition tools retain their v1
parsers. The repository workflow uses a dedicated `WorkGraphInfoRequest/v2`
correlation marker. There
are no aliases, migration parsers, arbitrary repository selectors, raw comment
bodies, generic mutation tools, or GitHub Lease comments.

## Staged workflow v2 protocol

`.github/mcp/workgraph-v2-protocol.mjs` is the pure protocol module for the
repository workflow. It canonically formats and parses
`WorkGraphTask/v2` manifests, checks complete current-generation parallel task
families against their composite parent, and formats workflow Results and
Assignments. Workflow comments deliberately retain
`WorkGraphTaskResult/v1` and `WorkGraphTaskAssignment/v1`.

The production MCP imports the module for two narrow staged paths:

- `submit_workflow_task_assignment` requires the requested agent to equal the
  task manifest agent and to exist in the authoritative agent configuration.
- `submit_workflow_task_result` creates or exactly reconciles one non-empty,
  lease-bound workflow Result. It does not revise Results.
- `post_workflow_parent_info_request` requires the exact successful prior
  evaluator Result selected by the dispatch, revalidates its digest and workflow
  generation, and posts or reconciles the canonical parent request.

Both paths verify the typed task, launcher and reporter identities, exact native
parent, and canonical Assignment. A branch task's direct parent must be the
open composite `WorkGraphTask/v2` whose current-generation child manifest
exactly defines that branch. A top-level workflow task must instead have a
principal Issue parent. A request-info Result must reference the exact
reporter-owned `WorkGraphInfoRequest/v2` comment. Result and info-request
creation validate the exact active Source Lease immediately before writing.
None of these paths changes Issue state or closes a task. They remain staged
behind the disabled v2 runtime; the remaining sections describe the active v1
workflow.

The GitHub WorkGraph Source owns agent capacity and active Leases. It projects
capacity from `.github/workgraph/agents.yaml`, creates synthetic active
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

## Source agent capacity

`.github/workgraph/agents.yaml` is desired capacity only:

```yaml
version: 1
agents:
  - agentId: issue-validator
    slots: 1
    leaseDuration: PT30M
  - agentId: issue-info-requester
    slots: 1
    leaseDuration: PT30M
  - agentId: issue-title-validator
    slots: 1
    leaseDuration: PT30M
  - agentId: issue-body-validator
    slots: 1
    leaseDuration: PT30M
  - agentId: issue-validation-evaluator
    slots: 1
    leaseDuration: PT30M
  - agentId: demo-orchestrator
    slots: 1
    leaseDuration: PT15M
```

The Assignment reporter fetches this file from the fixed repository's `main`
ref and verifies the mapped agent is configured. The Source independently
loads its configured ref and owns slots and active allocations.

The config grammar is exact and shared with Core: LF UTF-8 no larger than
256 KiB, `version: 1`, an `agents` list of at most 64 exact entries, and no
unknown or reordered fields. `agentId` is case-sensitive, 1–64 ASCII
letters/digits/`-._`, and unique. `slots` is 1–16. `leaseDuration` is a
whole-unit ISO-8601 duration from 1 through 86,400 seconds.

## GitHub comment protocols

Every JSON comment uses a lowercase `json` fence, two-space indentation, the
displayed property order, and exactly one LF after the closing fence. Unknown
or reordered fields and noncanonical bytes are rejected.

### `WorkGraphTaskAssignment/v1`

Assignment selects a configured custom agent. It does not consume a slot or
launch an agent.

````text
WorkGraphTaskAssignment/v1

```json
{
  "agentId": "issue-validator"
}
```
````

The only field is `agentId`. Mapping is fixed:
`validate-issue` -> `issue-validator`; `request-info` ->
`issue-info-requester`. The reporter independently verifies that agent in the
repository capacity config. An identical Assignment reconciles; malformed,
foreign, conflicting, or stale state fails closed.

### Legacy/staged Source-issued active Lease

A Lease is synthetic Source graph state, not a GitHub comment protocol. The
active dispatch envelope contains exactly:

```json
{
  "leaseId": "lease-001",
  "taskNodeId": "I_task",
  "assignmentCommentNodeId": "IC_assignment",
  "agentId": "issue-validator",
  "slotId": "issue-validator/1",
  "taskType": "validate-issue",
  "acquiredAt": "2026-08-19T00:00:00Z",
  "expiresAt": "2026-08-19T00:30:00Z"
}
```

Legacy and staged workflow agents pass the unchanged `leaseId`,
`assignmentCommentNodeId`, `agentId`, and `slotId`; reporter tool arguments call
`taskNodeId` `taskIssueNodeId`. Those agents do not relay `acquiredAt` or
`expiresAt`, because model serialization can alter timestamp precision. Their
reporter paths obtain the authoritative timestamps from Source, require
`acquiredAt < expiresAt`, and reject an expired Lease. VNext
`submit_task_result` instead verifies the canonical Dispatch artifact.

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
  "agentId": "issue-validator",
  "slotId": "issue-validator/1"
}
```

The request has exactly those five fields. A `200` response must be the exact
eight-field active Lease snapshot shown above. Its identity and validated task
type must equal the dispatch, and its authoritative timestamps must form a
currently active interval. `401` is authentication failure, `409` is
stale/mismatched/expired allocation, and `503` is Source state failure. Any
non-200, malformed JSON, extra field, or mismatch fails closed.
The reporter does not retry. The bearer token is separate from the GitHub token
and webhook HMAC and is never logged.

Point-in-time Source validation plus the reporter's check of the returned
deadline is the accepted prototype boundary. Atomic coordination across the
subsequent GitHub write is out of scope; Source remains authoritative when it
ingests the Result.

### VNext `WorkGraphTaskResult/v1`

`submit_task_result` is a breaking VNext-only path. Its exact arguments are
`taskLocator`, `taskId`, `dispatchId`, `leaseId`, `outcome`, and `output`.
Callers never supply `resultId`. The reporter derives:

`workgraph-vnext:result:sha256:` + SHA-256 of the concatenated, length-framed
UTF-8 bytes for `taskId`, `dispatchId`, and `leaseId`, in that order. Each
length is an unsigned 64-bit big-endian byte count.

````text
WorkGraphTaskResult/v1

```json
{
  "resultId": "workgraph-vnext:result:sha256:<64 lowercase hex>",
  "taskId": "task-1",
  "dispatchId": "dispatch-1",
  "leaseId": "lease-001",
  "outcome": "succeeded",
  "output": {
    "summary": "Validated both required fields.",
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

Outcome is exactly `succeeded` or `failed`; `output` is any bounded JSON value.
The reporter verifies the exact repository/Issue locator, open canonical
`WorkGraphTask/v3`, launcher and reporter identities, native parent when
present, and one configured-author canonical `WorkGraphTaskDispatch/v1` whose
task, Dispatch, and Lease identities match the call. It POSTs one canonical
Result, reconciles only identical bytes for the derived `resultId`, and rejects
malformed, foreign, duplicate, or conflicting artifacts. It never PATCHes a
VNext Result, changes Issue state, closes the task, or calls the legacy Source
Lease-validation endpoint.

A new VNext Result requires the task Issue to be open. After the runtime closes
the task, an exact retry still reconciles the existing canonical Result; it
cannot create or revise one.

### Legacy feedback and Acceptance

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
submit_workflow_task_assignment
submit_workflow_task_result
submit_result_acceptance
transition_issue
post_parent_info_request
post_workflow_parent_info_request
submit_task_feedback
```

`get_result_snapshot` is read-only and returns the typed Result, exact comment
node ID, and reporter-computed SHA-256 digest. `post_parent_info_request`
preserves task/parent/type/author/Assignment/Result/Feedback/Acceptance
reconciliation, validates Source immediately before the parent POST, and
reconciles an identical existing request without validation.

`post_workflow_parent_info_request` independently validates the open
`request-info` manifest and Assignment, the same-run and same-generation closed
parallel evaluator, its exact successful Result comment and SHA-256 digest, and
the `request-info` decision. It derives missing title/body criteria only from
the evaluator booleans, writes one generation-correlated
`WorkGraphInfoRequest/v2` parent comment, and validates Source immediately
before the POST. `submit_workflow_task_result` then requires that exact
reporter-owned parent comment and validates Source again.

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

Every profile configures the GitHub token, task Issue Type ID, and launcher ID.
Each profile then exposes only the identities and Lease settings needed by its
narrow tools:

| Profile | Additional identities | Source Lease settings |
| --- | --- | --- |
| `demo-orchestrator` | Assignment, Result | No |
| `issue-assigner` | Assignment | No |
| `issue-validator` | Assignment, Result | No |
| `issue-info-requester` | Assignment, Result, Info | Yes |
| `workgraph-result-acceptor` | Assignment, Result, Acceptance, Feedback | No |
| `issue-orchestrator` | Assignment, Result, Acceptance, Orchestrator, Info, Feedback | No |
| `issue-title-validator` | Assignment, Result | Yes |
| `issue-body-validator` | Assignment, Result | Yes |
| `issue-validation-evaluator` | Assignment, Result | Yes |

Tokens use `${{ secrets.* }}` references. Type and identity values use
`${{ vars.* }}` references. The reporter loads configuration per tool. A
missing required value fails before GitHub access; unrelated values are not
required.

The URL must be HTTPS, have no embedded credentials, query, or fragment, and end in
`/lease/validate`. Tests alone may use loopback HTTP. Reporter identity values
are immutable positive numeric GitHub user IDs. Tokens need only fixed-
repository metadata reads, the profile's narrow Issue routes, and, for the
Source token, read-only exact active-Lease validation.

## Validation

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --check .github/mcp/workgraph-v2-protocol.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

The separate opt-in live protocol layer is documented in
[`workgraph-github-protocol-tests.md`](workgraph-github-protocol-tests.md).
