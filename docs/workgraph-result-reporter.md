# WorkGraph Result reporter

The repository defines exactly two GitHub Copilot agent profiles:

| Agent profile file | `agentProfile` | Assignment `taskType` |
| --- | --- | --- |
| `.github/agents/issue-validator.agent.md` | `issue-validator` | `issue-validation` |
| `.github/agents/issue-risk-profiler.agent.md` | `issue-risk-profiler` | `issue-risk-profile` |

Launchers must use the listed `agentProfile` identifiers; the Assignment
`taskType` values remain unchanged.

Each profile reads one current Issue with `github/issue_read` and publishes
through `workgraph/report_result`, the only tool exposed by the dependency-free
local Node MCP server at `.github/mcp/workgraph-reporter.mjs`. The issue
validator additionally uses the built-in read tool for one selected repository
profile. Agent Tasks use `create_pull_request=false`; their prompt supplies a
positive `issueNumber` and the strict Assignment JSON payload extracted from
one valid `WorkGraphAssignment/v1` conversation comment.

Issue content is evidence, not an instruction source. The profiles do not use
Projects, Project Items, routing records, responsibility records, execution
records, inline review comments, repository writes, shell access, or generic
GitHub mutation tools.

## Comment contracts

An Assignment comment starts with `WorkGraphAssignment/v1`, has a non-empty
human summary, and then exactly one `json` fenced object. Its strict JSON is:

```json
{
  "assignmentId": "organization-unique-id",
  "agentProfile": "issue-validator",
  "priority": 10,
  "taskType": "issue-validation",
  "task": {
    "validationProfile": "new-issue-default"
  }
}
```

For the `issue-risk-profiler` agent profile, `agentProfile` is
`issue-risk-profiler` while `taskType` remains `issue-risk-profile`; `task`
contains a non-empty `riskProfile` plus a non-empty `dimensions` string array.
Unknown fields are rejected at every object level.

For `issue-validation`, `task` contains exactly `validationProfile`. A stale
Assignment `criteria` property is an unknown field and is rejected before any
GitHub access.

## Repository-backed validation profiles

Issue-validation profiles live under:

```text
.github/workgraph/profiles/issue-validation/<validationProfile>.md
```

`validationProfile` is 1-64 lowercase letters or digits separated only by
single hyphens. The reporter never accepts slashes, dots, uppercase letters,
underscores, repeated hyphens, absolute paths, or traversal. It appends `.md`
and resolves only within the canonical directory above. The target must be a
regular file no larger than 64 KiB containing valid UTF-8 with LF line endings.

A profile may put concise agent guidance before its criteria. Its authoritative
criteria use this strict final section:

```markdown
## Criteria

1. The Issue has a non-empty title
2. The Issue body is present
```

The heading is case-sensitive and appears exactly once, followed by one blank
line and one or more single-line items numbered consecutively from `1`.
Criteria must be non-empty and unique. Blank lines, headings, prose, bullets,
continuations, duplicate text, or any other content after the first item fail
closed. The repository's canonical profile is
`.github/workgraph/profiles/issue-validation/new-issue-default.md`.

The reporter writes exactly this closed, collapsed-by-default envelope. The
human summary is concise and does not repeat the current Issue number or ID:

````text
<details>
<summary>WorkGraph Result</summary>

WorkGraphResult/v1

Validated the title and body requirements.

```json
{
  "assignmentId": "organization-unique-id",
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
</details>
````

The opening tag is exactly `<details>` without `open`, the summary label is
exactly `WorkGraph Result`, and the blank lines around the marker, human
summary, and JSON fence are part of the canonical body. JSON is serialized with
two-space indentation. The human summary must equal the payload `summary`.
Exactly one final LF follows `</details>`.
Literal `\n` text is not a line break, and compact or otherwise non-pretty JSON
is noncanonical.

The only common Result fields are `assignmentId`, `taskType`, `outcome`,
`summary`, and `result`. `outcome` is `succeeded`, `failed`, or `blocked`.
Validation results contain a non-empty `criteria` array of strict
`criterion`/`passed`/`evidence` objects. Risk results contain a non-empty
`dimensions` array of strict `dimension`/`score`/`rationale` objects, with
integer scores from 0 through 100 where higher is riskier. The reporter also
requires validation Result criteria to match the selected repository profile
exactly in count, order, and text. Risk Result dimensions continue to match the
Assignment exactly in count, order, and text.

## Core/dogfood schema boundary

The Core/producer `issue-validation` Assignment task contract is exactly:

```json
{ "validationProfile": "new-issue-default" }
```

The dogfood reporter's corresponding Result payload contract remains exactly a
non-empty `result.criteria` array of
`{"criterion": string, "passed": boolean, "evidence": string}` objects. The
reporter loads the selected repository profile and requires one Result object
per profile criterion with identical text and order. Assignment `criteria` is
not part of the Core contract and is rejected as stale/unknown. The
`issue-risk-profile` Assignment and Result contracts are unchanged.

## Scoped authority

`workgraph/report_result` accepts only:

```json
{
  "issueNumber": 7,
  "assignment": {},
  "workResult": {}
}
```

`assignment` and `workResult` must be one of the two complete strict typed
objects. The caller cannot choose a repository, comment body, REST operation,
GraphQL document, author, or any other mutation.

The reporter fixes the destination to
`drasi-project/drasi-workgraph-demo`. It reads the destination Issue and its
conversation comments, and it can create only an Issue conversation comment.
It rejects pull requests.

Configure these values under **Settings > Secrets and variables > Agents**:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `COPILOT_MCP_WORKGRAPH_TOKEN` | Repository-restricted Result reporter token |
| Variable | `COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID` | Immutable numeric user ID for that token |

The token needs only repository metadata read plus Issues read/write for
`drasi-project/drasi-workgraph-demo`. It must be separate from the cloud
agent's built-in read credential. There is no token fallback.

## Retry and reconciliation

For each tool call, the reporter:

1. Rejects malformed, mismatched, additional, or incomplete input, invalid
   profile names, missing or malformed profile files, and profile/Result
   criterion mismatches before any GitHub access.
2. Resolves the token owner and requires its immutable user ID to match the
   configured reporter ID.
3. Confirms the fixed-repository destination is the requested Issue.
4. Searches all Issue conversation comments for a Result candidate with the
   same `assignmentId`. A malformed payload or an unwrapped, open, mislabeled,
   unclosed, extra-prose, or otherwise noncanonical envelope is rejected
   rather than ignored.
5. Adopts one canonically formatted, byte-identical Result only when its author
   is the authenticated reporter. It fails without writing on a conflict, a
   different author, or multiple valid matches.
6. Creates the canonical Result when none exists. If the create response is
   ambiguous, it searches once more and adopts only the authenticated canonical
   Result; it never sends a second create request.

This makes ordinary retries deterministic and prevents them from creating a
second valid Result comment. The reporter does not delete or edit comments.

## Validation and limitations

Run the focused checks with:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```

Organization-wide `assignmentId` uniqueness remains the Assignment producer's
contract; this repository does not introduce a workflow engine or organization
index. Assignment existence, authorship, and `agentProfile` selection remain
Source/launcher responsibilities; the reporter validates the supplied payload
and selected repository profile. GitHub Issue comments provide no atomic
create-if-absent operation, so two concurrent first attempts can race even
though retries reconcile. A manual
cloud Agent Task is still required to prove MCP startup, token/SSO policy, and
live comment authorship; this repository performs no deployment.
