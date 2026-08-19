# WorkGraph agent and reporter contract

This is a breaking, closed contract for `drasi-project/drasi-workgraph-demo`.
There is no generic task registry, legacy marker support, compatibility parser,
arbitrary repository selector, arbitrary comment body, or generic mutation
tool. All parsers reject unknown fields and noncanonical bytes.

## Task body: `WorkGraphTask/v1`

A task is a native child Issue with exact configured Issue Type node ID and
exact type name `WorkGraphTask`. Its configured launcher identity is verified
by immutable numeric user ID. The complete body is exactly the marker, one
blank line, one lowercase `yaml` fence, one of these payloads, the closing
fence, and one final LF:

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

The minimal canonical YAML grammar is:

```text
document       = "taskType: " task-type LF
                 "inputs:" LF
                 "  " input-key ": " input-value
task-type      = "validate-issue" | "request-info"
input-key      = "validationProfile" | "validationResultCommentNodeId"
input-value    = "new-issue-default" | node-id
node-id        = 1*256(ALPHA | DIGIT | "_" | "-")
```

The key/value pair is fixed by task type. There are no quotes, comments,
aliases, tags, blank payload lines, alternate indentation, extra fields, or
generic YAML constructs. The request-info node ID must be non-empty.

The task body schema remains unchanged. Transition correlation is instead an
exact launcher-generated title:

```text
WorkGraph: validate-issue parent #<number> start-validation
WorkGraph: request-info parent #<number> validation-result <Result node ID>
WorkGraph: validate-issue parent #<number> human-reply <reply node ID>
```

The fixed parent number plus immutable triggering node ID makes later cycles
distinct. A retry accepts only one exact open type/creator/title/body match.

## Task comments

All JSON contracts use a lowercase `json` fence, two-space JSON indentation,
the displayed property order, and exactly one LF after the closing fence.

### Assignment

Assignment is task-only and has exactly one field:

````text
WorkGraphTaskAssignment/v1

```json
{
  "agentProfile": "issue-validator"
}
```
````

The only other value is `issue-info-requester`. Mapping is fixed:
`validate-issue` → `issue-validator`; `request-info` →
`issue-info-requester`. The configured Assignment reporter author is verified.

### Result

Common Result fields are exactly `taskType`, `outcome`, `summary`, and
`result`. There is no `assignmentId`. Outcome is `succeeded`, `failed`, or
`blocked`. A completed validation is `succeeded` even when criteria fail.

````text
WorkGraphTaskResult/v1

```json
{
  "taskType": "validate-issue",
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

The criteria array has exactly two entries in repository-profile order. Every
entry has exactly `criterion`, boolean `passed`, and non-empty plain-text
`evidence`.

A request-info Result records the exact parent comment and its creation time,
needed to require a later human reply:

````text
WorkGraphTaskResult/v1

```json
{
  "taskType": "request-info",
  "outcome": "succeeded",
  "summary": "Requested the missing issue information.",
  "result": {
    "requestCommentNodeId": "IC_parent_info"
  }
}
```
````

The reporter verifies `requestCommentNodeId` against the configured-author
parent comment. Resume logic reads that comment's authoritative creation time.

The Result reporter POSTs when no Result exists and PATCHes the one canonical
configured-author Result comment when requested canonical content changes.
It rejects multiple, malformed, foreign-authored, wrong-task, or already
accepted Results. It never changes Issue state and never closes the task.
Immediately before PATCH it re-lists task comments and re-fetches the exact
Result REST comment, rejecting a changed Result or any Acceptance. Immediately
after PATCH it re-lists and fails closed if an Acceptance appeared or the
Result does not exactly match the requested revision.

### Acceptance

````text
WorkGraphTaskResultAcceptance/v1

```json
{
  "resultCommentNodeId": "IC_result",
  "resultBodyDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "summary": "Result is satisfactory."
}
```
````

The digest is SHA-256 over the exact UTF-8 bytes of the current Result comment,
including its final LF. Acceptance must target the exact current Result node ID
and lowercase digest. A stale digest, revised body, wrong target, wrong author,
or conflicting Acceptance fails closed. Result and Acceptance are separate;
neither reporter closes a task. An external WorkGraph runtime may close the
task only after consuming Acceptance.

Immediately before an Acceptance POST, the reporter re-lists comments and
re-fetches the exact current Result, checking its node ID and digest again.
Immediately after POST it re-lists and verifies that the Result still has the
digest recorded by the one canonical Acceptance.

## Core graph projection

The core projection uses the exact specialized properties and relations:

- `WorkGraphTask`: `taskType`, `inputs`
- `WorkGraphTaskAssignment`: `agentProfile`; `ASSIGNMENT_FOR` → task
- `WorkGraphTaskResult`: computed `bodyDigest`, plus `taskType`, `outcome`,
  `summary`, `result`; `RESULT_FOR` → task
- `WorkGraphTaskResultAcceptance`: `resultCommentNodeId`,
  `resultBodyDigest`, `summary`; `ACCEPTS_RESULT` → Result

Each specialized comment also has `COMMENT_ON` to its task. Result
`bodyDigest` is SHA-256 over the exact full marker comment body and is not a
field in the Result wire JSON. A current Acceptance matches only when its
`resultBodyDigest` equals that Result node's `bodyDigest`.

## State machine and narrow tools

The only MCP tools are:

```text
get_result_snapshot
submit_task_assignment
submit_task_result
submit_result_acceptance
transition_issue
post_parent_info_request
feedback_and_redispatch
```

`get_result_snapshot` is read-only. It verifies the open task, native parent,
canonical Assignment, and exact current Result, including configured authors
and task/profile mapping. It returns only the typed `workResult`,
`resultCommentNodeId`, and SHA-256 `resultBodyDigest`; the acceptor never
computes or guesses a digest.

All task reporters take verified task and native-parent numbers/node IDs.
Callers cannot select a repository, HTTP route, author, raw body, label, or
Issue state.

### Dispatch and read-tool trust boundary

The graph dispatcher supplies positive Issue numbers and opaque GraphQL node
IDs for the task, parent, and relevant comments. Agents treat those opaque IDs
as trusted routing references and pass them unchanged to narrow tools.
`github/issue_read` does not expose Issue node IDs or Issue Type node IDs, so an
agent must not require those fields from its readable evidence or stop merely
because they are absent.

Agents use `issue_read` for the fields it exposes: repository and Issue
numbers, state/labels, title/body, Issue Type name, native parent/children,
comments, and numeric authors. They parse readable canonical bodies and make
the workflow decision. Every narrow reporter then independently re-fetches
GitHub state and rejects any mismatch in supplied node IDs, exact configured
Issue Type ID/name, creators/comment authors, native parent, current task,
Assignment/Result/Acceptance, destination, status, or race checks before a
write. Opaque dispatch IDs are never selectors for a generic route, and no
agent has a generic write tool.

`transition_issue` re-reads authoritative native children and binds supplied
task IDs to the unique current task of the required type: the matching child
with the greatest Issue number. It rejects an older matching closed task and
every unexpected open sibling. It re-reads the parent immediately before label
mutation, requires the expected status still to match, and recomputes the
replacement from those current labels so concurrently added unrelated labels
are preserved:

- `status:new` + `start-validation`: requires no open child, creates and
  attaches validation, then replaces only the WorkGraph status label with
  `status:awaiting-validation`.
- `status:awaiting-validation` + `advance-validation`: requires a closed child,
  current configured-author Result, and configured-author Acceptance matching
  its current digest. Two passed criteria advance to `status:awaiting-triage`;
  otherwise it creates/attaches request-info and advances to
  `status:awaiting-need-info`.
- `status:awaiting-need-info` + `resume-after-human-reply`: requires the
  accepted, externally closed request-info task and a non-agent human comment
  created strictly after its recorded parent info comment; it creates/attaches
  validation and advances to awaiting-validation.
- `status:awaiting-triage` is an orchestrator no-op.

The tool rejects stale supplied status. Task creation, native child attachment,
and status replacement are one narrow MCP call and reconcile expected state
immediately before writing. GitHub REST does not provide a
transaction spanning those routes, so every task-producing transition uses the
canonical title/body correlation above. On retry, it first reconciles one
already attached match, then one exact open unattached fixed-repository match,
before creating. Multiple candidates, a candidate attached elsewhere, or any
other open child fail closed. A retry therefore completes a partial
create/attach/status sequence without creating another task or leaving the
known correlated task orphaned.

Task creation always includes the configured `WorkGraphTask` Issue Type in the
initial create request. Only a create response and later authoritative reads
with the exact configured type ID and name are adoptable. A correlated Issue
created without that type, with another type, or later typed/untyped is never
attached, assigned, commented on, or retyped by these tools; creation retry
replaces it with a fresh correctly typed task. No tool exposes an Issue Type
mutation route.

`post_parent_info_request` verifies the request task and referenced current
validation Result, mentions the parent submitter, lists only failed criteria,
and reconciles by validation Result comment node ID. It permits later cycles
for later validation Results but never duplicates the same request. Before
posting to the parent it also requires the supplied request-info task to be the
current request task and to have exactly one canonical configured-author
Assignment naming `issue-info-requester`.

`feedback_and_redispatch` verifies the caller-reviewed Result node ID and
digest against the exact current Result and existing Assignment, then maintains
one canonical configured-author feedback comment:
Feedback is bound to the exact current Result digest.

````text
WorkGraphTaskFeedback/v1

```json
{
  "resultCommentNodeId": "IC_result",
  "resultBodyDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "feedback": "Clarify the body evidence."
}
```
````

Stale reviewed digests are rejected. After the acceptor reviews a revised
Result snapshot, the tool PATCHes that same feedback comment with the new
digest and requested feedback, then returns:

```json
{
  "status": "external-dispatch-required",
  "agentProfile": "issue-validator",
  "taskIssueNumber": 17
}
```

There is no supported GitHub Agent Task redispatch REST surface available to
this dependency-free reporter. The external WorkGraph dispatcher must consume
this bounded request. The tool never invents an endpoint or chooses a new
profile.

## Unavoidable REST race and remediation

The pre/post reconciliation windows are the strongest fail-closed behavior
available without a GitHub transaction. A Result may still change immediately
after the final Acceptance check, or an Acceptance may appear immediately
after the final Result check. Any detected race returns an inconsistent-state
error and performs no compensating delete; this MCP intentionally exposes no
delete route.

Manual remediation is required: stop dispatch for the task, inspect the one
Result and all Acceptance comments, and create a fresh WorkGraph task/cycle
from the authoritative parent state. Preserve the inconsistent comments as an
audit trail; do not delete or reinterpret an Acceptance whose digest no longer
matches.

## Identity and least privilege

Configure immutable positive numeric IDs:

- `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID`
- `COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID`
- `COPILOT_MCP_WORKGRAPH_REDISPATCH_REPORTER_USER_ID`

Also configure secret `COPILOT_MCP_WORKGRAPH_TOKEN`. Every profile pins live
type node ID `IT_kwDOCX0YF84CKGIJ`. Each tool verifies `/user` against its
configured role and verifies relevant stored comment authors. Roles may map to
one installation bot in a prototype, but remain separately named provenance
checks. Tokens need only fixed-repository metadata read and the specific Issue
comment/task/label routes used by the configured profile. All five profiles are
`user-invocable: true` and `disable-model-invocation: false` so selected GitHub
Agent Task sessions execute the profile and its narrow tools. This follows the
observed Agent Task runtime requirement; setting the latter to `true` produced
completed no-op sessions even when the profile was explicitly selected. They
expose no generic Issue write tool.

## Validation

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```
