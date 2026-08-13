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

The reporter owns these destinations and values; callers cannot override them:

| Setting | Fixed value |
| --- | --- |
| Repository | `drasi-project/drasi-workgraph-demo` |
| Project owner | `drasi-project` |
| Project number | `3` |
| ProjectV2 node ID | `PVT_kwDOCX0YF84BgNE3` |
| Status field node ID | `PVTSSF_lADOCX0YF84BgNE3zhaadbw` |
| `AwaitingRouting` option ID | `3407e5fe` |
| Event schema | `workgraph.event/v1` |
| Event type | `CompletedIssueValidation` |
| Subject type | `Issue` |
| Actor type | `Agent` |
| Actor ID / agent profile | `issue-validator` |

The only externally configured trust value is the launcher login that writes
the active `workgraph.execution/v1` comment.

## Tool contract

`workgraph/report_completion` rejects unknown and additional properties. Its
complete input is:

```json
{
  "projectItemNodeId": "PVTI_...",
  "subjectNodeId": "I_...",
  "subjectNumber": 2,
  "routeId": "validation:PVTI_...:2026-08-13T01:00:00Z",
  "responsibilityId": "validation:PVTI_...:2026-08-13T01:00:00Z:issue-validator",
  "executionId": "execution:...",
  "expectedEventId": "event:execution:...:CompletedIssueValidation",
  "contentVersion": "2026-08-13T01:00:00Z",
  "profileRef": "issue-validator@AGENT_PROFILE_BLOB_SHA"
}
```

The tool does not accept repository, Project, field, option, status, actor,
event type, result, timestamp, comment body, REST operation, or GraphQL input.
It derives the validation result from the authoritative issue body and
generates `completedAt` on the server.

Success returns only verified completion identifiers:

```json
{
  "eventId": "event:execution:...:CompletedIssueValidation",
  "commentNodeId": "IC_...",
  "projectItemNodeId": "PVTI_...",
  "projectStatus": "AwaitingRouting",
  "reconciled": false
}
```

## Ordered behavior

For each call, the reporter:

1. Rejects malformed or additional input and verifies the deterministic
   `expectedEventId` and `issue-validator@<40-character-blob-SHA>` profile.
2. Resolves the PAT identity from GitHub.
3. Reads the fixed-repository Issue and verifies its number and node ID.
4. Resolves organization `drasi-project` Project number `3`, requires its node
   ID to be `PVT_kwDOCX0YF84BgNE3`, and verifies that the supplied Project Item
   belongs to it and contains that exact fixed-repository Issue.
5. Reads issue comments and requires exactly one pure-JSON
   `workgraph.execution/v1` comment from the configured trusted launcher. The
   record must be `started` and match the route, responsibility, execution,
   expected event, event type, agent profile, and profile reference.
6. Re-evaluates the case-sensitive complete-line marker
   `WorkGraph-Validation: pass`.
7. Builds the canonical `WorkGraphEvent/v1` payload with fixed actor, subject,
   repository, and event type, the derived result, and a server-generated UTC
   `completedAt`.
8. Searches for the deterministic event ID. It adopts only one schema-valid,
   canonically formatted matching comment whose author ID equals the current
   PAT identity. Spoofed or conflicting comments cannot satisfy reconciliation.
9. Creates the canonical comment when none exists. If the POST result is
   ambiguous, it searches again and adopts only the authenticated canonical
   comment; otherwise it fails without changing Project status.
10. Only after the comment exists, sends one fixed
    `updateProjectV2ItemFieldValue` mutation using the literal Project, field,
    and option IDs above.
11. Reads the Item back and returns success only when its `Status` value is
    observed as `AwaitingRouting`.

An explicit comment failure never produces a status mutation. A retry after a
status failure adopts the existing comment instead of creating a duplicate.

## Agents configuration

In the repository, open **Settings > Secrets and variables > Agents** and add:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `COPILOT_MCP_WORKGRAPH_TOKEN` | Write-capable PAT; never commit it |
| Variable | `COPILOT_MCP_WORKGRAPH_LAUNCHER_LOGIN` | Exact trusted login that authors execution comments |

Names use the required `COPILOT_MCP_` prefix, so the values are available only
to MCP configuration. The agent profile maps them to the local server as
`WORKGRAPH_TOKEN` and `WORKGRAPH_LAUNCHER_LOGIN`.

The PAT must:

- be restricted to `drasi-project/drasi-workgraph-demo`;
- read repository and Issue metadata and write Issue comments;
- read and write organization ProjectV2 data for Project
  `PVT_kwDOCX0YF84BgNE3`;
- be authorized for organization SSO when required.

Do not use an Actions secret, the Actions `GITHUB_TOKEN`, an installation token,
or the default cloud-agent GitHub MCP token. The PAT owner becomes the observed
completion-comment author and must be allowlisted by the router for the active
agent execution.

After merging the profile, obtain its blob SHA for launcher prompts and
execution records:

```bash
git rev-parse HEAD:.github/agents/issue-validator.agent.md
```

## Tests and activation gate

Node is preinstalled on GitHub-hosted cloud runners; the server has no package
dependencies. Run:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --test tests/workgraph-reporter.test.mjs
python3 -m unittest discover -s tests -v
```

The Node suite spawns the actual stdio process and uses a local fake GitHub HTTP
server. It covers protocol negotiation, the single tool surface, additional
input rejection, fixed mutation IDs, comment-before-status ordering, duplicate
adoption, spoof rejection, ambiguous-create reconciliation, and no status write
after comment failure.

Before automated routing, run a manual Agent Task against a disposable Issue
with `create_pull_request=false`. This remains an activation blocker because
local tests cannot prove cloud MCP startup, PAT/SSO policy, live Project
configuration, or observed author allowlisting. Prove both the normal path and
an interrupted comment response before enabling the router.
