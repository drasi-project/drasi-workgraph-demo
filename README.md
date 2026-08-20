# drasi-workgraph-demo

A strict, breaking WorkGraph Issue workflow prototype for the fixed
`drasi-project/drasi-workgraph-demo` repository. It defines five
REST-launchable profiles:

- `issue-orchestrator`
- `issue-assigner`
- `issue-validator`
- `issue-info-requester`
- `workgraph-result-acceptor`

Tasks are native child Issues with exact type name `WorkGraphTask`, configured
live type node ID `IT_kwDOCX0YF84CKGIJ`, and one canonical `WorkGraphTask/v1`
YAML body. `.github/workgraph/workers.yaml` defines two stable capacity-one
workers with 30-minute leases. New queue ownership uses
`WorkGraphTaskAssignment/v2`; only the external stateful dispatcher writes
`WorkGraphTaskLease/v1`; workers write lease-bound `WorkGraphTaskResult/v2`.
Historical Assignment/v1 and Result/v1 remain inspectable. Validation uses only
the two criteria in
`.github/workgraph/profiles/issue-validation/new-issue-default.md`.

The dependency-free Node MCP exposes seven narrow tools for verified Result
inspection, expected-state transition, Assignment, lease-bound revisable Result,
Acceptance, parent info request, and feedback/external redispatch.
A Result never closes a task; Acceptance is separate and binds the exact
current Result comment ID and SHA-256 body digest. Source-computed `bodyDigest`
is never present in Result JSON.
Canonical transition titles let exact retries reconcile partial create,
attachment, and status writes. Result/Acceptance writes use fail-closed
pre/post reconciliation; detected races require manual remediation and are
never hidden by deletion.

See [the reporter contract](docs/workgraph-result-reporter.md) for exact schemas,
identity configuration, lifecycle rules, and validation commands.
