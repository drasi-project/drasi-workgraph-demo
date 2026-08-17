# drasi-workgraph-demo

WorkGraph workflow prototype with two Copilot agent profiles:

- `issue-validator` / `issue-validation`
- `issue-risk-profiler` / `issue-risk-profile`

Each agent receives a native child Issue whose exact Issue Type is
`WorkGraphTask`, reads its raw strict WorkGraphAssignment JSON body, follows
GitHub's authoritative parent relation, works only on the parent content, and
writes progress or one Result only to the task. Agents never write, label, or
close the parent and never close the task; WorkGraph machinery closes the task
after accepting its Result.

The dependency-free reporter exposes only `report_progress` and
`submit_task_result`. Result comments have exact canonical bytes:

````text
WorkGraphTaskResult/v1

```json
{
  "assignmentId": "issue-validation:I_parent_node_id",
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
````

See
[`docs/workgraph-result-reporter.md`](docs/workgraph-result-reporter.md) for
the strict task, identity, retry, progress, and Result contracts.
