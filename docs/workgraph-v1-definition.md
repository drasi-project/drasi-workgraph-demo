# WorkGraph v1 definition

`.github/workgraph/workflows/issue-lifecycle.yaml` is the strict generic
authoring source. It uses `workgraph.drasi.io/v1`, `IssueWorkflow`, and the
exact `workgraph` trigger. The diagram labels A-H correspond to lowercase step
IDs `a`-`h`; `human` is the standalone wait step. The logical graph is:

```text
A intake → B normalize → C validate
                         ├─ needs-info → D request-info
                         │                 └─ qualifying Root Issue comment → C
                         ├─ continue → E triage → G recursive validation → H finalize
                         └─ reject → F record-rejection → ignored
```

Step `g` has exactly the title, body, and reproduction validation children in
`children: { join: all, tasks: ... }`. Child tasks recursively support inputs
and evaluator, orchestrator, rework-count, and children overrides. Child IDs
are local to their parent and never become top-level transition targets.

The defaults fields are `evaluator`, `orchestrator`, and
`maxReworkAttempts` (three). Rework keeps the same task and assignment and
creates a fresh bounded attempt. Step `c` overrides the evaluator. Step `g`
overrides the orchestrator and maximum with two. Every task has `worker` and
`inputs` and exactly one `next` or outcomes map. Waits and the completed,
error, and ignored terminals are standalone steps.

The Rust compiler is authoritative for the final canonical
`WorkGraphWorkflowDefinition/v1` body and its generated query bundle.
`.github/workgraph/fixtures/v1/issue-lifecycle.expected.json` is the exact
complete compiler output; `.github/workgraph/workflows/issue-lifecycle-v1.body`
is its `canonicalDefinitionBody`. JavaScript parses and validates that complete
graph, including recursive fork/join definitions, reachability, and
wait-mediated cycles, but does not independently compile the YAML.

## Evaluate and Route

`WorkGraphTaskEvaluate/v1` contains exactly `evaluationId`, `rootIssueId`,
`workflowRunId`, `taskId`, `resultId`, `resultDigest`, `evaluatorId`, the
one-based `attempt`, `verdict`, `summary`, and `feedback`. Verdict is `accepted`
or `rejected`; rejected Evaluations require actionable feedback.

`WorkGraphTaskRoute/v1` directly records the Root Issue, run, task, Result, and
Evaluation IDs, plus `evaluationVerdict`, `orchestratorId`, `action`, and the
same one-based `attempt`. Its `reworkCount` is `attempt - 1`. Accepted Results
may follow their exact resolved transition; recursive children complete to
release their join. Rejected Results may rework within their effective bound.
The runtime route policy additionally permits its `error` and `ignore`
exclusions.
Advance alone carries `transitionKind` (`next` or `outcome`),
`targetStepId`, and `targetStepKind`. `outcome` is present only for an outcome
transition. `targetTaskDefinitionId` is present
only for a task target and equals that target's compiler-derived hashed ID.
Non-advance routes carry no transition or target fields. Definition-aware
validation binds every route to its source step and task-definition ID. The
source execution policy supplies the required orchestrator and rework limit,
and the source transition supplies the only valid advance edge. Recursive
`executionPolicies` must exactly cover every task definition and each worker
must match its task's routing executor. Recursive child tasks use their own
effective policy but have no top-level transition: accepted children may
complete, and rejected children may rework within their bound. Runtime-policy
exclusion actions use the same authorization logic.

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
- 15 compiler-generated entry, transition, wait/resume, and terminal queries;
- 35 total queries, all prefixed `wg-`.

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
