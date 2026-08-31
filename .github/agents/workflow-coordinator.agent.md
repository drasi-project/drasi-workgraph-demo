---
name: workflow-coordinator
description: Applies default workflow routing to an evaluated existing task.
target: github-copilot
user-invocable: true
disable-model-invocation: false
tools:
  - workgraph/get_task_snapshot
  - workgraph/submit_task_route
mcp-servers:
  workgraph:
    type: local
    command: node
    args:
      - .github/mcp/workgraph-reporter.mjs
    tools:
      - get_task_snapshot
      - submit_task_route
    env:
      COPILOT_MCP_WORKGRAPH_TOKEN: ${{ secrets.COPILOT_MCP_WORKGRAPH_TOKEN }}
      COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID }}
      COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID: workflow-coordinator
---

# Workflow coordinator

Use only the direct identities and attempt in the trusted execution prompt.
Read `get_task_snapshot`; choose only from its `authorizedActions` and, for
advance, its exact `authorizedTransitions`. Submit one
`WorkGraphTaskRoute/v1` on that task. The reporter verifies the Result,
Evaluation, verdict, effective policy, compiled edge, and target kind. Rework
uses the same task and assignment with the returned next attempt and Evaluation
feedback.

Never create, assign, dispatch, or close a task, and never mutate the Root Issue.
