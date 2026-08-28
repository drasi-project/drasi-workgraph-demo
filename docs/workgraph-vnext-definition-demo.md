# WorkGraph VNext definition Demo

This repository vendors the frozen definition-driven WorkGraph contract for a
network-free Demo proof. It does not enable a Source, Continuous Query,
Reaction, GitHub writer, or live runtime path.

## Definition/runtime split

`WorkGraphWorkflowDefinition/v1` is immutable and owns every static field:
workflow identity and version, digest, recursive task identities and keys,
operation, permitted executors, static inputs, and direct children. Every leaf
has an explicit `children: []`.

`WorkGraphTask/v3` is a thin run instance. It contains only task/run identity,
the exact pinned workflow definition identity/version/digest, its
`taskDefinitionId`, and run-specific `resolvedInputs`. It never copies
operation, routing, static inputs, or children.

The frozen compatibility pair is:

- `.github/workgraph/workflows/issue-lifecycle-vnext.body`
- `.github/workgraph/fixtures/vnext/workgraph-vnext-live-proof-root-task.body`

The definition is the authoritative Dogfood fixture byte-for-byte. A future
isolated proof publishes that definition and creates only the root task. It
must not pre-create `demo-validate-v1`; the first lifecycle action is `FORK`,
which owns child materialization. Task-before-definition replay is intentional.

There is one VNext prototype definition in the repository. The validator tests
also compile the canonical kernel nested vector: a root with two ordered direct
children, one of which contains a leaf. This proves recursive formatting,
static inputs/routing, deterministic globally unique task definition IDs and
task keys, leaf `children: []`, and parent/direct-child behavior without
publishing a second competing workflow definition.

`.github/workgraph/fixtures/vnext/live-proof-inputs.json` records deterministic
no-write inputs for the frozen replay order, recursive lifecycle, two executor
slots, exact good/bad Result chains and evaluation routes, human Request
Info/resume, and restart reconciliation boundaries. It pins
`RESULT_INDEX_STATE_VERSION=5`; any isolated runtime prepared from older query
state must clear that state before use.

## Frozen provenance

The two canonical bodies are copied without modification from:

- Dogfood freeze:
  `drasi-project/drasi-dogfooding@986ba3f6a2a56f0dbc422030054c822bc6d3fa20`
- Dogfood hardening parent:
  `20a1f5d13416818751eac1a218552c507b6ffc49`
- Core feature branch:
  `drasi-project/drasi-core@c6615b450b0be85694f2e77460cf892617eb946e`

Canonical Dogfood paths and Git blob IDs:

| Artifact | Dogfood path | Blob |
| --- | --- | --- |
| Definition | `git-workgraph/plugins/github-workgraph-vnext-source/fixtures/workgraph-vnext-live-proof-definition.body` | `6b357e0609a1b2fb1e75a94bed536c0ab095fa80` |
| Root task | `git-workgraph/plugins/github-workgraph-vnext-source/fixtures/workgraph-vnext-live-proof-root-task.body` | `291df48d878b889210f44c1915711244f1a9c13a` |
| Kernel contract | `git-workgraph/plugins/workgraph-kernel/src/lib.rs` | `34c4feb227d47493f24588e524cc846ae34962bc` |
| VNext Source | `git-workgraph/plugins/github-workgraph-vnext-source/src/lib.rs` | `0d1b6308c586a3d37e4f4085ff901b2f064011cb` |
| VNext Reaction | `git-workgraph/plugins/workgraph-vnext-reaction/src/lib.rs` | `eb045e3b23feb887a5029e2a808bfdb214e7aee3` |

The canonical definition is 846 bytes with SHA-256
`1cd5b13c8017395dabbf25eb75465034cd54b6545be7d9fe889def1909aa66c7`.
The canonical root is 384 bytes with SHA-256
`1cc6dfb17b655e26d53e4ade591b56f7b3adf693b01320bc8e371b150c6d936c`.
Tests guard both byte streams. Provenance remains external because changing a
body would break fixture compatibility.

## Local validation

Run the focused VNext checks:

```bash
node --check .github/mcp/workgraph-vnext-definition.mjs
node --test tests/workgraph-vnext-definition.test.mjs
```

Run all existing network-free Demo checks:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --check .github/mcp/workgraph-v2-protocol.mjs
node --check .github/mcp/workgraph-vnext-definition.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

The explicit GitHub integration suite remains V1-only and is not part of this
fixture proof.

## Activation boundary

VNext has no production server configuration, dynamic plugin descriptor, or
GitHub adapter in the frozen contract. An isolated live activation requires a
separately reviewed Dogfood adapter/wiring checkpoint, exact repository-local
definition and root bytes, `RESULT_INDEX_STATE_VERSION=5` state (with all
pre-v5 query state removed), explicit `Disabled` or `Mocked` effects, and
credentials supplied only when a later write gate is approved. This repository
must not use sibling worktrees, absolute local dependencies, runtime fixture
downloads, or real GitHub writes for the prepared proof.

## Integration decisions

1. Legacy `.github/workgraph/workflows/issue-lifecycle.yaml` and every V2
   protocol/config path remain unchanged.
2. The minimal frozen body is the single current VNext prototype definition;
   recursive coverage remains a deterministic compiler and proof-input vector.
3. The JavaScript formatter mirrors the frozen kernel contract rather than
   introducing a new authoring schema or a body-digest algorithm.
4. Runtime fixture bodies contain only V3 instance fields; all static workflow
   data remains on task definitions.
5. Proof inputs are dormant, deterministic repository resources. They describe
   the later isolated proof but do not activate a runtime or perform writes.
