# WorkGraph v1 definition

`.github/workgraph/workflows/issue-lifecycle.yaml` is the strict generic
authoring source. It uses `workgraph.drasi.io/v1`, `IssueWorkflow`, and the
exact `workgraph` trigger. The four task IDs are lowercase `a`-`d`. The logical
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

## Evaluate and Route

`WorkGraphTaskEvaluate/v1` contains exactly `evaluationId`, `rootIssueId`,
`workflowRunId`, `taskId`, `resultId`, `resultDigest`, `evaluatorId`, the
one-based `attempt`, `verdict`, `summary`, and `feedback`. Verdict is `accepted`
or `rejected`; rejected Evaluations require actionable feedback.

`WorkGraphTaskRoute/v1` directly records the Root Issue, run, task, Result, and
Evaluation IDs, plus `evaluationVerdict`, `orchestratorId`, `action`, and the
same one-based `attempt`. Its `reworkCount` is `attempt - 1`. Accepted Results
follow their exact `next` transition; step `d` reaches the `completed` terminal.
Rejected Results may rework within their effective bound. The runtime route
policy additionally permits its `error` and `ignore` exclusions.
Advance alone carries `transitionKind: next`, `targetStepId`, and
`targetStepKind`. `targetTaskDefinitionId` is present only for a task target
and equals that target's compiler-derived hashed ID. Non-advance routes carry
no transition or target fields. Definition-aware validation binds every route
to its source step and task-definition ID. Each step's execution policy supplies
the required orchestrator and rework limit and must name the same worker as its
task routing executor.

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
- 10 lifecycle queries;
- 9 detail queries;
- 6 compiler-generated entry, transition, and terminal queries;
- 26 total queries, all prefixed `wg-`.

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
