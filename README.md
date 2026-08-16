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
Issue validation selects repository criteria with the exact Assignment task
`{ "validationProfile": "new-issue-default" }`. The profile is
`.github/workgraph/profiles/issue-validation/new-issue-default.md`; Assignment
payloads do not duplicate its criteria.

Result comments use this collapsed-by-default shape:

````text
<details>
<summary>WorkGraph Result</summary>

WorkGraphResult/v1

Validated the title and body requirements.

```json
{
  "assignmentId": "organization-unique-id",
  "taskType": "issue-validation",
  "outcome": "succeeded",
  "summary": "Validated the title and body requirements.",
  "result": {
    "criteria": [
      {
        "criterion": "The Issue has a non-empty title",
        "passed": true,
        "evidence": "The title contains non-whitespace text."
      },
      {
        "criterion": "The Issue body is present",
        "passed": true,
        "evidence": "The body contains non-whitespace text."
      }
    ]
  }
}
```
</details>
````
