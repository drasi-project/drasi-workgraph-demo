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
`WorkGraphWorkflowDefinition/v1` body. JavaScript does not generate a second
final body for the rich graph. The expected high-level result is
`.github/workgraph/fixtures/v1/issue-lifecycle.expected.json`, which is retained
for later compiler reconciliation. It contains all resolved task definitions,
recursive children, waits, terminals, and graph transitions. The distinct
`normalizeCompiledWorkflowDefinition` validates that complete graph, including
reachability and wait-mediated cycles. The existing root-shaped
`parseWorkflowDefinition` remains only for the published
`issue-lifecycle-v1.body` admission-proof input until Wave 2.

## Evaluate and Route

`WorkGraphTaskEvaluate/v1` contains exactly `evaluationId`, `rootIssueId`,
`workflowRunId`, `taskId`, `resultId`, `resultDigest`, `evaluatorId`, `verdict`,
`summary`, and `feedback`. Verdict is `accepted` or `rejected`; rejected
Evaluations require actionable feedback.

`WorkGraphTaskRoute/v1` directly records the Root Issue, run, task, Result, and
Evaluation IDs, plus `evaluationVerdict`, `orchestratorId`, `action`, and a
bounded zero-based `attempt`. Accepted Results may advance or complete;
rejected Results may rework. `error` and `ignore` are universal exclusions.
Advance alone carries `transitionKind` (`next` or `outcome`),
`targetStepId`, and `targetStepKind`. `outcome` is present only for an outcome
transition. `targetTaskDefinitionId` is present
only for a task target and equals that target's compiler-derived hashed ID.
Non-advance routes carry no transition or target fields. A later reporter wave
must verify the recorded Result/Evaluation mapping and compiled transition
before writing.

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

The proof pins the complete query inventory:

- 1 admission query;
- 10 lifecycle queries;
- 6 detail queries;
- 17 total queries, all prefixed `wg-`.

Run:

```bash
node --check .github/mcp/workgraph-v1-definition.mjs
node --check scripts/prepare-workgraph-v1-proof.mjs
node --test tests/workgraph-v1-definition.test.mjs
node scripts/prepare-workgraph-v1-proof.mjs
node scripts/check-workgraph-compiler.mjs
```

The fixture keeps server, Source, Queries, and Reaction inactive. It records
`dryRun: true`, `liveAcknowledgment: false`, and
`githubWritesAllowed: false`; preparing the proof performs no runtime or GitHub
mutation.
