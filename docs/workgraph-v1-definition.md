# WorkGraph v1 definition

These are **Demo-specific fixture and proof notes for the older installed
consumer**, not the current protocol or setup specification.
[`drasi-project/drasi-workgraph`][workgraph] owns the engine, protocol, and Rust
`workgraph-compile` compiler. Use its [canonical definition reference][protocol]
for authoring and lifecycle rules, and its [setup guides][setup] for WorkGraph /
Drasi Server and new sandboxes.

This Demo deliberately retains eight workflow definitions and 21 agent
profiles. The current canonical kit's 13 workflows and 37 profiles have **not**
been installed here. These notes and artifacts preserve the existing
regressions; they are not instructions to regenerate an active sandbox.

## Installed artifacts

The [workflow directory](../.github/workgraph/workflows/) and
[compiled fixtures](../.github/workgraph/fixtures/v1/) retain these eight
definitions:

```text
issue-lifecycle
fork-join-lifecycle
mixed-control-flow
scoped-control-flow
human-parity
assigner-parity
human-assigner-live
drasi-server-issue
```

Each has authored YAML, a complete compiler-output `*.expected.json` fixture,
and a `*-v1.body` containing `canonicalDefinitionBody`. The installed
[JavaScript definition module](../.github/mcp/workgraph-v1-definition.mjs)
parses and validates; it does not independently compile the YAML. The compiler
is in WorkGraph's `plugins/workgraph-kernel` workspace, not in this Demo or
Dogfooding.

The [linear source](../.github/workgraph/workflows/issue-lifecycle.yaml) uses
`workgraph.drasi.io/v1` / `IssueWorkflow`, lowercase task keys `a`-`d`, and
`issue-worker` for all four stages:

```text
a intake -> b normalize -> c inspect -> d finalize -> completed
```

Its defaults are `result-evaluator`, `workflow-coordinator`, and
`maxReworkAttempts: 3`. Each task has one `next`; there are no outcome branches,
waits, or recursive children. The
[linear regression](../.github/workgraph/tests/linear-sequence-v1.json)
supplies one accepted Result per task and pins the exact task set and terminal.
The fork/join and mixed-control-flow fixtures retain separate branching and
parallel regressions rather than changing that linear example.

## Scoped flow entries

See the [canonical scope rules][protocol] for authoring constraints and bounds.
The installed
[`scoped-control-flow.yaml`](../.github/workgraph/workflows/scoped-control-flow.yaml)
preserves this particular regression:

```text
run (container: flowEntries fix, notify) -> completed
  +-- fix (children fix-evidence, flowEntries audit) -> fix-cleanup -> fix-complete
  |     +-- audit -> audit-verify -> audit-complete
  +-- notify -> notify-complete
```

`run` is both the only trunk task and the finalizer: it joins the two scopes
before completing, so it is the only direct Root Issue child. Tasks reached
through a scope's steps are direct sub-issues of its owning container.
`fix-evidence` is instead a fixed child of `fix`, inherits that task's scope
strings, and has no routed step of its own.

The [scoped regression](../.github/workgraph/tests/scoped-control-flow-v1.json)
pins those parents and the following `expected.flowEntries`, ordered by
`(ownerTaskKey, entryStepId)`:

| ownerTaskKey | entryStepId | taskKeys | terminalStepId |
|---|---|---|---|
| `fix` | `audit` | `audit`, `audit-verify` | `audit-complete` |
| `run` | `fix` | `fix`, `fix-cleanup` | `fix-complete` |
| `run` | `notify` | `notify` | `notify-complete` |

`taskKeys` records the selected chain to that scope's terminal. Only the entry
is named by the owner's Fork; successors are authorized by predecessor Routes.
The installed test-case format requires `expected.flowEntries`, using `[]`
for definitions without routed scopes, not missing or null values. The local
[reporter scope notes](workgraph-result-reporter.md#scoped-flow-entries)
describe the ancestry checks that support this fixture.

## Human and agent parity

`human-parity`, `assigner-parity`, and `human-assigner-live` remain installed
regression fixtures, not portable actor-configuration examples. The first
exercises human/agent worker and evaluator positions; the latter fixtures
exercise an explicit pre-lease assignment decision. They do not grant a
lifecycle role a worker Lease.

Use the [canonical actor/profile guide][profiles] and
[human/agent protocol reference][protocol] for current configuration and role
rules. Do not copy this instance's person bindings into a new sandbox.

## Normalized inbound evidence

The [canonical evidence reference][protocol] owns the Response envelope,
mention matching, byte-preserving encoding, revision rules, and role-specific
subjects. The installed
[definition regressions](../tests/workgraph-v1-definition.test.mjs) and
[reporter regressions](../tests/workgraph-reporter.test.mjs) preserve this
Demo's strict parsing and provenance expectations. A human reply belongs on
the instructed Task Issue; it is evidence for a trusted writer, not an
authoritative Result or Evaluation by itself.

## Runtime message envelope

Use the [canonical envelope reference][protocol] for wire fields, ID
derivation, digests, transitions, and rework policy. The committed bodies and
tests remain the exact evidence for what this older installed parser accepts;
newer canonical behavior must not be assumed to exist in that parser.

In particular, `queryBundle.queries` and `queryBundle.canvasInventory` are
empty arrays: control flow is interpreted by the runtime using the five fixed
fact queries below, not generated resume or per-edge queries. The local rework
helper preserves `taskId` and `assignmentId` and increments the bounded
attempt. It does not choose a new worker or allocate a Lease; same-worker
rework scheduling belongs to the runtime described in the canonical reference.

## Admission-first proof

The [proof inputs](../.github/workgraph/fixtures/v1/live-proof-inputs.json)
start with an ordinary Root Issue carrying the exact
`workgraph:issue-lifecycle` selector and a source-supplied `workflowMappings`
entry. The proof consumes that mapping's admission-generation ID without
recomputing it, then derives:

1. the Root Issue content digest;
2. the workflow run ID from the selected mapping admission;
3. the Root Task ID and canonical body;
4. the first lifecycle state, `ASSIGN`, because the Root Task is a leaf.

No Root Task is pre-seeded. In live operation the `workgraph-v1` Reaction,
not this proof or the shopping seeder, creates the Root Task as a native
`WorkGraphTask` sub-issue of the ordinary Root Issue.

The proof pins the exact ordered runtime query inventory:

```text
wg-root-state
wg-task-state
wg-task-actions
wg-lease-state
wg-root-comments
```

These are five shape-independent fact queries: one for admission and four for
task, action, lease, and Root-comment facts. No sequence, branch, fork, wait,
or terminal adds a query.

The fixture's `runtimeContract` names `server-config-v1-loopback.yaml` and
`data/workgraph-v1-loopback.redb`, not production runtime paths. Its keys are
the Source and Reaction IDs, those two loopback paths, `queryIds`, and
`queryContractDigest`. These are fixture strings, not instructions to read,
create, replace, or start a live configuration or state store.

`queryContractDigest` is `sha256:` plus the SHA-256 of compact JSON for the
ordered five entries projected to exactly `{"id","sha256"}`, in that key
order. Entries and hashes come from the
[vendored runtime contract](../.github/workgraph/contracts/runtime-v1.json).
The compiler inventory must be empty, binding the proof to query content as
well as names.

The [proof preparer](../scripts/prepare-workgraph-v1-proof.mjs) reads the
committed proof inputs, contract, selected body, and compiler fixture and
prints JSON to stdout. It checks the selected body's exact
`canonicalDefinitionBody` and keeps activation disabled: `dryRun: true`,
`liveAcknowledgment: false`, and `githubWritesAllowed: false`. Preparing that
proof starts no Drasi components and performs no GitHub or runtime mutation.
This does **not** make shopping-helper previews offline; see the
[operator guide](../demo/shopping-list/README.md#commands-and-side-effects).

### Compiler maintenance is separate from setup

The [compiler comparison script](../scripts/check-workgraph-compiler.mjs)
requires `WORKGRAPH_PLUGINS_DIR` to point explicitly to WorkGraph's `plugins`
workspace. It compares the vendored runtime contract byte-for-byte with
WorkGraph's `contract/runtime-v1.json`, invokes the canonical Rust compiler,
and compares parsed output against **all eight** installed expected fixtures.
Invoking Cargo can produce build artifacts even without a fixture rewrite.

Its `--write` option overwrites the expected fixtures and canonical bodies.
That is intentional compiler/consumer maintenance, not a remedy to apply
automatically when an older Demo differs from a newer kit. Do not regenerate
this sandbox's fixtures or replace its installed kit during a documentation
refresh. Preserve the proof files, regression cases, and their provenance.
Use the canonical setup guides for a separate new sandbox.

[workgraph]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/README.md
[setup]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/README.md
[protocol]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-v1-definition.md
[profiles]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-agent-profiles.md
