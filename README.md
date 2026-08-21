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
workers with 30-minute leases. The GitHub WorkGraph Source owns their queues and
synthetic active Leases. Queue ownership uses `WorkGraphTaskAssignment/v1`;
workers write lease-bound `WorkGraphTaskResult/v1`. All GitHub WorkGraph comment
protocols are v1-only, and Lease is never a GitHub comment. Validation uses only the two criteria in
`.github/workgraph/profiles/issue-validation/new-issue-default.md`.

The dependency-free Node MCP exposes seven narrow tools for verified Result
inspection, expected-state transition, Assignment, lease-bound revisable Result,
Acceptance, parent info request, and feedback. Before every Result write and
parent info request, it locally checks the Source-issued Lease deadline and
calls the authenticated read-only exact-active-Lease validation endpoint.
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
validation commands.
