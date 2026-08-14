# WorkGraph completion reporter

The issue-validator agent exposes only:

- `github/issue_read`, using the cloud agent's repository-scoped read token;
- `workgraph/report_completion`, provided by the dependency-free local Node
  stdio server at `.github/mcp/workgraph-reporter.mjs`.

The built-in GitHub MCP token is read-only by default. The scoped reporter uses
a separate write-capable PAT supplied only through a Copilot Agents secret. It
does not expose `github/add_issue_comment`, `github/projects_write`, a generic
GitHub request, or arbitrary GraphQL.

## Fixed authority boundary

The reporter fixes the repository `drasi-project/drasi-workgraph-demo`,
organization `drasi-project`, Project number `3`, and ProjectV2 node ID
`PVT_kwDOCX0YF84BgNE3`. The caller cannot override any destination, identity,
event field, validation result, or mutation.

The externally configured trust values are immutable numeric GitHub user IDs
for the launcher and reporter plus their diagnostic logins. Renaming either
login does not affect trust. The reporter posts one Issue comment and performs
no Project mutation; the Core router routes directly from `AwaitingValidation`.

## Tool contract

`workgraph/report_completion` rejects unknown and additional properties. Its
complete input is:

```json
{
  "subjectNumber": 7,
  "executionId": "execution:validation-001"
}
```

The caller supplies no node ID, destination, event body, outcome, marker result,
profile, run ID, timestamp, repository, Project, status, or arbitrary API input.
The agent's `github/issue_read` response may omit `subjectNodeId`; the profile
neither requires nor preserves that field because the reporter resolves the
authoritative identity itself.

Success returns only verified completion identifiers:

```json
{
  "eventId": "...",
  "executionId": "execution:validation-001",
  "commentNodeId": "IC_...",
  "projectItemNodeId": "PVTI_...",
  "subjectNodeId": "I_...",
  "reconciled": false
}
```

## Common event format

Every accepted WorkGraph event comment uses exactly:

```text
WorkGraphEvent/v1

<one non-empty generated human summary line, at most 120 characters>

<one raw JSON object ending at end-of-comment>
```

There is no Markdown fence or trailing text. Old JSON-only and fenced event
formats are ignored. The JSON envelope has exactly these keys in this order:

```json
{
  "schemaVersion": "workgraph.event/v1",
  "eventId": "...",
  "eventType": "ResponsibilityAssigned",
  "runId": "...",
  "projectItemNodeId": "PVTI_...",
  "subjectNodeId": "I_...",
  "payload": {}
}
```

The allowed event types are `ResponsibilityAssigned`, `ExecutionStarted`,
`CompletedIssueValidation`, and `RoutingDecided`. Each payload has its own exact
schema. The completion payload is exactly:

```json
{
  "executionId": "execution:...",
  "outcome": "passed",
  "reasonCode": "required-marker-present"
}
```

For failure, outcome is `failed` and reason code is
`required-marker-missing`. Completion summaries are exactly
`Issue validation passed.` and `Issue validation failed.`.

## Deterministic identifiers and digests

The exact issue-body digest is:

```text
sha256:<lowercase SHA-256 hex of the exact UTF-8 bytes of body ?? "">
```

There is no newline conversion, trimming, Unicode normalization, or other body
normalization. Run IDs and event IDs use the shared WorkGraph v1 algorithms and
the vectors in `tests/fixtures/issue-validator-events.json`; every producer and
consumer must match those vectors byte-for-byte.

Canonical comment reconciliation also hashes the complete rendered comment as
exact UTF-8 bytes. A reporter-authored candidate is adoptable only when its body
hash equals the expected canonical body hash and its GitHub timestamps prove it
was never edited.

## Authoritative ordered behavior

For each call, the reporter:

1. Rejects malformed or additional input before GitHub access.
2. Resolves the PAT identity and requires its immutable numeric ID to equal the
   configured reporter user ID. The login is diagnostic only.
3. Reads the fixed-repository Issue by `subjectNumber`, obtains its authoritative
   node ID and exact `body ?? ""`, and rejects pull requests.
4. Reads Issue comments and considers only unedited strict common-format events.
   Old JSON-only and fenced records are ignored.
5. Requires exactly one trusted `ExecutionStarted` event for `executionId`
   authored by the configured immutable launcher identity. It derives `runId`,
   Project Item ID, and subject ID from that event.
6. Requires the matching trusted `ResponsibilityAssigned` event, validates its
   deterministic IDs and exact schema, and derives `profileRef` and
   `contentDigest`.
7. Independently resolves fixed Project number `3`, requires node ID
   `PVT_kwDOCX0YF84BgNE3`, and requires exactly one Project Item in that Project
   tracking the authoritative fixed-repository Issue.
8. Computes SHA-256 over the exact authoritative body and requires equality with
   the assignment `contentDigest` before any write.
9. Independently evaluates the complete-line, case-sensitive marker
   `WorkGraph-Validation: pass`, derives outcome and reason code, derives the
   deterministic completion event ID, and renders the exact canonical comment.
10. Reconciles only one unedited, canonically formatted completion authored by
    the immutable reporter identity with the exact canonical body hash. Spoofed,
    edited, conflicting, or ambiguous canonical records never satisfy success.
11. Posts only the completion comment when none exists. If the POST response is
    ambiguous, it reads comments again and adopts only the authenticated exact
    canonical record.

There is no `AwaitingRouting` status mutation or readback. An explicit comment
failure performs no write beyond the failed comment request, and a retry adopts
the existing canonical comment instead of creating a duplicate.

## Agents configuration

In **Settings > Secrets and variables > Agents**, configure:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `COPILOT_MCP_WORKGRAPH_TOKEN` | Write-capable PAT; never commit it |
| Variable | `COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID` | Immutable numeric ID of the trusted launcher event author |
| Variable | `COPILOT_MCP_WORKGRAPH_LAUNCHER_LOGIN` | Diagnostic login for that launcher ID |
| Variable | `COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID` | Immutable numeric ID of the trusted write-PAT owner |
| Variable | `COPILOT_MCP_WORKGRAPH_REPORTER_LOGIN` | Diagnostic login for that reporter ID |

The profile maps them to `WORKGRAPH_TOKEN`, `WORKGRAPH_LAUNCHER_USER_ID`,
`WORKGRAPH_LAUNCHER_LOGIN`, `WORKGRAPH_REPORTER_USER_ID`, and
`WORKGRAPH_REPORTER_LOGIN`. The PAT must be restricted to this repository and
need only read Issue, comment, and Project metadata and write Issue comments.
It no longer needs Project write permission.

`COPILOT_MCP_WORKGRAPH_TOKEN` must be a separate least-privilege credential from
the local launcher's `GITHUB_AGENT_TOKEN`. There is no fallback between them,
and neither token may be reused for the other role. The current prototype uses
login `agentofreality`, numeric user ID `4021243`, for both configured roles.
That same-user authorship is an explicit prototype trust limitation; production
requires distinct immutable GitHub user IDs.

## Tests and activation gate

Run:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```

Before automated routing, run a manual Agent Task against a disposable Issue
with `create_pull_request=false`. This remains an activation blocker because
local tests cannot prove cloud MCP startup, PAT/SSO policy, live Project
configuration, or observed author allowlisting.
