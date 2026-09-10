import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseRuntimeTask } from "../../.github/mcp/workgraph-v1-definition.mjs";
import { DEMO_LABEL, REPOSITORY, newId, readJson, statePath, writeJson } from "./local.mjs";

const base = `repos/${REPOSITORY}`;
export const runLabel = (id) => `demo:shop:${id.slice(11)}`;
export const marker = (id, key) => `<!-- shopping-list-demo:v1 run=${id} key=${key} -->`;
const labelsOf = (issue) => issue.labels.map((label) => typeof label === "string" ? label : label.name);

export function githubClient(root) {
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
  if (![
    `https://github.com/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`,
    `git@github.com:${REPOSITORY}.git`,
  ].includes(origin)) throw new Error(`Refusing GitHub operations: origin is not ${REPOSITORY}.`);
  return {
    request(method, path, body) {
      const args = ["api", "--hostname", "github.com", "--method", method, path,
        "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
      if (body !== undefined) args.push("--input", "-");
      const output = execFileSync("gh", args, {
        cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
        input: body === undefined ? undefined : JSON.stringify(body),
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim() ? JSON.parse(output) : null;
    },
  };
}

function pages(api, path) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const batch = api.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub returned an unexpected response for ${path}.`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error("Too many GitHub results; refusing an incomplete ownership inventory.");
}

export function catalog(root) {
  const entries = readJson(join(root, "demo/shopping-list/backlog.json"));
  if (
    !Array.isArray(entries) || entries.length !== 6 ||
    new Set(entries.map((entry) => entry.key)).size !== 6 ||
    entries.some((entry) => !/^[BF]0[1-3]$/.test(entry.key) ||
      !["bug", "enhancement"].includes(entry.kind) || !entry.title || !entry.body)
  ) throw new Error("Invalid shopping-list backlog.");
  return entries;
}

export function issueRequest(entry, id) {
  return {
    title: `[Shopping List ${id.slice(0, 18)}] ${entry.key}: ${entry.title}`,
    body: `${entry.body}\n\n## Development context\n\nWork in \`app/\` in \`${REPOSITORY}\`. Read \`app/AGENTS.md\` and \`app/README.md\`. Run locally with \`cd app && npm start\`; no install or database is needed. The practice baseline contains intentional defects; fix only this issue.\n\nThis is an ordinary Root Issue, not a WorkGraphTask. It is inactive until a human adds an explicitly configured WorkGraph selector label. Do not change its title or body after admission.\n\nExperiment: \`${id}\`.\n\n${marker(id, entry.key)}\n`,
    labels: [DEMO_LABEL, runLabel(id), entry.kind],
  };
}

function validateRun(state) {
  if (
    state.version !== 1 || state.repository !== REPOSITORY ||
    !/^\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}$/.test(state.runId) ||
    !state.issues || Array.isArray(state.issues)
  ) throw new Error("Invalid experiment journal. Refusing to touch GitHub.");
  if (Object.entries(state.issues).some(([key, number]) =>
    !/^[BF]0[1-3]$/.test(key) || !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error("Invalid issue ownership records.");
  }
  if (state.reset && (
    !/^\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}$/.test(state.reset.nextRunId) ||
    !/^\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}$/.test(state.reset.backup)
  )) throw new Error("Invalid pending reset journal.");
  return state;
}

export function readRun(root) {
  const path = statePath(root, "current.json");
  return existsSync(path) ? validateRun(readJson(path)) : null;
}

export function createRun(id = newId()) {
  return { version: 1, repository: REPOSITORY, runId: id, issues: {} };
}

function ownedRoot(issue, state, key) {
  const labels = labelsOf(issue);
  if (
    issue.pull_request || issue.type?.name === "WorkGraphTask" ||
    issue.html_url !== `https://github.com/${REPOSITORY}/issues/${issue.number}` ||
    !issue.body?.includes(marker(state.runId, key)) ||
    !labels.includes(DEMO_LABEL) || !labels.includes(runLabel(state.runId))
  ) throw new Error(`Issue #${issue.number} no longer proves ownership of ${key}. Nothing unrelated will be closed.`);
  return issue;
}

export function inventory(api, state, entries) {
  validateRun(state);
  const candidates = pages(api, `${base}/issues?state=all&labels=${encodeURIComponent(runLabel(state.runId))}`)
    .filter((issue) => !issue.pull_request);
  const roots = new Map();
  for (const entry of entries) {
    const matches = candidates.filter((issue) => issue.body?.includes(marker(state.runId, entry.key)));
    const recorded = state.issues[entry.key];
    if (recorded && !matches.some((issue) => issue.number === recorded)) {
      matches.push(api.request("GET", `${base}/issues/${recorded}`));
    }
    if (matches.length > 1) throw new Error(`Duplicate ${entry.key} issues in this run. Resolve them manually before retrying.`);
    if (matches.length) {
      const issue = ownedRoot(matches[0], state, entry.key);
      if (recorded && recorded !== issue.number) throw new Error(`The recorded ${entry.key} issue changed.`);
      roots.set(entry.key, issue);
    } else if (recorded) throw new Error(`Recorded issue #${recorded} was not found.`);
  }
  return roots;
}

function ensureLabels(api, state) {
  const existing = new Set(pages(api, `${base}/labels`).map((label) => label.name));
  for (const [name, color] of [[DEMO_LABEL, "367e60"], [runLabel(state.runId), "d5dec9"], ["bug", "d73a4a"], ["enhancement", "a2eeef"]]) {
    if (!existing.has(name)) api.request("POST", `${base}/labels`, { name, color });
  }
}

export function seedRun(root, api, state, { create = false, save = true } = {}) {
  if (create && !save) throw new Error("Issue creation requires a durable journal.");
  const entries = catalog(root);
  const roots = inventory(api, state, entries);
  for (const [key, issue] of roots) state.issues[key] = issue.number;
  if (save) {
    writeJson(statePath(root, "current.json"), state);
    ensureLabels(api, state);
  }
  const requests = [];
  for (const entry of entries) {
    if (roots.has(entry.key)) continue;
    const request = issueRequest(entry, state.runId);
    requests.push({ key: entry.key, ...request });
    if (create) {
      // The marker allows a retry to adopt a successful POST even if its response was lost.
      const issue = ownedRoot(api.request("POST", `${base}/issues`, request), state, entry.key);
      state.issues[entry.key] = issue.number;
      writeJson(statePath(root, "current.json"), state);
    }
  }
  if (save && Object.keys(state.issues).length === entries.length) {
    delete state.resumeReset;
    writeJson(statePath(root, "current.json"), state);
  }
  return { runId: state.runId, issues: state.issues, requests };
}

export function resetInventory(api, state, entries) {
  const roots = inventory(api, state, entries);
  const tasks = [];
  const seen = new Set([...roots.values()].map((issue) => issue.number));
  for (const root of roots.values()) {
    const pending = [root];
    while (pending.length) {
      const parent = pending.shift();
      const children = pages(api, `${base}/issues/${parent.number}/sub_issues`);
      for (const child of children) {
        if (seen.has(child.number)) throw new Error("Duplicate or cyclic sub-issue ancestry; refusing reset.");
        seen.add(child.number);
        if (seen.size > 500) throw new Error("Too many descendant issues for a tiny demo; refusing reset.");
        if (
          child.pull_request || child.type?.name !== "WorkGraphTask" ||
          child.html_url !== `https://github.com/${REPOSITORY}/issues/${child.number}` ||
          parseRuntimeTask(child.body).rootIssueId !== root.node_id
        ) throw new Error(`Sub-issue #${child.number} is not a verified WorkGraphTask for root #${root.number}. Detach unrelated sub-issues manually.`);
        tasks.push(child);
        pending.push(child);
      }
    }
  }
  return { roots: [...roots.values()], tasks };
}

export function closeRun(api, plan, { workStopped = false } = {}) {
  const active = plan.tasks.length > 0 || plan.roots.some((root) => labelsOf(root).some((label) => label.startsWith("workgraph:")));
  if (active && !workStopped) {
    throw new Error("WorkGraph activity exists. Finish or stop its runtime and cloud work, then retry with --work-stopped. No processes or PRs will be stopped for you.");
  }
  for (const root of plan.roots) {
    for (const label of labelsOf(root).filter((name) => name.startsWith("workgraph:"))) {
      api.request("DELETE", `${base}/issues/${root.number}/labels/${encodeURIComponent(label)}`);
    }
    if (root.state === "open") api.request("PATCH", `${base}/issues/${root.number}`, { state: "closed", state_reason: "not_planned" });
  }
  for (const task of [...plan.tasks].reverse()) {
    if (task.state === "open") api.request("PATCH", `${base}/issues/${task.number}`, { state: "closed", state_reason: "not_planned" });
  }
}
