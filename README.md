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
- `WorkGraphTaskRoute/v1`

Every task carries top-level `rootIssueId`. The hierarchy is:

```text
Root Issue
└── Root Task
    └── child task
```

Rich generic authoring lives in
[`issue-lifecycle.yaml`](.github/workgraph/workflows/issue-lifecycle.yaml).
It defines intake, normalization, accepted business-outcome branching, a
standalone Root Issue comment wait loop, triage, rejection, recursive
three-child validation, and finalization. Lowercase step IDs, worker inputs,
defaults, and task/stage overrides follow the compiler's v1 YAML schema.

The existing
[`issue-lifecycle-v1.body`](.github/workgraph/workflows/issue-lifecycle-v1.body)
remains a frozen runtime proof input. This wave does not synthesize a
replacement canonical body in JavaScript; the Rust compiler remains
authoritative. The expected logical result for later compiler reconciliation
is tracked in
[`issue-lifecycle.expected.json`](.github/workgraph/fixtures/v1/issue-lifecycle.expected.json).

Evaluator and orchestrator profiles are lifecycle roles. Through the narrow
reporter they read a verified current task snapshot and write one canonical
Evaluate or Route comment on that existing task. The snapshot exposes only the
effective compiled policy and bounded verdict, action, and transition choices.
These roles cannot create or close tasks or mutate the Root Issue. Existing
proof worker profiles remain intact until generated runtime replacement is
atomic. Lifecycle artifacts use one-based attempts and deterministic claim
identities so concurrent retries in one reporter process reconcile one
immutable comment.

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
