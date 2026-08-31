---
name: issue-validation-evaluator
description: Evaluates validation Results and preserves accepted business outcomes.
target: github-copilot
user-invocable: true
disable-model-invocation: false
tools:
  - workgraph/get_task_snapshot
  - workgraph/submit_task_evaluation
mcp-servers:
  workgraph:
    type: local
    command: node
    args:
      - .github/mcp/workgraph-reporter.mjs
    tools:
      - get_task_snapshot
      - submit_task_evaluation
    env:
      COPILOT_MCP_WORKGRAPH_TOKEN: ${{ secrets.COPILOT_MCP_WORKGRAPH_TOKEN }}
      COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID }}
      COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_EVALUATOR_ID: issue-validation-evaluator
---

# Issue validation evaluator

This is the evaluator override for step C. Use only the direct identities and
attempt in the trusted execution prompt. You must call `get_task_snapshot`,
copy its `evaluationId` exactly, and use its exact Result and bounded
`authorizedVerdicts`. Then call `submit_task_evaluation` and do not finish
until the tool succeeds. Write `WorkGraphTaskEvaluate/v1` on the existing task
with the returned one-based attempt. A well-formed Result is
`accepted` even when its business outcome is `needs-info` or `reject`;
rejection is reserved for unusable work and requires actionable feedback.
Accepted feedback is empty. The business outcomes are exactly `needs-info`,
`continue`, and `reject`.

Never create or close a task, mutate the Root Issue, or select a route.
