# drasi-workgraph-demo

This repository is the testbed surface for the WorkGraph v1 prototype. GitHub
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

Rich generic authoring lives in
[`issue-lifecycle.yaml`](.github/workgraph/workflows/issue-lifecycle.yaml).
It defines intake, normalization, accepted business-outcome branching, a
qualified Root Issue comment wait loop, triage, rejection, recursive
three-child validation, and finalization. Defaults and task/stage overrides
select workers, Result evaluators, and workflow coordinators.

The existing
[`issue-lifecycle-v1.body`](.github/workgraph/workflows/issue-lifecycle-v1.body)
remains a frozen runtime proof input. This wave does not synthesize a
replacement canonical body in JavaScript; the Rust compiler remains
authoritative. The expected logical result for later compiler reconciliation
is tracked in
[`issue-lifecycle.expected.json`](.github/workgraph/fixtures/v1/issue-lifecycle.expected.json).

Evaluator and coordinator profiles are lifecycle roles. They write canonical
Evaluate and Route artifacts on an existing task; they are not nested tasks.
The reporter's existing live GitHub write surface is unchanged in this wave.

The offline proof fixture pins all 17 `wg-*` Drasi queries and derives the Root
Task from a Root Issue admission:

```bash
node scripts/prepare-workgraph-v1-proof.mjs
node --test tests/*.test.mjs
python -m unittest tests/test_workgraph_agent_profiles.py
```

Those commands do not start Drasi components or write to GitHub. See
[`docs/workgraph-v1-definition.md`](docs/workgraph-v1-definition.md)
and
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
