# drasi-workgraph-demo

This repository is the Demo surface for the WorkGraph v1 prototype. GitHub
delivers Issue events through ngrok directly to the `github-workgraph-v1`
Drasi Source. An exact, case-sensitive `workgraph` label admits an ordinary
**Root Issue**; the `workgraph-v1` Reaction creates its **Root Task**, then any
declared child tasks.

The prototype has one protocol:

- `WorkGraphWorkflowDefinition/v1`
- `WorkGraphTask/v1`
- `WorkGraphTaskAssign/v1`
- `WorkGraphTaskDispatch/v1`
- `WorkGraphTaskResult/v1`
- `WorkGraphTaskEvaluate/v1`

Every task carries top-level `rootIssueId`. The hierarchy is:

```text
Root Issue
└── Root Task
    └── child task
```

The frozen workflow
[`issue-lifecycle-v1.body`](.github/workgraph/workflows/issue-lifecycle-v1.body)
contains one Root Task definition and one validator child definition. The only
configured executors are:

- `demo-orchestrator`
- `issue-validator`

Both profiles use the narrow
[`workgraph-reporter.mjs`](.github/mcp/workgraph-reporter.mjs) MCP server. It
exposes only `get_root_issue` and `submit_task_result`. Result creation verifies
the canonical Dispatch and the exact active Source Lease before writing one
`WorkGraphTaskResult/v1` comment.

The offline proof fixture pins all 17 `wg-*` Drasi queries and derives the Root
Task from a Root Issue admission:

```bash
node scripts/prepare-workgraph-v1-proof.mjs
node --test tests/*.test.mjs
python -m unittest tests/test_workgraph_agent_profiles.py
```

Those commands do not start Drasi components or write to GitHub. See
[`docs/workgraph-v1-definition-demo.md`](docs/workgraph-v1-definition-demo.md)
and
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
