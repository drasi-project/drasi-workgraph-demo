# drasi-workgraph-demo

This repository is a **consumer sandbox**, not the WorkGraph engine workspace.
[`drasi-project/drasi-workgraph`][workgraph] owns the canonical engine, protocol,
Rust `workgraph-compile` compiler, repository kit, reusable agent profiles, and
app starter.

**This is an older installation, not the current repository template.** It
deliberately retains **8 workflow definitions and 21 agent profiles**; the
canonical kit has **13 workflows and 37 profiles** at this documentation
refresh. The Demo has not been regenerated. Do not assume newer kit features
exist here, or install the current kit over this active sandbox as a setup or
documentation-cleanup step.

## Set up WorkGraph / Drasi Server or a new sandbox

Use the canonical guides rather than copying deployment instructions from this
Demo:

| Guide | Purpose |
|---|---|
| [Setup overview][setup] | Understand the host/consumer split and setup order. |
| [Host setup][host] | Set up Drasi Server and the WorkGraph runtime. |
| [Sandbox setup][sandbox] | Create and configure a separate GitHub repository for testing. |

For a **new, dedicated sandbox destination**, use the canonical installer
**from the WorkGraph checkout**, not from this Demo:

```bash
cd /path/to/drasi-workgraph
node scripts/setup-repository.mjs /path/to/acme-repo --repo owner/acme-repo --with-shopping
```

Omit the optional `--with-shopping` when you do not want the shopping app and
its harness. Follow the sandbox guide for GitHub repository creation, pinned
refs, profiles, and runtime wiring. Creating repository files, starting an app,
and seeding Issues are separate from starting WorkGraph.

Do not create a new sandbox by copying this instance's state, changing its
origin, or resetting its app. The canonical exporter is portable; this Demo's
older shopping helper and MCP reporter are fixed to
`drasi-project/drasi-workgraph-demo`. In particular,
`scripts/shopping-demo.mjs` does **not** accept `--repo`.

## A tiny app to practice on

[`app/`](app/) contains a shopping list: a browser UI, a Node.js backend, and a
JSON file. It needs **Node.js 22+**, but no dependency installation, build,
database, containers, GitHub token, or WorkGraph server just to use the app:

```bash
# From this Demo checkout
cd app
npm start
```

Open <http://127.0.0.1:3000>. This starts **only the shopping app**, not Drasi
Server, WorkGraph, webhook delivery, or cloud agents.

The [app guide](app/README.md) and
[backlog](demo/shopping-list/backlog.json) describe the three deliberate bugs
(B01-B03) and three unfinished features (F01-F03). They remain exercises, not
changes to apply during setup. The app guide is part of the older reset
baseline; use the [operator guide](demo/shopping-list/README.md) for this
instance's helper behavior, side effects, and reset precautions.

## WorkGraph prototype

The WorkGraph runtime uses Drasi Server's `github-workgraph-v1` Source and
`workgraph-v1` Reaction. The [vendored runtime contract](.github/workgraph/contracts/runtime-v1.json)
records the five fixed, definition-independent fact queries:
`wg-root-state`, `wg-task-state`, `wg-task-actions`, `wg-lease-state`, and
`wg-root-comments`. Control flow does not add per-edge, branch, fork, wait, or
terminal queries. See the [canonical protocol reference][protocol] for the
current contract instead of treating this Demo's installed copy as authority.

An ordinary **Root Issue** describes the requested work. Shopping-demo seeding
does not give it the `WorkGraphTask` Issue type or a `workgraph:*` selector.
After host setup, a human can add the exact, case-sensitive
`workgraph:<mapping-id>` label from an explicitly configured `workflowMappings`
entry. The runtime then creates separate **WorkGraphTask Issues**: the initial
Root Task and any workflow-defined successors or children. Do not create those
Task Issues yourself or use their Issue type for the seeded Root Issues.

Keep an admitted Root Issue open and do not rewrite its title/body or remove
its selector while work is active. Assignment, work, and review replies go on
the Task Issue; a workflow's explicit information wait instead resumes from
an authorized comment on the ordinary Root Issue. Admission, task creation, and
dispatch require a separately configured and running WorkGraph host; neither
`npm start` nor Issue seeding provides it.

The installed [`issue-lifecycle`](.github/workgraph/workflows/issue-lifecycle.yaml)
is a four-stage intake/protocol exercise.
[`drasi-server-issue`](.github/workgraph/workflows/drasi-server-issue.yaml)
validates and analyzes an Issue and produces a resolution plan; it is not an
app-implementation workflow. A cloud development run needs a deliberately
configured development workflow and review/approval policy. Hosted agents see
the configured pushed ref, not uncommitted app changes in this checkout.

## Demo-specific maintenance notes

| Document | Scope |
|---|---|
| [Shopping-demo operator guide](demo/shopping-list/README.md) | Fixed-repository helper, GitHub reads/writes, preparation, and destructive reset boundaries. |
| [Definition and proof notes](docs/workgraph-v1-definition.md) | The eight installed fixtures, regression examples, and inactive offline proof. |
| [Reporter notes](docs/workgraph-result-reporter.md) | The older installed reporter's fixed repository, fixture registry, and configuration. |

These notes preserve this instance's useful proof history. They are not a
replacement for the canonical [setup guides][setup] or
[agent-profile documentation][profiles].

[workgraph]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/README.md
[setup]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/README.md
[host]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/host.md
[sandbox]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/sandbox.md
[protocol]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-v1-definition.md
[profiles]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/repository-kit/docs/workgraph-agent-profiles.md
