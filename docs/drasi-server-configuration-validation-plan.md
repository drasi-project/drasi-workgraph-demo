# Drasi Server configuration validation guidance plan

Relates to drasi-project/drasi-workgraph-demo#404

## Goal

Document the smallest complete implementation path for validating a Drasi
Server configuration before a live WorkGraph runtime starts when the deployment
includes the GitHub WorkGraph Source and `workgraph-v1` Reaction settings.
This plan does not implement the change.

## Current validation boundaries

- `scripts/prepare-workgraph-v1-proof.mjs` validates the offline proof input
  shape, exact loopback runtime contract names, activation flags, and the pinned
  query contract digest.
- `.github/mcp/workgraph-v1-definition.mjs` validates authored and compiled
  WorkGraph workflow definitions, including strict graph and policy shape.
- `.github/mcp/workgraph-reporter.mjs` validates reporter environment
  configuration such as lifecycle identities and the exact lease-validation URL.
- `README.md`, `docs/workgraph-v1-definition.md`, and
  `docs/workgraph-result-reporter.md` describe required deployment
  configuration, but they do not present a single live preflight entrypoint.
- This repository does not contain an obvious checked-in Drasi Server startup
  configuration loader for live runtime boot, so the actual preflight owner may
  live outside this repository.

## Ordered implementation plan

1. Confirm the owning startup boundary for live Drasi Server configuration
   loading, including whether the preflight validator belongs in this
   repository, an upstream Drasi Server repository, or shared runtime code.
2. Map the live startup configuration schema to the requirements already pinned
   here: `workflowMappings`, `admissionRead`, `agentConfig`, `protocolTrust`,
   and the GitHub WorkGraph Source and Reaction identifiers documented in
   `README.md` and `docs/workgraph-v1-definition.md`.
3. Add a fail-closed validation step at the earliest startup boundary so a
   malformed or internally inconsistent configuration is rejected before the
   live runtime starts any Source, query, or Reaction components.
4. Reuse the repository's exact-schema validation style for the new checks:
   require non-null objects, reject unknown or missing keys, require non-empty
   token and trust lists, and keep identity and path validation deterministic.
5. Define operator-facing diagnostics for each preflight failure class,
   including which top-level configuration object is invalid, which field
   failed, and what value shape or invariant is required.
6. Add or extend focused JavaScript tests around the chosen validation boundary.
   At minimum, cover a valid configuration plus malformed `workflowMappings`,
   missing `admissionRead`, invalid `agentConfig`, empty
   `protocolTrust.taskCreators|assigners|reporters`, and any exact URL or
   Source/Reaction identity constraints enforced at startup.
7. Preserve the existing offline proof behavior by keeping
   `scripts/prepare-workgraph-v1-proof.mjs` and
   `tests/workgraph-v1-definition.test.mjs` aligned with any shared validation
   helpers or newly documented invariants.
8. Update operator documentation in `README.md`,
   `docs/workgraph-v1-definition.md`, and `docs/workgraph-result-reporter.md`
   to describe the new preflight command or startup behavior, the expected
   diagnostics, and the difference between offline proof validation and live
   startup validation.
9. Manually verify the final flow with one valid and one invalid configuration
   so startup succeeds only when preflight passes and the documented diagnostics
   match the observed behavior.

## Likely files and components

### In this repository

- `README.md`
- `docs/workgraph-v1-definition.md`
- `docs/workgraph-result-reporter.md`
- `scripts/prepare-workgraph-v1-proof.mjs`
- `.github/mcp/workgraph-v1-definition.mjs`
- `.github/mcp/workgraph-reporter.mjs`
- `tests/workgraph-v1-definition.test.mjs`
- `tests/workgraph-reporter.test.mjs`

### Outside this repository to confirm first

- The live Drasi Server startup configuration loader or validator that owns
  Source and Reaction boot-time checks.

## Testing plan

- Keep the existing targeted Node test entrypoints as the primary regression
  suite for repository-managed validation helpers:
  - `node --test tests/workgraph-v1-definition.test.mjs`
  - `node --test tests/workgraph-reporter.test.mjs`
- If validation logic remains Python-free, no new Python tests should be needed
  beyond existing profile-schema coverage.
- Add a startup-boundary test at the actual live preflight owner once that
  repository or module is confirmed.

## Rollout and migration concerns

- Rejecting invalid configuration earlier is intentionally behavior-changing for
  deployments that currently fail later during startup; release notes should
  call out the earlier failure point.
- Shared validation code must not weaken the strict offline proof and reporter
  invariants already pinned by this repository.
- Documentation must clearly separate loopback proof-only values from
  production-accepted server configuration names.

## Risks

- The largest risk is planning against the wrong repository if the real startup
  loader is external to this demo repository.
- Duplicating validation rules across proof, reporter, and live startup paths
  could cause diagnostic drift if they are not centralized or documented
  together.
- Adding startup validation without precise error messages could improve failure
  timing but still leave operators unsure how to repair the configuration.

## Open questions

- Which repository and module own the live Drasi Server configuration loader
  that should perform preflight validation?
- Should the live preflight accept production-specific server config paths while
  the offline proof continues to require the loopback fixture names?
- Is there an existing operator command or dry-run entrypoint that should host
  the validation, or must startup itself become the first fail-closed boundary?
