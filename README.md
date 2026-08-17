# drasi-workgraph-demo
WorkGraph workflow prototype

The minimal GitHub WorkGraph prototype defines exactly two Copilot agent
profiles:

- `.github/agents/issue-validator.agent.md` (`agentProfile`:
  `issue-validator`, `taskType`: `issue-validation`)
- `.github/agents/issue-risk-profiler.agent.md` (`agentProfile`:
  `issue-risk-profiler`, `taskType`: `issue-risk-profile`)

Both use the scoped, retry-safe Result comment capability documented in
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
