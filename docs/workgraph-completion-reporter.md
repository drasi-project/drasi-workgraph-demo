# WorkGraph completion reporter

The issue-validator agent requires one repository-configured MCP capability:
`workgraph/report_completion`. GitHub's built-in cloud-agent GitHub MCP token is
read-only by default, so the existence of separate
`github/add_issue_comment` and `github/projects_write` tools does not prove that
an Agent Task can use them. The profile intentionally does not expose those
broad mutation tools.

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

1. Authenticate the active execution and require matching `eventId`,
   `executionId`, `responsibilityId`, `actorId`, `profileRef`, repository,
   subject, and Project Item claims.
2. Validate the complete `workgraph.event/v1` schema and allow only
   `CompletedIssueValidation`.
3. Format exactly one comment beginning with `WorkGraphEvent/v1`, followed by
   one fenced `json` object and no unrelated text.
4. Create the comment using its authenticated identity.
5. Only after the comment exists, update the specified organization ProjectV2
   Item's `Status` field to the fixed option `AwaitingRouting`.
6. Return success only after both ordered operations succeed.

If comment creation has an ambiguous result, the reporter must search the
target issue for the deterministic `eventId`. It may adopt only a schema-valid
comment written by its own authenticated identity for the active execution.
Untrusted issue content or a matching comment from another author cannot
satisfy reconciliation. Once the comment exists, a status retry must not create
a second comment.

## Activation blocker

This repository does not contain or configure the MCP server implementation.
Before activating the agent, repository administrators must configure a trusted
server exposing exactly `workgraph/report_completion`, grant that server
source-repository issue-comment write and organization Projects write access,
and run a manual Agent Tasks probe with `create_pull_request=false`.

The probe must prove that the reporter creates the canonical comment, that the
observed author matches the active agent execution, and that it writes
`AwaitingRouting` only after the comment exists. Do not enable automated routing
until this probe passes.
