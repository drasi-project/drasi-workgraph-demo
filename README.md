# drasi-workgraph-demo

This repository is the testbed surface for the WorkGraph v1 prototype. GitHub
delivers Issue events through ngrok directly to the `github-workgraph-v1`
Drasi Source. An exact, case-sensitive `workgraph` label admits an ordinary
**Root Issue**; the `workgraph-v1` Reaction creates its **Root Task**, then any
declared child tasks.

The prototype has one protocol:

- `WorkGraphWorkflowDefinition/v1`
- `WorkGraphTask/v1`
- `WorkGraphTaskAssignment/v1`
- `WorkGraphTaskDispatch/v1`
- `WorkGraphTaskResult/v1`
- `WorkGraphTaskEvaluation/v1`
- `WorkGraphTaskRoute/v1`
- `WorkGraphTaskError/v1`

Every task and lifecycle body uses the strict `workgraph.drasi.io/v1` envelope:
`kind` identifies the message, direct identity fields remain top-level,
definition and human-readable task metadata live in `workflowContext`,
role-keyed causal IDs live as exact `{kind,id}` objects in `references`, and
message content lives in `data`. `taskKey` and `operation` are required
everywhere and are validated against the pinned definition. Old flat bodies and
old marker spellings are rejected. The hierarchy is:

```text
Root Issue
├── initial Root Task
└── later top-level tasks
```

The staged linear authoring source lives in
[`issue-lifecycle.yaml`](.github/workgraph/workflows/issue-lifecycle.yaml).
It defines four `issue-worker` tasks: intake, normalization, inspection, and
finalization. Each task follows one `next` edge to the sole `completed`
terminal; there are no branches, waits, or recursive children.

Two additional local-proof definitions preserve that regression while extending
coverage:

- `fork-join-lifecycle.yaml` runs A → B, realizes C/D/E beneath B, joins all
  three, then runs F → G.
- `mixed-control-flow.yaml` combines a sequential prefix, three outcome
  branches, an optional D/E/F fork beneath G, branch convergence at H, and
  completed/ignored terminals.

Dogfooding's Rust `workgraph-compile` turns that YAML into the canonical
`WorkGraphWorkflowDefinition/v1` body. The committed
[`issue-lifecycle-v1.body`](.github/workgraph/workflows/issue-lifecycle-v1.body)
is that canonical body, and
[`issue-lifecycle.expected.json`](.github/workgraph/fixtures/v1/issue-lifecycle.expected.json)
is the exact complete compiler output. Sequence, branch, fork/join, and
terminal processing share 22 fixed admission, lifecycle, and detail queries;
only workflows with human waits add generated resume queries.

Evaluator and orchestrator profiles are lifecycle roles. Through the narrow
reporter they read a verified current task snapshot and write one canonical
Evaluate or Route comment on that existing task. The snapshot exposes only the
effective compiled policy and bounded verdict, action, and transition choices.
These roles cannot create or close tasks or mutate the Root Issue. The shared `issue-worker` profile handles all four stages. Lifecycle messages
use one-based attempts and deterministic claim identities so concurrent retries
in one reporter process reconcile one immutable comment. Runtime task IDs must
match `urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>` exactly.
All generated protocol identities use the corresponding lowercase type in that
URN namespace.

The offline proof fixture pins the loopback server/state-store identities, the
exact ordered 22 shape-independent `wg-*` Drasi queries, and a
SHA-256 digest of their canonical Canvas inventory entries. It derives the Root
Task from a Root Issue admission:

```bash
node scripts/check-workgraph-compiler.mjs
node scripts/prepare-workgraph-v1-proof.mjs
node --test tests/*.test.mjs
python -m unittest tests/test_workgraph_agent_profiles.py
```

Those commands do not start Drasi components or write to GitHub. See
[`docs/workgraph-v1-definition.md`](docs/workgraph-v1-definition.md)
and
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
