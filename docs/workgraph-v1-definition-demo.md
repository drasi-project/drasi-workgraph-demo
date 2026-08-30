# WorkGraph v1 definition demo

The Demo workflow is frozen in
`.github/workgraph/workflows/issue-lifecycle-v1.body` under the
`WorkGraphWorkflowDefinition/v1` marker. It defines:

| Task key | Definition ID | Operation | Executor |
|---|---|---|---|
| `root` | `demo-root-v1` | `coordinate-issue` | `demo-orchestrator` |
| `validate` | `demo-validate-v1` | `validate-issue` | `issue-validator` |

The definition is recursive and immutable. Runtime `WorkGraphTask/v1` bodies
carry only identity, definition pins, top-level `rootIssueId`, and resolved
inputs. Operations, routing, static inputs, and children remain on the
definition.

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
```

The fixture keeps server, Source, Queries, and Reaction inactive. It records
`dryRun: true`, `liveAcknowledgment: false`, and
`githubWritesAllowed: false`; preparing the proof performs no runtime or GitHub
mutation.
