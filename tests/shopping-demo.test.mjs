import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEMO_LABEL, REPOSITORY, ROOT, acquireLock, captureBaseline, digest, ensureState,
  loadBaseline, readJson, restoreCode, restoreData, statePath, unlock, writeJson,
} from "../demo/shopping-list/local.mjs";
import {
  catalog, closeRun, createRun, inventory, issueRequest, marker, readRun,
  resetInventory, runLabel, seedRun,
} from "../demo/shopping-list/github.mjs";
import { main, resetExperiment } from "../scripts/shopping-demo.mjs";
import { deriveWorkGraphProtocolId, formatRuntimeTask } from "../.github/mcp/workgraph-v1-definition.mjs";

const base = `repos/${REPOSITORY}`;
const baselineFiles = { "server.mjs": "// initial code\n", "seed.json": '{"version":1,"items":[]}\n', "package.json": '{"private":true}\n' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shopping-demo-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["app/data", "demo/shopping-list", ".github", ".git"]) mkdirSync(join(root, path), { recursive: true });
  for (const [file, body] of Object.entries(baselineFiles)) writeFileSync(join(root, "app", file), body);
  writeFileSync(join(root, "app/data/items.json"), '{"user":"data"}');
  writeFileSync(join(root, ".github/preserve"), "workgraph configuration");
  writeFileSync(join(root, ".git/preserve"), "git metadata");
  writeFileSync(join(root, "README.md"), "repository docs");
  writeFileSync(join(root, "demo/shopping-list/backlog.json"),
    readFileSync(new URL("../demo/shopping-list/backlog.json", import.meta.url)));
  captureBaseline(root);
  ensureState(root);
  return root;
}

class FakeGitHub {
  issues = [];
  labels = new Set(["bug", "enhancement"]);
  children = new Map();
  writes = [];
  nextNumber = 1000;
  failCreateAt = null;
  failPatch = false;

  add(input = {}) {
    const number = this.nextNumber++;
    const issue = {
      number, node_id: `I_${number}`, html_url: `https://github.com/${REPOSITORY}/issues/${number}`,
      state: "open", title: "Unrelated issue", body: "Not a demo issue", labels: [], type: null, ...structuredClone(input),
    };
    this.issues.push(issue);
    return structuredClone(issue);
  }

  request(method, path, body) {
    const url = new URL(`https://api.github.com/${path}`);
    const route = url.pathname.slice(1);
    const paginated = (items) => structuredClone(items.slice(
      (Number(url.searchParams.get("page") ?? 1) - 1) * 100,
      Number(url.searchParams.get("page") ?? 1) * 100,
    ));
    if (method !== "GET") this.writes.push({ method, path, body: structuredClone(body) });
    if (route === `${base}/labels`) {
      if (method === "GET") return paginated([...this.labels].map((name) => ({ name })));
      this.labels.add(body.name);
      return { name: body.name };
    }
    if (route === `${base}/issues`) {
      if (method === "GET") {
        assert.equal(url.searchParams.get("state"), "all");
        const label = url.searchParams.get("labels");
        return paginated(this.issues.filter((issue) => issue.labels.includes(label)));
      }
      assert.equal(method, "POST");
      assert.equal(body.issue_type, undefined);
      assert.equal(body.type, undefined);
      const issue = this.add(body);
      if (this.failCreateAt === this.issues.length) {
        this.failCreateAt = null;
        throw new Error("Lost POST response");
      }
      return issue;
    }
    const match = new RegExp(`^${base}/issues/(\\d+)(?:/(.*))?$`).exec(route);
    if (!match) throw new Error(`Unexpected fake API route: ${method} ${path}`);
    const issue = this.issues.find((entry) => entry.number === Number(match[1]));
    assert.ok(issue);
    if (match[2] === "sub_issues") {
      assert.equal(method, "GET");
      return paginated((this.children.get(issue.number) ?? []).map((number) => this.issues.find((entry) => entry.number === number)));
    }
    if (method === "GET") return structuredClone(issue);
    if (method === "PATCH") {
      if (this.failPatch) {
        this.failPatch = false;
        throw new Error("Temporary PATCH failure");
      }
      Object.assign(issue, body);
    } else if (method === "DELETE" && match[2].startsWith("labels/")) {
      issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(match[2].slice(7)));
    } else throw new Error(`Unexpected fake mutation: ${method} ${path}`);
    return structuredClone(issue);
  }
}

function seed(root, api) {
  const state = createRun();
  seedRun(root, api, state, { create: true });
  return state;
}

function addTask(api, root, parent = root, owningRoot = root) {
  const protocol = (kind) => deriveWorkGraphProtocolId(kind, [`${api.nextNumber}`]);
  const child = api.add({
    type: { name: "WorkGraphTask" },
    body: formatRuntimeTask({
      taskId: protocol("task"), rootIssueId: owningRoot.node_id,
      workflowRunId: protocol("workflow-run"), workflowDefinitionId: "shopping-list",
      workflowDefinitionVersion: "v1", workflowDefinitionDigest: `sha256:${"1".repeat(64)}`,
      taskDefinitionId: protocol("task-definition"), taskKey: "implement", operation: "implement",
      resolvedInputs: {},
    }),
  });
  api.children.set(parent.number, [...(api.children.get(parent.number) ?? []), child.number]);
  return child;
}

test("portable code reset backs up new files and data without changing anything outside app", (t) => {
  const root = fixture(t);
  const baseline = loadBaseline(root);
  const appInode = statSync(join(root, "app")).ino;
  writeFileSync(join(root, "app/server.mjs"), "// fixed version\n");
  writeFileSync(join(root, "app/new-feature.mjs"), "// experimental feature\n");
  const saved = restoreCode(root, baseline, "reset-1");
  assert.equal(statSync(join(root, "app")).ino, appInode, "the user's shell must stay in the active app directory");
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), baselineFiles["server.mjs"]);
  assert.ok(!existsSync(join(root, "app/new-feature.mjs")));
  assert.ok(!existsSync(join(root, "app/data")));
  assert.equal(readFileSync(join(saved, "server.mjs"), "utf8"), "// fixed version\n");
  assert.equal(readFileSync(join(saved, "data/items.json"), "utf8"), '{"user":"data"}');
  assert.ok(existsSync(join(saved, "new-feature.mjs")));
  assert.equal(readFileSync(join(root, ".github/preserve"), "utf8"), "workgraph configuration");
  assert.equal(readFileSync(join(root, ".git/preserve"), "utf8"), "git metadata");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "repository docs");
  assert.equal(restoreCode(root, baseline, "reset-1"), saved);
  assert.throws(() => captureBaseline(root), /immutable/);
});

test("code reset resumes after contents were backed up but before replacement installation", (t) => {
  const root = fixture(t);
  const baseline = loadBaseline(root);
  const backup = statePath(root, "backups/interrupted");
  mkdirSync(join(backup, "replacement"), { recursive: true });
  for (const [file, body] of Object.entries(baseline.files)) writeFileSync(join(backup, "replacement", file), body);
  mkdirSync(join(backup, "app"));
  const entries = readdirSync(join(root, "app"));
  writeJson(join(backup, "receipt.json"), { baseline: baseline.sha256, phase: "installing", entries });
  for (const name of entries) renameSync(join(root, "app", name), join(backup, "app", name));
  const saved = restoreCode(root, baseline, "interrupted");
  assert.equal(saved, join(backup, "app"));
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), baselineFiles["server.mjs"]);
  assert.ok(existsSync(join(saved, "data/items.json")));
});

test("data-only reset preserves implementation and keeps a backup", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "app/server.mjs"), "changed code");
  const backup = restoreData(root, "data-reset");
  assert.ok(existsSync(join(backup, "items.json")));
  assert.ok(!existsSync(join(root, "app/data")));
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), "changed code");
  assert.equal(restoreData(root, "again"), null);
});

test("the actual portable baseline restores a runnable app and its three known defects", (t) => {
  const root = fixture(t);
  const baseline = loadBaseline(ROOT);
  writeFileSync(join(root, "demo/shopping-list/local.mjs"),
    readFileSync(new URL("../demo/shopping-list/local.mjs", import.meta.url)));
  restoreCode(root, baseline, "real-baseline");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const normal = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/app.test.mjs"], {
    cwd: join(root, "app"), env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(normal.status, 0, `${normal.stdout}\n${normal.stderr}\n${normal.error ?? ""}`);
  const bugs = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/known-bugs.mjs"], {
    cwd: join(root, "app"), env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(bugs.status, 1, bugs.stderr);
  assert.match(bugs.stdout, /# fail 3\b/);
  assert.match(bugs.stdout, /# pass 0\b/);
});

test("baseline tampering, path traversal, links, and nested Git metadata are refused", (t) => {
  const root = fixture(t);
  const path = join(root, "demo/shopping-list/baseline.json");
  const baseline = loadBaseline(root);
  writeJson(path, { ...baseline, sha256: "bad" });
  assert.throws(() => loadBaseline(root), /digest mismatch/);
  const files = { ...baseline.files, "../.github/preserve": "bad" };
  writeJson(path, { version: 1, files, sha256: digest(files) });
  assert.throws(() => loadBaseline(root), /Unsafe baseline/);
  symlinkSync(join(root, ".github"), join(root, "app/link"));
  assert.throws(() => restoreCode(root, baseline, "symlink"), /symbolic link/);
  rmSync(join(root, "app/link"));
  mkdirSync(join(root, "app/.git"));
  assert.throws(() => restoreCode(root, baseline, "nested-git"), /repository metadata/);
  assert.equal(readFileSync(join(root, ".github/preserve"), "utf8"), "workgraph configuration");
});

test("the app lock prevents concurrent reset and never kills a live process", (t) => {
  const root = fixture(t);
  const release = acquireLock(root, "shopping-list server");
  assert.throws(() => acquireLock(root, "reset"), /Stop the shopping-list server/);
  assert.throws(() => main(["reset-code", "--apply"], root), /locked/);
  assert.throws(() => unlock(root), /still running/);
  release();
  release();
  assert.ok(!existsSync(statePath(root, "operation.lock.json")));
});

test("seed preview is read-only; prepare creates labels and native-tool requests but no Issues", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  const state = createRun();
  const preview = seedRun(root, api, state, { save: false });
  assert.equal(preview.requests.length, 6);
  assert.equal(api.writes.length, 0);
  assert.ok(!existsSync(statePath(root, "current.json")));
  const prepared = seedRun(root, api, state);
  assert.equal(prepared.requests.length, 6);
  assert.equal(api.issues.length, 0);
  assert.ok(api.labels.has(DEMO_LABEL));
  assert.ok(runLabel(state.runId).length <= 50);
  for (const { key, ...request } of prepared.requests) {
    assert.ok(request.body.includes(marker(state.runId, key)));
    assert.ok(request.labels.every((label) => !label.startsWith("workgraph")));
    api.request("POST", `${base}/issues`, request);
  }
  const adopted = seedRun(root, api, readRun(root));
  assert.equal(adopted.requests.length, 0);
  assert.equal(Object.keys(adopted.issues).length, 6);
});

test("seed is idempotent, includes closed Issues, and recovers a lost create response", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  api.failCreateAt = 2;
  assert.throws(() => seed(root, api), /Lost POST response/);
  assert.equal(api.issues.length, 2);
  seedRun(root, api, readRun(root), { create: true });
  assert.equal(api.issues.length, 6);
  api.issues[0].state = "closed";
  seedRun(root, api, readRun(root), { create: true });
  assert.equal(api.issues.length, 6);
  assert.equal(api.issues[0].state, "closed");
});

test("ownership inventory paginates and does not adopt unrelated labeled Issues or PRs", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  const state = createRun();
  for (let i = 0; i < 100; i++) api.add({ labels: [runLabel(state.runId)] });
  const request = issueRequest(catalog(root)[0], state.runId);
  api.add({ ...request, pull_request: {} });
  seedRun(root, api, state, { create: true });
  assert.equal(Object.keys(state.issues).length, 6);
  assert.equal(api.issues.length, 107);
  assert.ok(api.issues.slice(0, 101).every((issue) => issue.state === "open"));
});

test("full reset closes only this run and verified tasks, then restores baseline and creates six fresh Issues", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  const unrelated = api.add();
  const state = seed(root, api);
  const owner = api.issues.find((issue) => issue.number === state.issues.B01);
  owner.labels.push("workgraph:example");
  const child = addTask(api, owner);
  addTask(api, owner, child);
  writeFileSync(join(root, "app/server.mjs"), "// fixed code\n");
  const writes = api.writes.length;
  const preview = resetExperiment(root, api);
  assert.equal(preview.closeRoots.length, 6);
  assert.equal(preview.closeTasks.length, 2);
  assert.equal(api.writes.length, writes);
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), "// fixed code\n");
  assert.throws(() => resetExperiment(root, api, { apply: true }), /--work-stopped/);
  assert.equal(api.writes.length, writes);
  const result = resetExperiment(root, api, { apply: true, workStopped: true });
  assert.notEqual(result.runId, state.runId);
  assert.equal(Object.keys(result.issues).length, 6);
  assert.equal(api.issues.find((issue) => issue.number === unrelated.number).state, "open");
  assert.equal(api.issues.filter((issue) => issue.state === "closed").length, 8);
  assert.ok(!owner.labels.includes("workgraph:example"));
  assert.ok(api.issues.filter((issue) => Object.values(result.issues).includes(issue.number)).every((issue) => issue.state === "open"));
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), baselineFiles["server.mjs"]);
  assert.equal(readFileSync(join(result.backup, "server.mjs"), "utf8"), "// fixed code\n");
  assert.ok(existsSync(statePath(root, `history-${state.runId}.json`)));
});

test("reset resumes closing failures without losing the chosen backup or next run ID", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  seed(root, api);
  writeFileSync(join(root, "app/server.mjs"), "work in progress");
  api.failPatch = true;
  assert.throws(() => resetExperiment(root, api, { apply: true }), /PATCH failure/);
  const pending = readRun(root).reset;
  assert.equal(readFileSync(join(root, "app/server.mjs"), "utf8"), "work in progress");
  const result = resetExperiment(root, api, { apply: true });
  assert.equal(result.runId, pending.nextRunId);
  assert.ok(result.backup.includes(pending.backup));
  assert.equal(api.issues.length, 12);
});

test("reset resumes partial new-run seeding instead of closing it or taking another backup", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  seed(root, api);
  api.failCreateAt = 8;
  assert.throws(() => resetExperiment(root, api, { apply: true }), /Lost POST response/);
  const pending = readRun(root);
  assert.ok(pending.resumeReset);
  const result = resetExperiment(root, api, { apply: true });
  assert.equal(result.runId, pending.runId);
  assert.equal(result.resuming, true);
  assert.equal(api.issues.length, 12);
  assert.equal(api.issues.filter((issue) => issue.state === "closed").length, 6);
  assert.equal(readdirSync(statePath(root, "backups")).length, 1);
  assert.ok(!readRun(root).resumeReset);
});

test("changed ownership, duplicate markers, and foreign journals refuse GitHub writes", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  const state = seed(root, api);
  const entries = catalog(root);
  const original = api.issues[0].body;
  api.issues[0].body = "No ownership marker";
  const writes = api.writes.length;
  assert.throws(() => resetExperiment(root, api, { apply: true }), /ownership/);
  assert.equal(api.writes.length, writes);
  api.issues[0].body = original;
  api.add(issueRequest(entries[0], state.runId));
  assert.throws(() => inventory(api, state, entries), /Duplicate B01/);
  assert.throws(() => inventory(api, { ...state, repository: "someone/else" }, entries), /Invalid experiment journal/);
});

test("unrelated or cross-root sub-issues block reset before any writes", (t) => {
  const root = fixture(t);
  const api = new FakeGitHub();
  const state = seed(root, api);
  const [owner, other] = api.issues;
  const unrelated = api.add();
  api.children.set(owner.number, [unrelated.number]);
  const writes = api.writes.length;
  assert.throws(() => resetExperiment(root, api, { apply: true, workStopped: true }), /not a verified WorkGraphTask/);
  assert.equal(api.writes.length, writes);
  api.children.delete(owner.number);
  addTask(api, owner, owner, other);
  assert.throws(() => resetInventory(api, state, catalog(root)), /not a verified WorkGraphTask/);
  assert.equal(api.writes.length, writes);
});

test("closing a run with activity requires explicit stopped-work confirmation", () => {
  const api = new FakeGitHub();
  const root = api.add({ labels: ["workgraph:example"] });
  assert.throws(() => closeRun(api, { roots: [root], tasks: [] }), /--work-stopped/);
  assert.equal(api.writes.length, 0);
});
