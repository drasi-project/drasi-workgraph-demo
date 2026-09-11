# Shopping-demo operator guide

This guide describes the **older, instance-specific harness installed in
`drasi-project/drasi-workgraph-demo`**. It is not the portable canonical
shopping exporter and is not a WorkGraph / Drasi Server installation guide.
For a new repository, follow the canonical [sandbox setup][sandbox] and run
`scripts/setup-repository.mjs` from WorkGraph, not this Demo. See the
[Demo overview](../../README.md) for the installation-version distinction.

The [app guide](../../app/README.md) describes the local app and exercises.
That document is also embedded in the immutable reset baseline and retains
older, instance-specific operator prose. Use this guide for operational
boundaries; do not change or regenerate the app or baseline just to refresh
setup documentation.

## Before using the helper

The checked-in [command interface](../../scripts/shopping-demo.mjs) runs from
this Demo's repository root. It requires Node.js 22+. GitHub operations,
**including previews that read GitHub**, require an authenticated GitHub CLI
(`gh`) with access to `drasi-project/drasi-workgraph-demo`.

The [GitHub adapter](github.mjs) checks that `origin` is this exact repository
and explicitly uses github.com. The [local helper](local.mjs) hardcodes the
repository identity in run records and Issue requests. **There is no `--repo`
option in this installed harness.** Do not change the origin to bypass its
guard or copy its run state to another repository. The portable canonical
exporter's instructions do not apply to this source copy.

Starting `app/` starts only the shopping-list server. Seeding creates ordinary
Issues, not a running workflow. Neither operation starts Drasi Server,
WorkGraph, webhook delivery, or cloud work; use [host setup][host] for that.

## Commands and side effects

Run these commands from the **Demo repository root**, not from WorkGraph.
This table documents behavior; it is not a sequence to execute during setup.
Stop the shopping-list server before changing operations: it shares the
helper's operation lock.

| Command | GitHub activity | Local effects |
|---|---|---|
| `node scripts/shopping-demo.mjs status` | None | Reads the baseline, recorded run, and lock; does not start or stop anything. |
| `node scripts/shopping-demo.mjs seed` | Reads the run's Issue inventory | Preview only; no run or request files are saved. |
| `node scripts/shopping-demo.mjs seed --prepare` | Reads Issues and creates missing labels | Persists the run and writes `.shopping-demo/issue-requests.json`; does **not** create Issues. |
| `node scripts/shopping-demo.mjs seed --apply` | Reads Issues, creates missing labels and Issues | Persists the run and Issue ownership records. |
| `node scripts/shopping-demo.mjs reset` | Reads owned Root Issues and descendant Tasks | Preview only; requires an existing recorded experiment. |
| `node scripts/shopping-demo.mjs reset-code` | None | Previews restoring all app code and data from the baseline. |
| `node scripts/shopping-demo.mjs reset-data` | None | Previews restoring sample data only. |

The plain `seed` and `reset` previews are **read-only, not offline**. In
particular, "`--prepare` does not create Issues" does **not** mean "no writes":
it creates missing GitHub labels and persists local run/request data.
`--prepare` is only valid with `seed` and cannot be combined with `--apply`.

The `app/package.json` aliases (`demo:seed`, `demo:reset`, `demo:status`,
`reset:code`, and `reset:data`) invoke this same helper. They do not add
repository portability or start WorkGraph.

## Seed an experiment deliberately

The [backlog](backlog.json) contains six ordinary Root Issue requests:
B01-B03 are the three deliberate bugs; F01-F03 are unfinished features.
Seeding does not implement them or alter the app. Keep these exercise
definitions intact unless you are intentionally changing the exercise.

Each seeded Issue has `demo:shopping-list`, a unique per-run label, and an
embedded ownership marker. Repeating a seed for the same recorded run adopts
existing Issues, including closed ones, and creates only missing entries.
Do not delete the run journal to try to restart an experiment.

For a coding assistant using its native Issue-creation tool, `seed --prepare`
produces the exact missing requests. Create those requests, retaining their
bodies and labels, then repeat `--prepare` to adopt the results. Preparation
itself does not create the Issues.

These Root Issues have neither a `workgraph:*` selector nor the
`WorkGraphTask` Issue type. Only when the host and a suitable pinned workflow
mapping are configured should a human add that mapping's exact
`workgraph:<mapping-id>` selector to a chosen Root Issue. WorkGraph creates
the separate Task Issues. Keep the admitted Root Issue open and its title/body
unchanged; place human answers on the Task Issue as instructed.

The installed `issue-lifecycle` is intake/protocol practice, and
`drasi-server-issue` produces a resolution plan. Seeding app bugs does not turn
either into an app-development workflow. Newer canonical kit workflows are
not automatically present in this older installation.

## Reset is destructive to the active copy

**Reset is not setup, cancellation, an upgrade, or a safe way to refresh an
active sandbox.** Do not apply it while an app server, another editor/session,
WorkGraph runtime, or cloud agent is using this experiment. Backups preserve
old files, but the active app is still replaced and Issue state can change.

Before considering an applied reset, inspect its preview and retain the run
journal and backups. Finish or stop relevant runtime and cloud work yourself.
For `reset --apply`, `--work-stopped` is required when the run has WorkGraph
selector labels or descendant Tasks. That flag is only your acknowledgement;
it stops no process and cancels no agent or PR.

| Applied command | What changes |
|---|---|
| `node scripts/shopping-demo.mjs reset --apply` | Removes owned Root Issue admission labels, closes proven-owned Root Issues and verified descendant WorkGraphTasks, backs up all old app contents, restores baseline code/data, and seeds six fresh Issues. Add `--work-stopped` only after satisfying the requirement above. |
| `node scripts/shopping-demo.mjs reset-code --apply` | Backs up and replaces all `app/` code and data, including its README and instructions. Keeps GitHub Issues unchanged; does not cancel their work. |
| `node scripts/shopping-demo.mjs reset-data --apply` | Moves saved `app/data/` into a backup; the next app start loads sample data. Keeps code and GitHub Issues unchanged. |

`--work-stopped` is accepted only by `reset`; local-only reset variants are
not a workaround for the stopped-work requirement. Full/code resets restore
the three intentional bugs and leave F01-F03 unimplemented; data-only resets
leave code changes intact. None of them upgrades the installed WorkGraph kit.

Ownership ambiguity or unknown/non-WorkGraph sub-issues blocks a full reset.
Issues are closed, never deleted, so their comments and task evidence remain.
The helper does not close PRs, alter Git branches/index/history/remotes, change
`.github/`, touch another repository, or stop existing processes. Preserving
Git history does **not** mean preserving the active app's uncommitted edits:
those move to the backup on a code reset.

## Recovery and baseline provenance

The ignored `.shopping-demo/` directory holds the run journal, operation lock,
archived run records, request file, and backups. Full/code resets retain old
files under `backups/<id>/app/`; a data reset uses `backups/<id>/data/`.
Keep these records private and preserve them while an experiment is active.
The helper prints the backup path so individual files can be recovered
deliberately.

GitHub and filesystem changes are not one transaction. After a partial
failure, review the error and re-establish the stopped-work conditions before
repeating the same command with the same safety flags. The journal reuses the
pending run ID and backup and adopts already-created Issues. Do not remove it
or substitute a different sandbox's records to force recovery.

`node scripts/shopping-demo.mjs unlock --apply` only removes a stale operation
lock after its recorded process has exited. It refuses a live owner and does
not stop processes.

The immutable, hash-checked `demo/shopping-list/baseline.json` is the reset
source, not a Git tag or a template to regenerate during setup. It embeds the
app files and documentation. The operator guide lives outside `app/` so it
survives an intentional app reset without changing that historical baseline.

[host]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/host.md
[sandbox]: https://github.com/drasi-project/drasi-workgraph/blob/workgraph-generic-recovery/docs/setup/sandbox.md
