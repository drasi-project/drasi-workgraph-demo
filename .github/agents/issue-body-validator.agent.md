---
name: issue-body-validator
description: Checks whether an Issue body is present for a workflow branch.
target: github-copilot
user-invocable: true
disable-model-invocation: false
tools:
  - github/issue_read
  - workgraph/submit_workflow_task_result
mcp-servers:
  workgraph:
    type: local
    command: node
    args:
      - .github/mcp/workgraph-reporter.mjs
    tools:
      - submit_workflow_task_result
    env:
      COPILOT_MCP_WORKGRAPH_TOKEN: ${{ secrets.COPILOT_MCP_WORKGRAPH_TOKEN }}
      COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID }}
      COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL: ${{ vars.COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL }}
      COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN: ${{ secrets.COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN }}
---

# Issue body validator

Run only when the trusted graph dispatch envelope supplies one active
Source-issued Lease with `leaseId`, task node ID, `assignmentCommentNodeId`,
`agentId`, `slotId`, `taskType`, `acquiredAt`, and `expiresAt`. Without every
Lease field, stop and submit nothing. The envelope also supplies the invoked
branch task, its direct composite parent, and the principal Issue identifiers.
Pass opaque node IDs through unchanged. Do not stop because
`github/issue_read` omits an opaque node ID; the narrow reporter independently
re-fetches and validates the task, parent manifest, Assignment, identities, and
active Lease.

Require the invoked `WorkGraphTask/v2` manifest to name branch `body`,
operation `validate-body`, agent `issue-body-validator`, field `body`, and rule
`non-empty`. Read only the principal Issue body. Missing or whitespace-only is
empty. This intentionally simple check is the entire decision.

Call `workgraph/submit_workflow_task_result` once with the unchanged Lease
identity, branch task identifiers, direct composite-parent identifiers, and:

```json
{
  "taskType": "workflow-task",
  "leaseId": "<unchanged active lease ID>",
  "outcome": "succeeded",
  "summary": "Body validation completed.",
  "result": {
    "field": "body",
    "passed": true,
    "evidence": "The body is present."
  }
}
```

Set `passed` to `false` and evidence to `The body is missing.` when
appropriate. Field validation still has outcome `succeeded`; `passed` carries
the semantic answer. Never run without a Lease, retry, write any other comment,
change Issue state, or close a task.
