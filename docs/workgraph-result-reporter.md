# WorkGraphTask reporter

The repository defines two GitHub Copilot agent profiles:

| Agent profile | Assignment `taskType` |
| --- | --- |
| `issue-validator` | `issue-validation` |
| `issue-risk-profiler` | `issue-risk-profile` |

Both follow one flow: **task → native parent → work → task Result**. They may
publish ordinary progress only to the task. They never comment on, label,
close, or otherwise mutate the parent. They do not close the task; WorkGraph
machinery closes it only after consuming the Result.

## WorkGraphTask contract

The launcher supplies the agent with a positive `taskIssueNumber` and its
non-empty `taskIssueNodeId` in the fixed
`drasi-project/drasi-workgraph-demo` repository. The task must:

1. Be an Issue, not a pull request.
2. Have the configured exact Issue Type ID and exact name `WorkGraphTask`.
3. Have the configured immutable numeric creator user ID.
4. Have a native non-PR parent in the fixed repository.
5. Have a body containing only one strict WorkGraphAssignment JSON object.

There is no marker, envelope, Markdown fence, human summary, or prose in the
task body. For issue validation, the complete body is:

```json
{
  "assignmentId": "issue-validation:I_parent_node_id",
  "agentProfile": "issue-validator",
  "priority": 10,
  "taskType": "issue-validation",
  "task": {
    "validationProfile": "new-issue-default"
  }
}
```

For risk profiling, `agentProfile` is `issue-risk-profiler`, `taskType` is
`issue-risk-profile`, and `task` has exactly a non-empty `riskProfile` plus a
non-empty `dimensions` string array. Unknown fields are rejected at every
object level. Profile/taskType mappings are exact.

The native GitHub parent relation is authoritative. `assignmentId` is
deterministically `${taskType}:${parent.node_id}`, using the authoritative
parent Issue GraphQL node ID verbatim, never its number. Supplied task and
parent Issue numbers, node IDs, and assignment ID are bounded reconciliation
assertions, not alternative selectors or sources of truth.

## Repository-backed validation profiles

Issue-validation profiles live at
`.github/workgraph/profiles/issue-validation/<validationProfile>.md`.
`validationProfile` is 1-64 lowercase letters or digits separated only by
single hyphens. The reporter resolves only a regular file inside that
directory, no larger than 64 KiB, containing valid UTF-8 with LF endings.

Its authoritative final criteria section is:

```markdown
## Criteria

1. The Issue has a non-empty title
2. The Issue body is present
```

The heading appears exactly once and is followed by one blank line and one or
more unique, single-line items numbered consecutively from `1`. No content
follows the list. Result criteria must match this profile exactly in count,
order, and text. Risk Result dimensions must likewise match the Assignment.

## Narrow tools

The local Node MCP server at `.github/mcp/workgraph-reporter.mjs` exposes only:

```text
workgraph/report_progress
workgraph/submit_task_result
```

Both inputs identify the task and parent with:

```json
{
  "taskIssueNumber": 17,
  "taskIssueNodeId": "I_task_node_id",
  "parentIssueNumber": 7,
  "parentIssueNodeId": "I_parent_node_id"
}
```

Their exact strict signatures are:

```text
report_progress({
  taskIssueNumber,
  taskIssueNodeId,
  parentIssueNumber,
  parentIssueNodeId,
  assignmentId,
  message
})
submit_task_result({
  taskIssueNumber,
  taskIssueNodeId,
  parentIssueNumber,
  parentIssueNodeId,
  workResult
})
```

`report_progress` adds the Assignment `assignmentId` and `message`. It accepts
non-empty ordinary message text up to 4096 UTF-8 bytes on an open task. It
rejects carriage returns, current and legacy WorkGraph markers, Markdown
fences, and `details`/`summary` tags. The reporter verifies the supplied
assignment ID against both the raw body and deterministic derivation. Progress
is nonterminal and is never written to the parent.

`submit_task_result` adds only `workResult`. It fetches the current raw task
body and revalidates the fixed repository, task number/node ID, non-PR state,
exact configured type ID/name, creator ID, strict Assignment, authoritative
non-PR parent number/node ID, deterministic `assignmentId`, profile mapping,
criteria/dimensions, reporter identity, and strict Result. The caller cannot
choose a repository, body, author, REST method, GraphQL document, state
transition, label, or close operation.

## Exact Result bytes

The only structured task Result is:

````text
WorkGraphTaskResult/v1

```json
{
  "assignmentId": "issue-validation:I_parent_node_id",
  "taskType": "issue-validation",
  "outcome": "succeeded",
  "summary": "Validated the title and body requirements.",
  "result": {
    "criteria": [
      {
        "criterion": "The Issue has a non-empty title",
        "passed": true,
        "evidence": "The title contains non-whitespace text."
      },
      {
        "criterion": "The Issue body is present",
        "passed": true,
        "evidence": "The body contains non-whitespace text."
      }
    ]
  }
}
```
````

The bytes are exactly `WorkGraphTaskResult/v1`, one blank line, a lowercase
`json` fence, the strict Result serialized with two-space indentation, the
closing fence, and exactly one final LF. There are no details tags, human
summary outside the JSON, or trailing prose.

Common Result fields are exactly `assignmentId`, `taskType`, `outcome`,
`summary`, and `result`. `outcome` is `succeeded`, `failed`, or `blocked`.
Validation results contain strict `criterion`/`passed`/`evidence` objects.
Risk results contain strict `dimension`/`score`/`rationale` objects with integer
scores from 0 through 100.

## Identity and configuration

Configure these values under **Settings → Secrets and variables → Agents**:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `COPILOT_MCP_WORKGRAPH_TOKEN` | Fixed-repository task reporter token |
| Variable | `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID` | Expected immutable numeric task creator/launcher database ID |
| Variable | `COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID` | Expected immutable numeric reporter token owner ID |

The MCP process receives exactly `COPILOT_MCP_WORKGRAPH_TOKEN`,
`COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID`,
`COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID`, and
`COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID`; there are no shorter process aliases.
Numeric user IDs are positive integers. The configured GraphQL Issue Type node
ID must equal `task.type.id`; the code constant `WorkGraphTask` must equal
`task.type.name`. Every check fails closed. Both repository agent profiles pin
`COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID` directly to the deployed
organization Issue Type node ID `IT_kwDOCX0YF84CKGIJ`; it is not an Agents
variable.

For this prototype, the configured creator and reporter IDs may intentionally
be the same stable bot identity. They remain separate configuration checks so
production deployments can use distinct least-privilege identities without a
protocol change.

The token needs repository metadata read plus Issues read/write only for the
fixed repository. The runtime uses GET requests and task-comment POST requests.
It has no PATCH, close, label, parent-comment, edit, or delete route.

## Retry and reconciliation

For `submit_task_result`, the reporter scans all task comments. Ordinary
progress is ignored. Structured candidates are considered task-wide rather
than selected by `assignmentId`:

1. No candidate causes exactly one task-comment POST while the task is open.
2. One byte-exact canonical Result authored by the authenticated reporter is
   adopted when its payload exactly matches the requested Result.
3. A malformed, conflicting, foreign-authored, legacy, or multiple structured
   candidate fails without writing.
4. An existing exact Result succeeds whether the task is open or closed.
5. A closed task without an exact Result fails without writing.
6. An explicit POST failure is returned and is never retried.
7. An ambiguous or unreadable POST response causes exactly one comment
   re-list. If the exact authenticated Result is found, it is adopted; if not,
   the call fails. A second POST is never sent.

The reporter never edits or deletes comments and never closes any Issue.

## Validation

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```
