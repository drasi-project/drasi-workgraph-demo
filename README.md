# drasi-workgraph-demo

A strict, breaking WorkGraph Issue workflow prototype for the fixed
`drasi-project/drasi-workgraph-demo` repository. It defines nine
REST-launchable profiles:

- `demo-orchestrator`
- `issue-orchestrator`
- `issue-assigner`
- `issue-validator`
- `issue-info-requester`
- `workgraph-result-acceptor`
- `issue-title-validator`
- `issue-body-validator`
- `issue-validation-evaluator`

Tasks are native child Issues with exact type name `WorkGraphTask`, configured
live type node ID `IT_kwDOCX0YF84CKGIJ`, and one canonical `WorkGraphTask/v1`
YAML body. `.github/workgraph/agents.yaml` defines capacity and Lease duration
for each custom-agent ID. The GitHub WorkGraph Source owns capacity and
synthetic active Leases. Agent selection uses `WorkGraphTaskAssignment/v1`;
agents write lease-bound `WorkGraphTaskResult/v1`. All GitHub WorkGraph comment
protocols except the generation-correlated `WorkGraphInfoRequest/v2` marker
remain v1, and Lease is never a GitHub comment. A separate
`workgraph-v2-protocol.mjs` module and three narrow MCP tools now support
canonical `WorkGraphTask/v2` Assignment and Result reporting, including nested
parallel-family validation and exact prior-Result info requests. No enabled
workflow invokes those staged paths yet. The isolated
[`WorkGraphWorkflowDefinition/v1` VNext fixture](docs/workgraph-vnext-definition-demo.md)
vendors the frozen Dogfood definition/root contract without replacing or
activating the V2 proof.
The VNext `issue-validator` and `demo-orchestrator` profiles consume the
canonical Dispatch execution context and use the narrow
`submit_task_result` tool; they do not expose a generic GitHub write tool.
Validation uses only the two criteria in
`.github/workgraph/profiles/issue-validation/new-issue-default.md`.

The dependency-free Node MCP exposes eleven narrow tools: existing paths for
verified legacy Result inspection, expected-state transition, Assignment,
Acceptance, parent info request, and feedback; the VNext-only
`get_vnext_principal_issue` and `submit_task_result`; plus
create-only workflow Assignment and Result paths and a prior-Result-bound
workflow info request. Before staged workflow Result writes and parent info requests, it locally
checks the Source-issued Lease deadline and calls the authenticated read-only
exact-active-Lease validation endpoint. VNext `submit_task_result` instead
verifies its canonical Dispatch and Lease artifact chain.
It does not allocate, persist, release, poll, or retry Leases.
A Result never closes a task; Acceptance is separate and binds the exact
current Result comment ID and SHA-256 body digest. Source-computed `bodyDigest`
is never present in Result JSON.
Canonical transition titles let exact retries reconcile partial create,
attachment, and status writes. Result/Acceptance writes use fail-closed
pre/post reconciliation; detected races require manual remediation and are
never hidden by deletion.

See [the reporter contract](docs/workgraph-result-reporter.md) for exact schemas,
identity configuration, lifecycle rules, current team/Core authority, and
network-free validation commands. The
[GitHub protocol integration tests](docs/workgraph-github-protocol-tests.md)
are a separate explicit live layer with marker-scoped cleanup.
