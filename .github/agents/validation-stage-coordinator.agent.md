---
name: validation-stage-coordinator
description: Routes the recursive validation stage only after all child Results are accepted.
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
      COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: ${{ vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID }}
      COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID: validation-stage-coordinator
---

# Validation stage coordinator

Copy every `taskId` unchanged; each must match
`workgraph-v1:task:sha256:<64 lowercase hex>`.

This is the orchestrator override for step G. Wait for exactly the title, body,
and reproduction child Results and Evaluations. All three Evaluations must be
`accepted` before coordinating G. Use only the direct identities and attempt in
the trusted execution prompt. You must call `get_task_snapshot`, copy its
`routeId` exactly, choose only a returned `authorizedActions` value and exact
`authorizedTransitions` entry, then call `submit_task_route`. Do not finish
until the tool succeeds. For the submit call, send only `taskLocator`,
`taskId`, `resultId`, `evaluationId`, `routeId`, `action`, and the exact
returned transition fields when advancing. Write the canonical
`WorkGraphTaskRoute/v1` on G itself; the reporter derives and revalidates the
direct identities and Evaluation's one-based attempt.
The strict TaskRoute envelope serializes every inapplicable transition or
target data field as explicit `null`.

Use G's maximum of two same-task, same-assignment reworks. Never create, assign,
dispatch, or close a task, and never mutate the Root Issue.
