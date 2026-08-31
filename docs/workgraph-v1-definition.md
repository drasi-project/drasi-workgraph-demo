# WorkGraph v1 definition

`.github/workgraph/workflows/issue-lifecycle.yaml` is the strict generic
authoring source. It uses `workgraph.drasi.io/v1`, `IssueWorkflow`, and the
exact `workgraph` trigger. The four task keys are lowercase `a`-`d`. The logical
graph is:

```text
A intake → B normalize → C inspect → D finalize → completed
```

The defaults fields are `evaluator`, `orchestrator`, and
`maxReworkAttempts` (three). All four tasks use `issue-worker`, the default
`result-evaluator`, and the default `workflow-coordinator`. Rework keeps the
same task and assignment and creates a fresh bounded attempt. Every task has
`worker`, `inputs`, and exactly one `next`; `completed` is the sole terminal.
The definition has no outcome branches, waits, or recursive children.

The Rust compiler is authoritative for the final canonical
`WorkGraphWorkflowDefinition/v1` body and its generated query bundle.
`.github/workgraph/fixtures/v1/issue-lifecycle.expected.json` is the exact
complete compiler output; `.github/workgraph/workflows/issue-lifecycle-v1.body`
is its `canonicalDefinitionBody`. JavaScript parses and validates the complete
graph but does not independently compile the YAML.

`.github/workgraph/tests/linear-sequence-v1.json` supplies one accepted,
deterministic Result for each of `a`, `b`, `c`, and `d`. The Node definition
test binds its exact task-key set and expected terminal outcome to the compiled
definition and rejects children, outcome transitions, or waits.

## Runtime message envelope

Every task and lifecycle body contains exactly `apiVersion`, `kind`, `id`,
`rootIssueId`, `workflowRunId`, `taskId`, `context`, `references`, and `data`.
`apiVersion` is `workgraph.drasi.io/v1`. Context always contains the pinned
definition ID, version, digest, task-definition ID, `taskKey`, and `operation`.
The markers and kinds are Task, TaskAssignment, TaskDispatch, TaskResult,
TaskEvaluation, TaskRoute, and TaskError using their matching
`WorkGraph<kind>/v1` marker. Flat legacy bodies and old marker spellings are not
accepted.

Every runtime `taskId` must match the canonical form
`workgraph-v1:task:sha256:<64 lowercase hex>`. Root Task IDs hash the same
length-framed `(workflowRunId, rootTaskDefinitionId)` inputs as before. Forked
children and routed successors retain their existing length-framed
`(workflowRunId, parentTaskId, taskDefinitionId)` inputs. Only the namespace and
full 64-hex representation changed; `taskDefinitionId` remains `wgd-*`.
Legacy `wgt-*`, arbitrary names, uppercase hex, and malformed digests are
rejected by Task and lifecycle formatters, parsers, and ID derivation helpers.

References/data are strict: Task uses `{}`/`{resolvedInputs}`; Assignment uses
`{}`/`{permittedExecutors}`; Dispatch uses `{assignmentId}` with
`{launchId, lease:{id,executorId,slotId}}`; Result uses
`{dispatchId,leaseId}` with `{attempt,outcome,output}`; Evaluation uses
`{resultId}` with `{resultDigest,evaluatorId,attempt,verdict,summary,feedback}`;
and Route uses `{resultId,evaluationId}` with its verdict, orchestrator, action,
attempt, transition, target, selected-outcome, and target-task fields. All five
nullable Route data fields are serialized explicitly as `null`.
Evaluation `resultDigest` hashes recursively key-sorted compact JSON for the
canonical TaskResult envelope object, not the flattened parser projection.
Evaluation IDs derive from `(taskId, resultId, resultDigest)`, and Route IDs
derive from `(taskId, evaluationId)`. Their strict formatters and parsers reject
noncanonical IDs. TaskResult formatting intentionally keeps `resultId` opaque;
the reporter and source layers enforce its canonical identity.

Verdicts are `accepted` or `rejected`; rejected Evaluations require actionable
feedback. Accepted Results follow their exact transition, while rejected
Results may rework within their effective bound. A failed worker execution is
still a TaskResult with outcome `failed`. TaskError is reserved for diagnostics,
including an error-terminal routing decision; its six optional causal
references and optional attempt are explicit `null` when absent.

Evaluate summary and feedback are lifecycle text rather than static data-map
text, so protocol marker names are allowed. They remain well-formed LF text,
with 4096-byte and 16384-byte limits respectively; accepted feedback is empty
and rejected feedback is non-empty.

## Admission-first proof

`.github/workgraph/fixtures/v1/live-proof-inputs.json` starts with an ordinary
Root Issue carrying the exact `workgraph` label and a GitHub delivery ID. The
proof derives:

1. the admission-generation ID;
2. the Root Issue content digest;
3. the workflow run ID;
4. the Root Task ID and canonical body;
5. the first lifecycle state, `FORK`.

No Root Task is pre-seeded. In live mode the `workgraph-v1` Reaction consumes
`wg-issues-waiting-for-admission` and creates the Root Task as a native child of
the Root Issue.

The proof pins the complete runtime query inventory:

- 1 admission query;
- 11 lifecycle queries;
- 9 detail queries, including `wg-route-detail` and `wg-error-detail`;
- 6 compiler-generated entry, transition, and terminal queries;
- 27 total queries in that exact category order.

`runtimeContract` names `server-config-v1-loopback.yaml` and
`data/workgraph-v1-loopback.redb`; production runtime names are not valid proof
inputs. Its keys are exactly the Source and Reaction IDs, those two loopback
paths, `queryIds`, and `queryContractDigest`. The query list must be the exact
ordered 21 generic IDs from the canonical sibling Dogfooding Canvas inventory,
followed by the exact six IDs from this Demo's compiled Canvas inventory.

`queryContractDigest` is `sha256:` plus the SHA-256 of compact JSON for the
ordered 27 entries projected to exactly `{"id","sha256"}` (with keys in that
order). The generic entries and hashes are read only from
`../drasi-dogfooding/.github/extensions/workgraph-v1-view/contract/query-inventory.json`;
the generated entries and hashes come from
`issue-lifecycle.expected.json`'s `queryBundle.canvasInventory`. This binds the
offline proof to query content as well as query names. Before trusting a
generated inventory hash, the proof hashes the corresponding
`queryBundle.queries[].query` exact UTF-8 text and requires an exact match.

Run:

```bash
node --check .github/mcp/workgraph-v1-definition.mjs
node --check scripts/prepare-workgraph-v1-proof.mjs
node --test tests/workgraph-v1-definition.test.mjs
node scripts/prepare-workgraph-v1-proof.mjs
node scripts/check-workgraph-compiler.mjs
```

Use `node scripts/check-workgraph-compiler.mjs --write` to regenerate the
expected output and canonical body before materializing the Dogfooding runtime
configuration. A second `--write` run must leave the worktree unchanged.

The fixture keeps server, Source, Queries, and Reaction inactive. It records
`dryRun: true`, `liveAcknowledgment: false`, and
`githubWritesAllowed: false`; preparing the proof performs no runtime or GitHub
mutation.
