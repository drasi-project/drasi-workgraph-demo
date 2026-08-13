# WorkGraph completion reporter

The issue-validator agent requires one repository-configured MCP capability:
`workgraph/report_completion`. GitHub's built-in cloud-agent GitHub MCP token is
read-only by default, so the existence of separate
`github/add_issue_comment` and `github/projects_write` tools does not prove that
an Agent Task can use them. The profile intentionally does not expose those
broad mutation tools.

This repository ships a local stdio MCP server at
`.github/mcp/workgraph_reporter.py` and configures it in the agent profile. The
server uses only Python's standard library and exposes only
`report_completion`.

## Tool contract

`workgraph/report_completion` accepts only:

```json
{
  "projectOwner": "organization-login",
  "projectNumber": 1,
  "event": {
    "schemaVersion": "workgraph.event/v1",
    "eventId": "event:execution:...:CompletedIssueValidation",
    "eventType": "CompletedIssueValidation",
    "projectItemNodeId": "PVTI_...",
    "subjectType": "Issue",
    "subjectNodeId": "I_...",
    "repository": "owner/repository",
    "subjectNumber": 1,
    "actorType": "Agent",
    "actorId": "issue-validator",
    "routeId": "validation:...",
    "responsibilityId": "validation:...:issue-validator",
    "executionId": "execution:...",
    "contentVersion": "2026-08-13T01:00:00Z",
    "profileRef": "issue-validator@AGENT_PROFILE_BLOB_SHA",
    "result": {
      "outcome": "passed",
      "reasonCode": "required-marker-present",
      "evidence": {
        "requiredMarker": "WorkGraph-Validation: pass",
        "found": true
      },
      "summary": "The required prototype marker is present."
    },
    "completedAt": "2026-08-13T01:00:20Z"
  }
}
```

The tool must reject additional properties. It must not accept a comment body,
status value, field selector, GraphQL document, repository mutation, or generic
GitHub API request.

The result contains only the verified completion identifiers:

```json
{
  "eventId": "event:execution:...:CompletedIssueValidation",
  "commentNodeId": "IC_...",
  "projectItemNodeId": "PVTI_...",
  "projectStatus": "AwaitingRouting",
  "reconciled": false
}
```

## Required behavior

The reporter must:

1. Require the configured repository, Project owner and number, deployed
   profile blob SHA, logical agent ID, and PAT owner login.
2. Validate the deterministic `eventId`, `executionId`, `responsibilityId`,
   `actorId`, `profileRef`, repository, subject, and Project Item claims.
3. Read the authoritative issue and independently reproduce the exact-line
   marker decision before accepting `result`.
4. Validate the complete `workgraph.event/v1` schema and allow only
   `CompletedIssueValidation`.
5. Require the Project Item to belong to the configured Project and contain the
   validated Issue.
6. Format exactly one comment beginning with `WorkGraphEvent/v1`, followed by
   one fenced `json` object and no unrelated text.
7. Create the comment using its authenticated identity.
8. Only after the comment exists, update the specified organization ProjectV2
   Item's `Status` field to the fixed option `AwaitingRouting`.
9. Read the Item back and return success only after `AwaitingRouting` is
   observed.

If comment creation has an ambiguous result, the reporter must search the
target issue for the deterministic `eventId`. It may adopt only a schema-valid
comment written by its own authenticated identity for the active execution.
Untrusted issue content or a matching comment from another author cannot
satisfy reconciliation. Once the comment exists, a status retry must not create
a second comment.

## Repository setup

Configure these Copilot **Agents** settings before starting the validator:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `COPILOT_MCP_WORKGRAPH_GITHUB_TOKEN` | Write-capable PAT; never commit it |
| Variable | `COPILOT_MCP_WORKGRAPH_PROJECT_NUMBER` | Organization ProjectV2 number |
| Variable | `COPILOT_MCP_WORKGRAPH_PROFILE_REF` | `issue-validator@` plus the deployed 40-character profile blob SHA |
| Variable | `COPILOT_MCP_WORKGRAPH_COMMENT_AUTHOR` | Exact GitHub login that owns the PAT |
| Variable | `COPILOT_MCP_WORKGRAPH_EXECUTION_AUTHOR` | Exact trusted launcher login that writes `workgraph.execution/v1` comments |

The PAT must be restricted to `drasi-project/drasi-workgraph-demo`, allow Issue
metadata read and Issue comment write, and allow organization ProjectV2 read
and write for the configured Project. Authorize organization SSO when required.
Do not use the Actions `GITHUB_TOKEN`, an installation token, or the default
read-only cloud-agent GitHub MCP token.

The launcher login must be independently controlled and allowlisted. The
reporter accepts an event only when exactly one pure-JSON
`workgraph.execution/v1` comment from that login has `state=started` and matches
the event's route, responsibility, execution, expected event, agent profile,
and deployed profile reference.

After the profile is merged, derive its blob SHA and set the profile variable:

```bash
blob_sha="$(git rev-parse HEAD:.github/agents/issue-validator.agent.md)"
printf 'issue-validator@%s\n' "${blob_sha}"
```

In the repository, open **Settings > Secrets and variables > Agents**. Create
the secret on the **Secrets** tab and the four variables on the **Variables**
tab. Paste the printed profile reference as the profile variable. Do not use
Actions, Codespaces, or Dependabot secrets, pass the PAT on a command line, or
store it in a variable.

## Activation probe

Run the local protocol tests without a token:

```bash
python3 -m unittest discover -s tests -v
```

Then run a manual Agent Task against a disposable issue with
`create_pull_request=false`. This live probe is an activation blocker because
unit tests cannot prove cloud-agent MCP startup, PAT policy, SSO authorization,
Project field configuration, or the observed GitHub comment identity.

The probe must prove that the reporter creates the canonical comment, that the
observed author equals `COPILOT_MCP_WORKGRAPH_COMMENT_AUTHOR` and is allowlisted
for the active agent execution, and that it writes `AwaitingRouting` only after
the comment exists. Repeat with an intentionally interrupted comment response
to prove authenticated reconciliation does not create a duplicate. Do not
enable automated routing until these probes pass.
