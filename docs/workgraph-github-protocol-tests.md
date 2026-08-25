# WorkGraph GitHub protocol integration tests

The live integration layer verifies the fixed repository's GitHub Issue protocol
without Drasi, Agent Tasks, Continuous Queries, Reactions, tunnels, or the
end-to-end runtime. It creates one ordinary parent and one native typed
`WorkGraphTask` child, invokes the production reporter MCP, and closes both
Issues in failure-safe cleanup.

The live suite is not part of default unit validation. It skips unless
`WORKGRAPH_GITHUB_INTEGRATION=1` and fails closed unless the repository is
exactly `drasi-project/drasi-workgraph-demo`.

## Required environment

Supply secrets and repository configuration only through environment
references:

```text
WORKGRAPH_GITHUB_INTEGRATION=1
WORKGRAPH_GITHUB_REPOSITORY=drasi-project/drasi-workgraph-demo
COPILOT_MCP_WORKGRAPH_TOKEN
COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID
COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID
COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID
COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID
COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID
COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID
```

The single-token demo harness requires every listed writer ID to equal the
token's immutable numeric GitHub user ID. It checks that identity before
creating an Issue.

The credential needs Metadata read, Contents read for
`.github/workgraph/agents.yaml`, Issues read/write, and organization Issue
Types read if the credential model exposes that permission. It needs no Pull
Requests, Actions administration, Secrets/Variables administration, webhooks,
branches, or repository code write permission.

## Commands

Network-free default validation:

```bash
node --check .github/mcp/workgraph-reporter.mjs
node --check .github/mcp/workgraph-v2-protocol.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
```

The v2 protocol tests are network-free. The explicit live suite below still
exercises only the operational v1 reporter.

Explicit live run after injecting the required environment:

```bash
node --test --test-concurrency=1 tests/integration/workgraph-github-protocol.mjs
```

The workflow in `.github/workflows/workgraph-github-protocol.yml` is manual
`workflow_dispatch` only and serializes live runs.

## Artifact lifecycle and cleanup

The suite prints a non-secret marker before its first mutation:

```text
wg-protocol-it/<UTC timestamp>/<UUID>
```

The marker appears in the parent title/body and child title. The child body
remains byte-exact `WorkGraphTask/v1`. Every successful create is registered
immediately. Test cleanup closes the child first and parent second, continues
after individual close failures, refetches both Issues, and requires zero open
marker matches.

After a hard process or runner termination, inject the same credentials and
run:

```bash
WORKGRAPH_GITHUB_RUN_ID='<exact printed marker>' \
node scripts/cleanup-workgraph-github-protocol.mjs
```

Cleanup considers only exact marker titles, then verifies fixed repository,
configured creator ID, canonical body, and native parent relation before any
close. A foreign or ambiguous marker match is refused. Cleanup never comments,
deletes, changes types, labels, or assignees, or touches a pull request.

GitHub does not delete Issue artifacts. Successful cleanup therefore leaves
two closed Issues and their canonical comments as an audit record.

## Protocol coverage

The suite creates the child directly with GraphQL `createIssue`, supplying both
`issueTypeId` and `parentIssueId`. It refetches GraphQL and REST state and
checks exact type name/ID, native parent/child linkage, body bytes, authors, and
open state.

Assignment, Result, Feedback, revised Result, revised Feedback, Result snapshot,
and Acceptance go through the production MCP entrypoint. Exact expected bytes
come from `formatTask`, `parseTask`, `formatAssignment`, `formatTaskResult`,
`formatFeedback`, `formatAcceptance`, and `resultDigest`. Exact retries must
return the same comment IDs with `reconciled: true`.

Result writes use a test-only loopback Lease validator with an ephemeral
in-memory token. It implements only the reporter's exact validation boundary
and never allocates or persists a Lease. Negative cases cover bad task,
parent, Assignment, Result, digest, agent, slot, Lease, validation response,
and feedback revision bindings. Every negative case must leave GitHub comments
and Issue state unchanged.
