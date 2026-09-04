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
`WorkGraphWorkflowDefinition/v1` body, query plan, and any generated resume queries.
`.github/workgraph/fixtures/v1/issue-lifecycle.expected.json` is the exact
complete compiler output; `.github/workgraph/workflows/issue-lifecycle-v1.body`
is its `canonicalDefinitionBody`. JavaScript parses and validates the complete
graph but does not independently compile the YAML.

`.github/workgraph/tests/linear-sequence-v1.json` supplies one accepted,
deterministic Result for each of `a`, `b`, `c`, and `d`. The Node definition
test binds its exact task-key set and expected terminal outcome to the compiled
definition and rejects children, outcome transitions, or waits.

## Scoped flow entries

A task definition may declare `flowEntries`: an ordered, unique list of task
step IDs it owns as routed child subgraphs. The field is additive and is omitted
whenever it is empty, so every pre-flow canonical body and digest stays
byte-identical. `flowEntries` and `children` share one direct-child bound of
16 tasks, because both become children of the same Fork. A scope's fork depth
also bounds the child trees beneath it: a task authored at fork depth *d* may
nest at most `MAX_TASK_DEFINITION_DEPTH - d` further child levels, and the
authoring validator rejects an over-nested tree exactly where the compiled
definition and the Rust compiler do.

An entry names a task step. That step plus every step reachable from it through
ordinary transitions forms one *scope*. Scopes are disjoint from the trunk (the
steps reachable from `initialStepId`) and from each other, so every step belongs
to exactly one routed region. Each scope must reach a terminal step, must not
contain an unconditional cycle, and counts against the maximum task-definition
depth at its physical fork depth, so nested scopes stay bounded. A step is
reachable only through its transitions or the owner that launches it;
otherwise the definition is rejected as unreachable.

`.github/workgraph/workflows/scoped-control-flow.yaml` demonstrates both uses in
one definition:

```text
run (container: flowEntries fix, notify) → completed
  ├── fix (container: children fix-evidence, flowEntries audit) → fix-cleanup → fix-complete
  │     └── audit → audit-verify → audit-complete
  └── notify → notify-complete
```

The initial `run` task is a workflow container and the run's own finalizer: it
declares no fixed children, forks the `fix` and `notify` entries in parallel,
waits for both scopes to reach their terminals, and then routes directly to
`completed`. It is the only trunk task, so the run has exactly one direct Root
Issue child and no predecessor-bearing top-level task. The `fix` entry forks a
fixed child `fix-evidence` and the nested `audit` scope from the same task
definition, then runs its own `fix-cleanup` and routes to its own `fix-complete`
terminal. `notify` is a plain routed task that reaches its terminal directly.

A fixed child inherits its parent's routed scope but has no step of its own, so
`fix-evidence` carries `fix`'s three reserved scope strings while remaining a
native sub-issue of `fix` rather than of `run`.
`.github/workgraph/tests/scoped-control-flow-v1.json` pins the task parents each
scope produces: `run` is the sole top-level task and scope members are direct
sub-issues of their owning container. Its `expected.flowEntries` is the additive
`WorkGraphTestCase` shape the standalone mock derives, in canonical
`(ownerTaskKey, entryStepId)` order:

| ownerTaskKey | entryStepId | taskKeys | terminalStepId |
|---|---|---|---|
| `fix` | `audit` | `audit`, `audit-verify` | `audit-complete` |
| `run` | `fix` | `fix`, `fix-cleanup` | `fix-complete` |
| `run` | `notify` | `notify` | `notify-complete` |

`taskKeys` is the selected chain from the entry step to that scope's own
terminal; only its first task is named by the owner's Fork, and the rest are
authorized by their predecessor's Route. The field is omitted when a definition
declares no `flowEntries`, so every existing test case stays exactly as valid as
it was.

The runtime writes four reserved strings into the tasks it generates:
`workgraphPredecessorTaskId` for a routed successor, and
`workgraphScopeParentTaskId`, `workgraphScopeEntryTaskId`, and
`workgraphScopeEntryStepId` for every task of a routed scope. A definition may
not author them where they would be generated, so a step that some transition
targets may not declare `workgraphPredecessorTaskId`, and no task of a routed
scope — including the nested children that inherit the scope — may declare any
of the four. A trunk step that no transition targets is unaffected, which keeps
every existing definition byte-identical.

The Rust compiler stays authoritative;
`.github/workgraph/fixtures/v1/scoped-control-flow.expected.json` is the exact
compiler output and
`.github/workgraph/workflows/scoped-control-flow-v1.body` is its
`canonicalDefinitionBody`. `node scripts/check-workgraph-compiler.mjs` compares
all six Demo workflows against the sibling compiler byte-for-byte.

## Human and agent parity

A workflow references an actor ID identically whoever executes it. Only the
`version: 2` actor catalog in `.github/workgraph/agents.yaml` decides whether an
actor is an `agent` (which names a custom-agent profile, defaulting to its own
ID) or a `human` (which binds the exact GitHub `databaseId`, `nodeId`, and
`login` that person speaks as). A human worker takes a normal Assignment,
Lease, and Dispatch; a human evaluator takes none, exactly like an agent
evaluator.

The Assignment decision itself may also be allocated to either transport:

```yaml
      worker:
        candidates: [human-agentofreality, issue-worker]
        selection: assigned
      assigner: assignment-coordinator
```

This produces `WorkGraphTaskAssignmentRequest/v1` before Assignment. The
assigner has no lease; it chooses one candidate and records a rationale. A
human answers with `@workgraph assign <actor-id> ...`, which becomes Response
evidence before the trusted runtime writes Assignment. An agent uses only
`get_task_snapshot` and `submit_task_assignment`. The selected worker then
enters the ordinary Assignment, Lease, and Dispatch lifecycle.

A task definition may pin optional actor-neutral `instructions`: a `summary`,
optional `details`, ordered `acceptanceCriteria`, and an optional
`resultSchema`. Nothing in them names an executor, a role, or a transport, so
the same text is what an agent is handed and what a human reads. Instructions
are content at a position, never identity: they do not change the path-derived
`taskDefinitionId`, and are pinned by the workflow digest like operation,
inputs, and routing already are.

`worker` accepts either the original scalar form or a candidate set:

```yaml
      worker:
        candidates: [human-agentofreality, issue-worker]
        selection: first-available
```

Authored order carries no priority. Candidates are canonicalized into sorted
order as `routing.permittedExecutors`, and the canonical first candidate becomes
`policy.workerId` as the default. Membership is what authorizes execution, so a
single-candidate set compiles byte-identically to the equivalent scalar. No
permitted executor may also be the task's evaluator or orchestrator.

`.github/workgraph/workflows/human-parity.yaml` exercises both directions in
sequence: a human worker graded by the `result-evaluator` agent, then the
`issue-worker` agent graded by the `human-agentofreality` evaluator, to the
`completed` terminal. Each step is performable from the verified Root Issue
alone, so neither depends on reading a predecessor's Result. The kernel's
authoring parser accepts no block scalars, so `details` is a single-line
string.

## Normalized inbound evidence

`WorkGraphTaskResponse/v1` is one comment an actor wrote against a task,
normalized into evidence. It is not authority: it records that a specific GitHub
account said something on a specific task at a specific revision, and binds the
raw body by digest so a later edit is detectable. Deciding whether that evidence
becomes a Result or an Evaluation stays with the trusted writer, so a Response
carries no `resultDigest`, no outcome, and no verdict.

Evidence is bound to the exact lifecycle subject it answers, in the references
and in `responseId`, so one comment cannot be replayed across attempts or roles.
`worker` evidence references its Dispatch and Lease, `evaluator` evidence
references its Result, and `assigner` evidence references its
AssignmentRequest. Each role forbids the other roles' subjects.

Only a comment whose first non-empty line opens with `@workgraph` is normalized,
matched case-insensitively on an exact login boundary, so `@workgraphs` is a
different account. Leading whitespace is skipped using Unicode `White_Space`,
which excludes U+FEFF, so a body opening with a byte order mark does not
address the protocol. Everything after the mention is untrusted prose that may
quote reserved marker names freely. The raw body is transported hex-encoded as
`{encoding: "utf-8-hex", data}` up to 16 KiB, so CRLF, fenced code blocks, and a
byte order mark anywhere in the text survive the envelope byte for byte and the
body still matches its digest.

The sidecar is written by the runtime as the Result reporter identity, because
evidence is reported rather than assigned.

Exactly one immutable Response sidecar is written per consumed raw reply. The
raw comment may be edited freely before it is consumed, and the sidecar records
where it landed, so `updatedRevision` may exceed `createdRevision`. After
consumption the sidecar is never rewritten or duplicated, and neither is the
Result or Evaluation it backs: `responseId` does not change, so a repeated
`responseId` on one task is rejected.

Result and Evaluation may carry an optional `references.response` naming that
evidence. It never participates in ID derivation and is omitted when absent, so
every pre-Response body and digest stays byte-identical.

## Runtime message envelope

Every task and lifecycle body contains exactly `apiVersion`, `kind`, `id`,
`rootIssueId`, `workflowRunId`, `taskId`, `workflowContext`, `references`, and
`data`. `apiVersion` is `workgraph.drasi.io/v1`. Workflow context always contains the pinned
definition ID, version, digest, task-definition ID, `taskKey`, and `operation`.
The markers and kinds are Task, TaskFork, TaskJoin, TaskAssignmentRequest,
TaskAssignment, TaskDispatch, TaskResult, TaskEvaluation, TaskRoute, and TaskError using their matching
`WorkGraph<kind>/v1` marker. Flat legacy bodies and old marker spellings are not
accepted.

The ten task-comment message kinds are the `WorkGraphTaskAction` log.
TaskFork is persisted only after all declared child tasks are observed, and
TaskJoin is persisted only after all joined children close with accepted
Result/Evaluation pairs.

Every runtime `taskId` must match the canonical form
`urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>`. Root Task IDs hash
the same
length-framed `(workflowRunId, rootTaskDefinitionId)` inputs as before. Forked
children and routed successors retain their existing length-framed
`(workflowRunId, parentTaskId, taskDefinitionId)` inputs. Only the namespace and
full 64-hex representation changed. Legacy `wgt-*`, pre-URN IDs, arbitrary
names, uppercase hex, and malformed digests are
rejected by Task and lifecycle formatters, parsers, and ID derivation helpers.

References/data are strict: Task uses `{}`/`{resolvedInputs}`; Fork records
ordered child TaskDefinition/Task references; Join records its Fork and ordered
child Task/Result/Evaluation references. AssignmentRequest carries an assigner,
canonical candidates, and optional decision instructions. Legacy Assignment
uses `{join:{kind,id}|null}`/`{permittedExecutors}`; decision-bound Assignment
also references its request and optional human Response and carries the
assigner and rationale. Dispatch uses `{assignment:{kind,id}}` with
`{launchId, lease:{id,executorId,slotId}}`; Result uses
typed `dispatch` and `lease` roles with `{attempt,outcome,output}`; Evaluation
uses a typed `result` role; and Route uses typed `result` and `evaluation`
roles with its verdict, orchestrator, action, attempt, transition, target,
selected-outcome, and target-task fields. Each non-null reference is exactly
`{kind,id}`. All five nullable Route data fields are serialized explicitly as
`null`; every TaskError reference role is typed or explicitly `null`.

Generated protocol IDs hash the length-framed UTF-8 sequence
`["urn:drasi:workgraph:id:v1", type, ...semanticInputs]` and use
`urn:drasi:workgraph:id:v1:<type>:sha256:<64 lowercase hex>`.
Evaluation `resultDigest` hashes recursively key-sorted compact JSON for the
canonical TaskResult envelope object, not the flattened parser projection.
Evaluation IDs derive from `(taskId, resultId, resultDigest)`, and Route IDs
derive from `(taskId, evaluationId)`. Their strict formatters and parsers reject
noncanonical IDs. TaskResult formatting requires the `result` URN type but
intentionally does not rederive it; reporter and source layers enforce its
semantic identity.

Verdicts are `accepted` or `rejected`; rejected Evaluations require actionable
feedback. Accepted Results follow their exact transition, while rejected
Results may rework within their effective bound. A failed worker execution is
still a TaskResult with outcome `failed`. TaskError is reserved for diagnostics,
including an error-terminal routing decision; its eight optional causal
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
5. the first lifecycle state, `ASSIGN`, because the Root Task is a leaf.

No Root Task is pre-seeded. In live mode the `workgraph-v1` Reaction consumes
`wg-issues-waiting-for-admission` and creates the Root Task as a native child of
the Root Issue.

The proof pins the complete runtime query inventory:

- 1 admission query;
- 13 lifecycle queries;
- 10 detail queries, including Route, Error, and terminal detail;
- no per-edge entry, sequence, branch, fork, or terminal queries;
- 24 total shape-independent queries in that exact category order.

`runtimeContract` names `server-config-v1-loopback.yaml` and
`data/workgraph-v1-loopback.redb`; production runtime names are not valid proof
inputs. Its keys are exactly the Source and Reaction IDs, those two loopback
paths, `queryIds`, and `queryContractDigest`. The query list must be the exact
ordered 24 IDs from the canonical sibling Dogfooding Canvas inventory.

`queryContractDigest` is `sha256:` plus the SHA-256 of compact JSON for the
ordered 24 entries projected to exactly `{"id","sha256"}` (with keys in that
order). The generic entries and hashes are read only from
`../drasi-dogfooding/.github/extensions/workgraph-v1-view/contract/query-inventory.json`;
the compiled inventory is empty for workflows without waits. A human wait adds
only its content-addressed resume query. This binds the offline proof to query
content as well as query names without multiplying queries for sequential,
branch, or parallel tasks.

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
