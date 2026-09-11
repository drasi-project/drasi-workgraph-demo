# WorkGraph v1 reporter

These are **maintenance notes for this Demo's older installed reporter**, not
the current portable reporter specification. Use WorkGraph's
[canonical reporter reference][reporter], [protocol reference][protocol],
[agent-profile guide][profiles], and [setup guides][setup] for new
installations.

The [installed MCP reporter](../.github/mcp/workgraph-reporter.mjs) is fixed to
`drasi-project/drasi-workgraph-demo`. Unlike the canonical portable
implementation, it hardcodes the repository and an **eight-fixture registry**,
listed in the [installed artifact notes](workgraph-v1-definition.md#installed-artifacts).
It does not discover or acquire the newer kit's workflows automatically.
Copying it or the older shopping harness is not a supported new-sandbox
installation method.

This installed boundary exposes exactly six tools:

| Tool | Purpose | GitHub write |
|---|---|---|
| `get_root_issue` | Verify a worker task and its admitted Root Issue snapshot | No |
| `submit_task_result` | Verify a task, Dispatch, and active Lease, then create or reconcile its Result | One comment when absent |
| `get_task_snapshot` | Read verified task evidence and bounded choices for the configured lifecycle role | No |
| `submit_task_assignment` | Verify an AssignmentRequest and create or reconcile the selected Assignment | One comment when absent |
| `submit_task_evaluation` | Create or reconcile the current Result's canonical Evaluation | One comment when absent |
| `submit_task_route` | Create or reconcile an authorized Route for the current Evaluation | One comment when absent |

These are not offline tools: they re-read GitHub, and Result submission also
contacts the Source's lease-validation endpoint. No tool creates or closes a
Task Issue, mutates the ordinary Root Issue, starts WorkGraph, or selects a
workflow for it. The mutating tools write only their canonical comment.

The installed reporter rejects unexpected repository/Issue identities,
noncanonical bodies, foreign authors, duplicate protocol comments, missing
admission labels, changed Root Issue content, stale Leases, and conflicting
retries. New work requires open task ancestry except for the routed-predecessor
case below. Exact existing messages can reconcile without another write; the
ordinary Root Issue must remain open with its admission label and content
digest intact.

**Installed limitation:** `hasAdmissionLabel` accepts any syntactically valid
`workgraph:*` label and rejects `workgraph:ignore` or `workgraph:error`. It does
not check that the label matches the task's workflow mapping. Operators must
still use the exact configured `workgraph:<mapping-id>` selector for runtime
admission; a successful read through this older reporter is not proof of that
label match.

## Task locator

All tools receive an opaque `taskLocator` from the Reaction execution context,
not a manually invented Issue number. It includes repository, Issue, and
native parent identities, which the reporter verifies against GitHub and the
pinned compiled workflow.

Top-level Tasks are direct children of the ordinary Root Issue. Recursive
children follow their task-definition parents; scoped tasks follow their
owning container. The reporter separately verifies the initial task among the
Root Issue's direct children. It does not mistake the ordinary Root Issue for
a `WorkGraphTask`, and caller-supplied locator values alone are never proof.
See the [canonical locator/envelope documentation][reporter] for full fields.

## Scoped flow entries

The [Demo scope fixture](workgraph-v1-definition.md#scoped-flow-entries)
depends on these three reserved runtime inputs, all present or all absent:

| Input | Meaning |
|---|---|
| `workgraphScopeParentTaskId` | The owning container task ID |
| `workgraphScopeEntryTaskId` | The direct entry task ID of the scope |
| `workgraphScopeEntryStepId` | The compiled entry step ID of the scope |

A scoped routed successor also has `workgraphPredecessorTaskId`. Scope members
are native siblings under their owning container, not a parent chain. The
reporter validates their compiled scope, shared run and definition, Fork for
the entry, and immutable predecessor Routes for successors. Fixed children
inherit their parent's scope strings while remaining children of that task.

A routed predecessor may already be closed: its immutable Advance Route,
shared scope, and deterministic successor identity authorize the successor,
not the predecessor's openness. New reporting work still requires the current
task and its owning/recursive containers to be open. The installed
[reporter regressions](../tests/workgraph-reporter.test.mjs) retain these
distinctions; see the canonical references for the general scope contract.

## Normalized inbound evidence

`WorkGraphTaskResponse/v1` is immutable evidence reported by the trusted
runtime, not a human-authored authoritative Result or Evaluation. This
reporter requires the sidecar's author to match the configured **Result
reporter**, not the Assignment reporter. Repeated Response IDs are rejected.
A cited Response must match the task, role, and lifecycle subject; evidence
cannot be borrowed from another attempt.

Full encoding, revision, and subject rules live in the
[canonical protocol reference][protocol]. Local contract tests and protocol
artifacts remain in place; this documentation cleanup changes none of them.

## Root Issue reader

`get_root_issue` accepts exactly `taskLocator` and `taskId`. It verifies the
launcher-authored Task, native ancestry, initial task, pinned workflow, and
admission recorded in the initial task. It returns the verified
Root Issue title and normalized body; changes after admission fail closed.

The initial task binds the ordinary Root Issue's repository/Issue identity,
admission generation, and content digest in `resolvedInputs.rootIssue`.
The reporter does not substitute a mapping-agnostic admission or synthesize
missing Root Issue evidence. A read is not permission to edit that Issue.

## Result writer

The installed `submit_task_result` takes `taskLocator`, `taskId`, `dispatchId`,
`leaseId`, `outcome`, and object-valued `output`. It requires
`output.rootIssueComment` to contain 1-16384 bytes of candidate Markdown.
The worker must not post that candidate directly on the Root Issue; the
runtime publishes it only after an accepted Evaluation.

Result submission authenticates the exact immutable Dispatch and selected
executor, then calls `POST /github/workgraph-v1/lease/validate`. The Source
validates/reserves the active Lease for the claim. The reporter takes the
one-based attempt from that response, not from the caller or the number of
Dispatch comments. Prior expired attempts remain history, not authorization.

The installed Route response describes rework using the same `taskId` and
`assignmentId`, the next bounded attempt, and Evaluation feedback. It does not
choose another worker or allocate a Lease; see the
[runtime/rework notes](workgraph-v1-definition.md#runtime-message-envelope).
Full message shapes, deterministic IDs, digest rules, and retry semantics
belong in the canonical references rather than duplicate setup prose here.

## Configuration

These are the installed reporter's **process environment names**, not a
verified description of a running deployment or a portable repository-setup
recipe. All six tools require:

```text
COPILOT_MCP_WORKGRAPH_TOKEN
COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID
COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID
COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID
COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID
COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID
```

`submit_task_result` additionally requires `COPILOT_MCP_WORKGRAPH_EXECUTOR_ID`,
`COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN`, and
`COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL`.

Lifecycle tools require **exactly one** of
`COPILOT_MCP_WORKGRAPH_ASSIGNER_ID`, `COPILOT_MCP_WORKGRAPH_EVALUATOR_ID`, or
`COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_ID`. The configured role must match the
submission tool. Evaluator and orchestrator roles also require
`COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID`; the assigner role does
not.

The Route reporter identity is required even by readers, because routed
ancestry may require authenticating a predecessor's Route. Required
role-specific identities are not silently replaced by another identity.
Refer to the installed source and its
[contract tests](../tests/workgraph-reporter.test.mjs) for this snapshot's
exact behavior; use the canonical setup/profile guides for a new sandbox.
Do not copy private credentials, person bindings, or old deployment settings.

[reporter]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-result-reporter.md
[protocol]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-v1-definition.md
[profiles]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-agent-profiles.md
[setup]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/README.md
