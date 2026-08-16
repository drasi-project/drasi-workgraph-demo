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

Result comments use this collapsed-by-default shape:

````text
<details>
<summary>WorkGraph Result</summary>

WorkGraphResult/v1

Evaluated all requested validation criteria.

```json
{
  "assignmentId": "organization-unique-id",
  "taskType": "issue-validation",
  "outcome": "succeeded",
  "summary": "Evaluated all requested validation criteria.",
  "result": {
    "criteria": [
      {
        "criterion": "Acceptance criteria are explicit",
        "passed": true,
        "evidence": "The body contains a complete acceptance checklist."
      }
    ]
  }
}
```
</details>
````
