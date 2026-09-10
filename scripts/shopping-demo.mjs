import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROOT, REPOSITORY, acquireLock, captureBaseline, checkApp, ensureState, loadBaseline,
  newId, readJson, restoreCode, restoreData, statePath, unlock, writeJson,
} from "../demo/shopping-list/local.mjs";
import {
  catalog, closeRun, createRun, githubClient, readRun, resetInventory, seedRun,
} from "../demo/shopping-list/github.mjs";

export function resetExperiment(root, api, { apply = false, workStopped = false, create = true } = {}) {
  const baseline = loadBaseline(root);
  const state = readRun(root);
  if (!state) throw new Error("No recorded experiment. Use seed first, or reset-code for a local-only reset.");
  if (state.resumeReset) {
    const backup = state.resumeReset.backup;
    return { resuming: true, backup, ...seedRun(root, api, state, { create: apply && create, save: apply }) };
  }
  if (existsSync(join(root, "app")) || !state.reset?.backup) checkApp(root);
  const entries = catalog(root);
  const plan = resetInventory(api, state, entries);
  if (!apply) return {
    dryRun: true,
    repository: REPOSITORY,
    closeRoots: plan.roots.map((issue) => issue.number),
    closeTasks: plan.tasks.map((issue) => issue.number),
    restore: "app/ only, including data; old app moves to .shopping-demo/backups/",
    create: entries.map((entry) => entry.key),
    workStoppedRequired: plan.tasks.length > 0 || plan.roots.some((issue) =>
      issue.labels.some((label) => (typeof label === "string" ? label : label.name).startsWith("workgraph:"))),
  };
  if (!state.reset) {
    state.reset = { nextRunId: newId(), backup: newId() };
    writeJson(statePath(root, "current.json"), state);
  }
  closeRun(api, plan, { workStopped });
  const backup = restoreCode(root, baseline, state.reset.backup);
  const next = createRun(state.reset.nextRunId);
  next.resumeReset = { previousRunId: state.runId, backup };
  // Archive before advancing the pointer; repeats use the same next-run marker.
  writeJson(statePath(root, `history-${state.runId}.json`), { ...state, backup });
  writeJson(statePath(root, "current.json"), next);
  const seeded = seedRun(root, api, next, { create });
  return { backup, ...seeded };
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const [command = "help", ...flags] = argv;
  const allowedFlags = new Set(["--apply", "--prepare", "--work-stopped"]);
  if (flags.some((flag) => !allowedFlags.has(flag))) throw new Error("Unknown option. Run node scripts/shopping-demo.mjs help.");
  const apply = flags.includes("--apply");
  const prepare = flags.includes("--prepare");
  const workStopped = flags.includes("--work-stopped");
  if (prepare && (command !== "seed" || apply)) throw new Error("--prepare is for seed only; do not combine it with --apply.");
  if (workStopped && command !== "reset") throw new Error("--work-stopped is for reset only.");
  if (command === "help") {
    console.log(`Shopping List experiment commands (run from the repository root):
  node scripts/shopping-demo.mjs status
  node scripts/shopping-demo.mjs seed             Preview missing baseline issues
  node scripts/shopping-demo.mjs seed --apply     Create missing issues (requires gh)
  node scripts/shopping-demo.mjs reset            Preview a complete experiment reset
  node scripts/shopping-demo.mjs reset --apply    Back up app, close old owned issues, seed new ones
  node scripts/shopping-demo.mjs reset-code --apply  Restore only app code/data; no GitHub calls
  node scripts/shopping-demo.mjs reset-data --apply  Restore only sample data; no GitHub calls
  node scripts/shopping-demo.mjs unlock --apply   Remove a lock ONLY if its process has exited

All resets require a stopped shopping-list server. WorkGraph runs also require
--work-stopped after you have finished/stopped runtime and cloud work.
No command resets Git, pushes, deletes issues, closes PRs, or changes other repos.
After a partial failure, repeat the same command to resume, not start over.`);
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify({
      repository: REPOSITORY, baseline: loadBaseline(root).sha256, experiment: readRun(root),
      lock: existsSync(statePath(root, "operation.lock.json")) ? readJson(statePath(root, "operation.lock.json")) : null,
    }, null, 2));
    return;
  }
  if (command === "unlock") {
    if (!apply) throw new Error("Removing a stale lock requires --apply.");
    unlock(root);
    console.log("Removed the stale demo lock. No process was stopped.");
    return;
  }
  if (!["baseline", "seed", "reset", "reset-code", "reset-data"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const changing = apply || prepare || command === "baseline";
  const release = changing ? acquireLock(root, command) : () => {};
  try {
    if (command === "baseline") {
      console.log(captureBaseline(root));
    } else if (command === "seed") {
      loadBaseline(root);
      const api = githubClient(root);
      const state = readRun(root) ?? createRun();
      if (state.reset) throw new Error("An interrupted reset is pending. Rerun reset --apply with the same safety flags.");
      const result = seedRun(root, api, state, { create: apply, save: changing });
      if (prepare) writeJson(statePath(root, "issue-requests.json"), result);
      console.log(JSON.stringify({ dryRun: !changing, ...result }, null, 2));
    } else if (command === "reset") {
      console.log(JSON.stringify(resetExperiment(root, githubClient(root), { apply, workStopped }), null, 2));
    } else if (!apply) {
      if (command === "reset-code") loadBaseline(root);
      console.log(`Preview: ${command === "reset-code" ? "restore app/ code and data from the baseline" : "restore sample data only"}. Back up first; no Git or GitHub changes. Stop the app and add --apply.`);
    } else if (command === "reset-code") {
      ensureState(root);
      const pending = statePath(root, "pending-code.json");
      const id = existsSync(pending) ? readJson(pending).id : newId();
      writeJson(pending, { id });
      const backup = restoreCode(root, loadBaseline(root), id);
      unlinkSync(pending);
      console.log(`Restored app/ code and sample data. Previous app: ${backup}\nGit branch, index, history, and GitHub Issues are unchanged.`);
    } else {
      const backup = restoreData(root, newId());
      console.log(backup ? `Previous data: ${backup}\nThe next start loads the sample list.` : "No saved data yet. The next start loads the sample list.");
    }
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Shopping demo: ${error.message}`);
    if (error.stderr) console.error(error.stderr.toString().trim());
    process.exitCode = 1;
  }
}
