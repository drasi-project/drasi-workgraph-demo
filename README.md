# drasi-workgraph-demo

This repository is the testbed surface for the WorkGraph v1 prototype. GitHub
delivers Issue events through ngrok directly to the `github-workgraph-v1`
Drasi Source. An explicit deployment `workflowMappings` entry binds an exact,
case-sensitive `workgraph:<workflow-id>` label to a definition. That label
admits an ordinary **Root Issue**; the `workgraph-v1` Reaction creates its
**Root Task**, then any declared child tasks. Deployments require
`workflowMappings` and a separate, non-null `admissionRead` object. Its token
must be non-empty, and its resolved `apiBaseUrl` must be non-empty (the URL may
use the field default). `agentConfig` reads only the actor catalog and is never
an authoritative Issue-read fallback. Both `agentConfig` and `protocolTrust`
are required non-null objects; `protocolTrust.taskCreators`, `assigners`, and
`reporters` must each be non-empty. There is no passive Source-only mode: the
Source converges the actor catalog before accepting a delivery. The Reaction
consumes the mapping-specific admission ID supplied on the Root Issue rather
than recomputing a top-level admission.

The prototype has one protocol:

- `WorkGraphWorkflowDefinition/v1`
- `WorkGraphTask/v1`
- `WorkGraphTaskAssignmentRequest/v1`
- `WorkGraphTaskAssignment/v1`
- `WorkGraphTaskFork/v1`
- `WorkGraphTaskJoin/v1`
- `WorkGraphTaskDispatch/v1`
- `WorkGraphTaskResult/v1`
- `WorkGraphTaskEvaluation/v1`
- `WorkGraphTaskRoute/v1`
- `WorkGraphTaskError/v1`
- `WorkGraphTaskResponse/v1`

Every task and lifecycle body uses the strict `workgraph.drasi.io/v1` envelope:
`kind` identifies the message, direct identity fields remain top-level,
definition and human-readable task metadata live in `workflowContext`,
role-keyed causal IDs live as exact `{kind,id}` objects in `references`, and
message content lives in `data`. `taskKey` and `operation` are required
everywhere and are validated against the pinned definition. No alternate flat
body or marker spelling is accepted. The hierarchy is:

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

A fourth definition, `scoped-control-flow.yaml`, exercises `flowEntries`. Its
initial `run` task is a workflow container that launches the `fix` and `notify`
scopes in parallel, joins them, and is itself the run's finalizer, routing
directly to the `completed` terminal. `fix` is itself a container that owns the
nested `audit` scope before running its own cleanup, and `notify` is a plain
routed task. `run` is the only direct Root Issue child; every task of a scope is
a native direct sub-issue of the container that launched it:

```text
Root Issue
└── initial run Task (container and finalizer)
    ├── fix (flow entry, container)
    │   ├── fix-evidence (fixed child, inherits fix's scope)
    │   ├── audit (nested flow entry)
    │   └── audit-verify (routed)
    ├── fix-cleanup (routed)
    └── notify (flow entry)
```

A fifth definition, `human-parity.yaml`, treats humans and agents as
interchangeable executors: a human worker graded by an agent evaluator, then an
agent worker graded by a human evaluator. The workflow names actor IDs
identically in both directions; the strict `version: 1` actor catalog in
`agents.yaml` is what marks `human-agentofreality` as a human and binds the
GitHub account it speaks as. The catalog accepts only `actors`/`actorId`;
catalog `version: 2` and the former `agents`/`agentId` shape are not aliases.

`assigner-parity.yaml` allocates the Assignment decision itself to an actor.
Its first task has `human-agentofreality` choose an agent worker; its second has
the `assignment-coordinator` agent choose a human worker. The assigner receives
no lease. Only the selected worker enters the ordinary
Assignment → Lease → Dispatch lifecycle.

Dogfooding's Rust `workgraph-compile` turns that YAML into the canonical
`WorkGraphWorkflowDefinition/v1` body. The committed
[`issue-lifecycle-v1.body`](.github/workgraph/workflows/issue-lifecycle-v1.body)
is that canonical body, and
[`issue-lifecycle.expected.json`](.github/workgraph/fixtures/v1/issue-lifecycle.expected.json)
is the exact complete compiler output. Sequence, branch, fork/join, and
terminal processing share the same five fixed, definition-independent `wg-*`
fact queries. No workflow shape or human role adds generated queries.

Assigner, evaluator, and orchestrator profiles are lifecycle roles. Through the
narrow reporter they read a verified current task snapshot and write one
canonical Assignment, Evaluation, or Route comment on that existing task. The
snapshot exposes only the effective compiled policy and bounded choices.
These roles cannot create or close tasks or mutate the Root Issue. The shared `issue-worker` profile handles all four stages. Lifecycle messages
use one-based attempts and deterministic claim identities so concurrent retries
in one reporter process reconcile one immutable comment. Runtime task IDs must
match `urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>` exactly.
All generated protocol identities use the corresponding lowercase type in that
URN namespace.

The actor catalog also includes separate agents for duplicate detection,
related-Issue search, template conformance, likely code areas, resolution
planning, implementation, and correctness/design/documentation/prior-art/
security/testing PR reviews. Every agent-authored Result contains a
`rootIssueComment` candidate. The agent never posts it directly; the runtime
adds it to the ordinary Root Issue only after an accepted Evaluation.
Every agent entry explicitly names its `customAgent` and
`createPullRequest` policy. The planner and implementer set
`createPullRequest: true`; protocol-only workers and all lifecycle roles
explicitly set it to `false`. Both fields are required and non-null for agents.
Human entries omit both and instead require their exact `github` identity.

The offline proof fixture pins the loopback server/state-store identities, the
exact ordered five shape-independent `wg-*` Drasi queries, and a
SHA-256 digest of their canonical Canvas inventory entries. It selects the
workflow through an explicit mapping and derives the Root Task from that
mapping's Root Issue admission:

```bash
WORKGRAPH_PLUGINS_DIR=../drasi-dogfooding/git-workgraph/plugins \
  node scripts/check-workgraph-compiler.mjs
node scripts/prepare-workgraph-v1-proof.mjs
node --test tests/*.test.mjs
python -m unittest tests/test_workgraph_agent_profiles.py
```

Those commands do not start Drasi components or write to GitHub. See
[`docs/workgraph-v1-definition.md`](docs/workgraph-v1-definition.md)
and
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
