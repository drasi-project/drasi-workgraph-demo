# drasi-workgraph-demo
WorkGraph workflow prototype

The minimal GitHub WorkGraph prototype defines exactly two Copilot agent
profiles:

- `.github/agents/issue-validation.agent.md`
- `.github/agents/issue-risk-profile.agent.md`

Both use the scoped, retry-safe Result comment capability documented in
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md).
