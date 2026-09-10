# Shopping List

One list. Add an item, set its quantity, tick it off, or delete it. Search and
sort help you find things. The browser talks to a small Node.js backend, which
saves a JSON file. Nothing else runs in the background on the app's behalf.

This is a **deliberately imperfect development playground**, not a production
shopping service.

## Run

Requires **Node.js 22+** (npm comes with Node). No `npm install`, build, database,
Docker, GitHub token, or WorkGraph server is needed just to use the app.

```bash
cd app                       # from the drasi-workgraph-demo repository
npm start
```

Open <http://127.0.0.1:3000>. Stop with Ctrl+C. For a different port, use
`PORT=3001 npm start`. The server binds only to this machine.

The first start copies `seed.json` to ignored `app/data/items.json`. Changes
survive a browser refresh and server restart. Writes use a temporary file and
rename; requests are small and mutations are synchronous, so two requests do
not overwrite each other's changes. Invalid saved data produces an error,
never a silent reset. Only one app server/reset operation is allowed at once.

## Six things to work on

The baseline starts with six items; Bread and Coffee are already bought.

| ID | Kind | Starting behavior / requested change |
|----|------|-------------------------------------|
| B01 | Bug | Search for `milk` fails to find `Milk`; make search case-insensitive. |
| B02 | Bug | Quantity sort puts 10 and 12 before 2 and 3; sort numerically. |
| B03 | Bug | The sidebar says six left instead of four; exclude bought items. |
| F01 | Feature | Edit an item's name and quantity without deleting it. |
| F02 | Feature | Clear all bought items with confirmation. |
| F03 | Feature | Download the whole list as a plain-text checklist. |

[`../demo/shopping-list/backlog.json`](../demo/shopping-list/backlog.json)
contains reproduction steps and acceptance criteria used to create the Issues.
These are ordinary functional defects, not intentionally vulnerable code.

```bash
npm test                     # working-behavior regressions: should pass
npm run test:bugs             # desired behavior: three failures in the baseline
```

The second command is deliberately red, separate from the normal suite. When
fixing a bug, move its assertion into `test/*.test.mjs` as a passing regression.
Do not fix every exercise at once or change assertions to expect broken
behavior. The harness has its own offline tests, run from the repository root:
`node --test tests/shopping-demo.test.mjs`.

## Start a GitHub experiment

For Issue operations only, install/sign into GitHub CLI (`gh auth login`) with
access to **drasi-project/drasi-workgraph-demo**. The tool checks this clone's
origin and explicitly targets github.com; it cannot accidentally target the
coordinator or another repository.

Stop the shopping-list server, then run from `app/`:

```bash
npm run demo:seed             # read-only preview
npm run demo:seed -- --apply  # six ordinary Issues: three bugs, three features
npm run demo:status           # current run, Issue numbers, baseline, local lock
```

Seeding is idempotent: repeating it adopts already-created Issues, including
closed ones, and creates only missing entries. A unique run label plus an
embedded ownership marker separates these Issues from all other tests in this
busy repository. Existing labels and history are retained.

**Nothing starts WorkGraph automatically.** Seed Issues have `demo:shopping-list`
and a per-run label, never a `workgraph:*` admission label or the WorkGraphTask
Issue type. Pick one Issue when you are ready.

### Using WorkGraph for actual development

Commit and push the app to the branch your cloud agents use before dispatching
work. Local files are not visible to GitHub-hosted agents. Use a deliberately
configured development workflow with the existing `issue-implementer` actor
(which creates PRs), appropriate review, and human approval as
`agentofreality`. Keep merging/releasing a human decision.

The existing four-stage `issue-lifecycle` example is protocol/intake practice;
`drasi-server-issue` produces a resolution **plan**, not an app implementation.
Neither is silently repurposed here. This app does not modify workflow
definitions, mappings, pinned refs, tokens, the live runtime, or cloud-agent
settings. A development mapping and any necessary ref updates must be set up
explicitly before an end-to-end cloud run.

Then add the exact selector label from that mapping to your chosen ordinary
Root Issue. WorkGraph creates separate Task Issues. Human answers go on those
Tasks, not on the Root Issue; follow the task's `@workgraph` instructions. Do not
rewrite an admitted Root Issue's title or body.

## Reset and try again

Stop the shopping-list server first. Preview commands never write files or
change GitHub. `--apply` is the explicit destructive-to-the-active-copy step,
but previous code/data is moved into a dated backup, not discarded.

```bash
npm run demo:reset                  # preview exact old Issue numbers
npm run demo:reset -- --apply        # code + data + a fresh six-Issue backlog
```

This closes this run's proven-owned Root Issues and verified descendant
WorkGraphTask Issues, removes their Root Issue admission labels, backs up the
entire old `app/`, and restores the original app with its intentional bugs.
It then creates six fresh Issues with new numbers. **Previous comments and task
evidence remain on the closed Issues.** No issue is deleted.

If WorkGraph has touched the run, finish or stop its runtime **and cloud work**
first, then use `npm run demo:reset -- --apply --work-stopped`. That flag is
your confirmation, not a command that stops anything. An app reset is not
cancellation of an in-flight agent. Do not reset while another agent/session is
editing `app/`.

Unrelated Issues, unknown/non-WorkGraph sub-issues, and PRs are never closed.
Ambiguous ownership blocks the reset before GitHub writes. PR branches remain
available as evidence; close or merge them intentionally yourself.

Local-only variants need no GitHub access:

```bash
npm run reset:data -- --apply       # fresh six-item data; keep code and Issues
npm run reset:code -- --apply       # baseline code + data; keep GitHub Issues
```

The harness lives **outside** `app/`, under `demo/shopping-list/` and `scripts/`,
so resetting the app does not erase the reset command. Its immutable,
hash-checked `baseline.json` is portable: no tag, special Git ref, local commit,
or original worktree is required. New files inside `app/` move into the backup
with the old code. Symlinks and nested Git metadata are refused.

No reset command changes a branch, Git index, commit, remote, `.github/`,
another repository, or any existing process. Code reset appears as normal
working-tree changes; review/commit/push those yourself if you want cloud
agents to start from the baseline again. Existing staged changes are untouched.

### Recovery and backup details

The ignored repository-root `.shopping-demo/` folder contains the run journal,
operation lock, archived run manifests, and `backups/<id>/app/` (or `data/`).
The reset prints the exact backup path. Copy individual files back manually if
needed; keep this folder while using the experiments.

GitHub and filesystem changes cannot form one transaction. The journal retains
the next run ID and backup across failures. Repeat an interrupted command with
the same flags: it resumes, adopts previously created Issues, and does not
erase the backup. If the journal is lost, the tool will not guess which old
Issues to close; they remain as evidence.

If the app was force-killed and left a lock, run
`node scripts/shopping-demo.mjs unlock --apply` from the repository root. It
refuses if the recorded process is still alive; it never kills a process.

For a coding assistant that must use its native Issue-creation tool, the
repository-root command `node scripts/shopping-demo.mjs seed --prepare`
persists the run, ensures labels, and writes exact missing Issue requests to
`.shopping-demo/issue-requests.json` **without creating Issues**. Create those
requests with the native tool and repeat `--prepare` to adopt the results.

## The small codebase

| File | Responsibility |
|------|----------------|
| `server.mjs` | Local HTTP server, API, explicit static-file allowlist. |
| `list.mjs` | Validation, JSON-file persistence, filtering and sorting. |
| `public/index.html`, `styles.css` | Responsive, keyboard-accessible UI. |
| `public/app.js`, `summary.mjs` | Browser interactions and remaining count. |
| `seed.json` | Repeatable starting data. |
| `test/` | Ordinary regressions and separate known-bug assertions. |

### API

All successful API responses are JSON except the empty delete response.
Mutation bodies use `Content-Type: application/json`. Names are trimmed and
limited to 1-80 characters; quantities are integers from 1 to 99.

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/health` | Local health response. |
| GET | `/api/items?q=Milk&sort=added` | Items plus whole-list `total` and `bought` counts. Sort: `added`, `name`, `quantity`. |
| POST | `/api/items` | Add `{ "name": "Milk", "quantity": 1 }`; quantity defaults to 1 if omitted. |
| PATCH | `/api/items/:id` | Set `{ "bought": true }` or `{ "bought": false }`. Editing is F01, not implemented yet. |
| DELETE | `/api/items/:id` | Delete one item; returns 204. |

Invalid input returns 400, missing items 404, unexpected read/write failures
500 with a terminal error. The browser displays failures instead of claiming a
save succeeded. Cross-origin requests are rejected, user text is rendered as
text, and only explicit public assets are served. This local, single-user
practice app is not designed for deployment on a public network.
