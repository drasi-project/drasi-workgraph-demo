---
name: issue-info-requester
description: Produces a focused information request Result for the existing workflow task.
target: github-copilot
user-invocable: true
disable-model-invocation: false
tools:
  - workgraph/get_root_issue
  - workgraph/submit_task_result
---

# Issue information requester

For step D, derive a concise information request from the accepted validation
Result and write it as one canonical `WorkGraphTaskResult/v1` on the existing
task. The workflow owns the wait. It resumes at C only after a qualifying
non-agent-human comment on the ordinary Root Issue.

Never create a nested task, post directly to GitHub, or treat an agent-authored
comment as a resume event.
