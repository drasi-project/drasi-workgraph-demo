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
`RESULT_INDEX_STATE_VERSION=6`; any isolated runtime prepared from older query
state must clear that state before use.

## Frozen provenance

The two canonical bodies are copied without modification from:

- Dogfood freeze:
  `drasi-project/drasi-dogfooding@986ba3f6a2a56f0dbc422030054c822bc6d3fa20`
- Dogfood hardening parent:
  `20a1f5d13416818751eac1a218552c507b6ffc49`
- Core feature branch:
  `drasi-project/drasi-core@c6615b450b0be85694f2e77460cf892617eb946e`

The final write-disabled runtime checkpoint pins:

- Dogfood:
  `drasi-project/drasi-dogfooding@a14a210d785604a78b72c663e0d655ce49e8f75c`
- Core:
  `drasi-project/drasi-core@7be2e1bd895196c1e4fbf99a23dbbcbdb4abc8e8`
- Demo definition checkpoint:
  `drasi-project/drasi-workgraph-demo@44e308c547d5471b83e5604eda28440ea855dc52`

Canonical Dogfood paths and Git blob IDs:

| Artifact | Dogfood path | Blob |
| --- | --- | --- |
| Definition | `git-workgraph/plugins/github-workgraph-vnext-source/fixtures/workgraph-vnext-live-proof-definition.body` | `6b357e0609a1b2fb1e75a94bed536c0ab095fa80` |
| Root task | `git-workgraph/plugins/github-workgraph-vnext-source/fixtures/workgraph-vnext-live-proof-root-task.body` | `291df48d878b889210f44c1915711244f1a9c13a` |
| Kernel contract | `git-workgraph/plugins/workgraph-kernel/src/lib.rs` | `d2780ccec20dc7d4505a98a9ecd54a660608cb78` |
| VNext Source | `git-workgraph/plugins/github-workgraph-vnext-source/src/lib.rs` | `322c03db9cae15442d12dd8ce5647e0470c71e65` |
| VNext Reaction | `git-workgraph/plugins/workgraph-vnext-reaction/src/lib.rs` | `3e52250699a64bbda3d257d43cc57a21890b4110` |

The canonical definition is 846 bytes with SHA-256
`1cd5b13c8017395dabbf25eb75465034cd54b6545be7d9fe889def1909aa66c7`.
The canonical root is 384 bytes with SHA-256
`1cc6dfb17b655e26d53e4ade591b56f7b3adf693b01320bc8e371b150c6d936c`.
Tests guard both byte streams. Provenance remains external because changing a
body would break fixture compatibility.

The prior v5 proof-input metadata is preserved by its SHA-256
`60f58831f8422665b2a58ceaeb53d50de8ef5d56d04b4d7c4b8f9797d77b23c6`.
The v6 metadata in this checkpoint has SHA-256
`0d9f36b0abd364d0ed1cb06e34ad5574c6db72be2545329bbe3818801bd394f0`;
only runtime pins and reset expectations changed.

## Local validation

Run the focused VNext checks:

```bash
node --check .github/mcp/workgraph-vnext-definition.mjs
node --test tests/workgraph-vnext-definition.test.mjs
node scripts/prepare-workgraph-vnext-proof.mjs
```

The last command performs no network or filesystem writes. It resolves the two
tracked body paths and prints the exact task-first `TaskDocument` revision 1 and
`DefinitionDocument` revision 2 Source input array. It validates both canonical
bodies, their exact definition pin, `RESULT_INDEX_STATE_VERSION=6`, the expected
initial `FORK`, and the write-disabled effect gate before producing output.
It also requires exact Source document schemas/metadata and the frozen local
paths, sizes, and SHA-256 body hashes, so a different canonical document cannot
silently replace this proof input.

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

From the pinned Dogfood `git-workgraph/` directory, the cross-repository
write-disabled proof is:

```bash
WORKGRAPH_DEMO_DIR=/absolute/path/to/demo-at-44e308c547d5471b83e5604eda28440ea855dc52 \
  scripts/dry-run-vnext.sh
```

Its exact terminal result is:

```json
{"mode":"dry-run","sourceKey":"github:issue:9001","taskId":"demo-run-0001-root","nextAction":"FORK","writes":[]}
```

The pinned runtime inventory is exactly 16 queries: 10 lifecycle and 6 detail.
The Demo does not define, copy, or alter those Dogfood queries.
The reviewed v6 release artifacts built from the pinned sources have SHA-256
`4e5b44ba5b560aec22f38b244478f22eece6e00af7c3a72e030bb1ec7850a65e`
for Source and
`ff09429a1c7183769a7a455ccf236e819d82ccbbed4d65ccf63718f89dca5072`
for Reaction. They are provenance only and are not installed or activated by
this repository.

## VNext executors

`.github/workgraph/agents.yaml` registers both permitted executor identities in
the frozen definition: `issue-validator` for the leaf and `demo-orchestrator`
for the root. Their custom-agent profiles require the canonical
`WorkGraphTaskDispatch/v1` body and the exact execution context containing the
runtime task, static task definition, trusted task locator, direct-child
Results, and direct-child Evaluations.

Both profiles call only the narrow `submit_task_result` reporter path for
writes. They pass the trusted task Issue locator and unchanged
`taskId`/`dispatchId`/`leaseId`, plus `outcome` and `output`; the reporter owns
the deterministic `resultId`, verifies the current V3 task and Dispatch chain,
and writes or reconciles the exact canonical VNext Result. Legacy Lease and
Result envelopes are rejected.

For live admission, an ordinary open Issue with the exact `status:new` label
remains the untouched principal Issue. Dogfood creates a separate, parentless,
launcher-authored `WorkGraphTask/v3` root; typed descendants retain their normal
task-to-task native ancestry. The root's dynamic
`resolvedInputs.principalIssue` contains the immutable repository locator and a
snapshot digest, never a copy of the user's title or body. The digest is SHA-256
over three ordered, unsigned-64-bit-big-endian-length-framed UTF-8 values:
`workgraph-vnext-principal-content-v1`, the exact title, and the exact body
(GitHub `null` normalizes once to the empty string). CRLF bytes are preserved.
The workflow run ID frames repository node ID, principal Issue node ID,
definition ID, version, and digest. The root task ID frames that run ID and
`demo-root-v1`; the admission ID frames the run ID and root task ID. All use
the same length framing and stable VNext prefixes.

Before evaluating a validation leaf, `get_vnext_principal_issue` verifies its
immediate typed root, the root's parentless topology and definition/run
identity, the exact principal locator, and the current principal title/body
digest. The validator evaluates only the returned ordinary Issue fields and
fails closed if the principal is missing, closed, retyped as a WorkGraph task,
reparented through a wrong root, or changed since admission. Result reporting
continues to use the unchanged VNext arguments.

## Disabled runtime boundary

The fresh runtime uses only the dedicated
`git-workgraph/data/workgraph-vnext-v6.redb` state namespace. Preserve the v5
file byte-for-byte as prior proof evidence. Before the first v6 replay, remove
only the whole v6 file; this resets its allocator and complete Source namespace,
including Source WAL and `vnext-origin:*` dedupe/pending records. Partial reset
or migration is invalid. From the pinned Dogfood `git-workgraph/` directory,
the disabled invocation is:

```bash
rm -f data/workgraph-vnext-v6.redb
RESULT_INDEX_STATE_VERSION=6 \
  /absolute/path/to/drasi-server --config server-config-vnext.yaml
```

The checked-in Source, all 16 queries, and Reaction have `autoStart: false`.
Reaction uses `mode: disabled` and `dryRun: true`. This session does not run the
server invocation because activation is out of scope, even in disabled mode.
The repository resources use no sibling-worktree dependencies or runtime
fixture downloads.

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
