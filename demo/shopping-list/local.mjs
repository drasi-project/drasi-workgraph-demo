import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPOSITORY = "drasi-project/drasi-workgraph-demo";
export const DEMO_LABEL = "demo:shopping-list";
export const statePath = (root, name) => join(root, ".shopping-demo", name);
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const newId = () => `${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;

function directory(path) {
  if (!existsSync(path)) mkdirSync(path);
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Expected a real directory, not a link: ${path}`);
  }
}

export function ensureState(root) {
  directory(statePath(root, ""));
}

export function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid PID in the demo lock; inspect it manually.");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

export function acquireLock(root, operation) {
  ensureState(root);
  const path = statePath(root, "operation.lock.json");
  const token = randomUUID();
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, operation, token }), {
      flag: "wx", mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = readJson(path);
    const advice = processExists(owner.pid)
      ? "Stop the shopping-list server or wait for the other demo command to finish."
      : "The owner has exited. Run node scripts/shopping-demo.mjs unlock --apply.";
    throw new Error(`Demo is locked by ${owner.operation} (PID ${owner.pid}). ${advice}`);
  }
  let released = false;
  return () => {
    if (released) return;
    if (readJson(path).token !== token) throw new Error("Demo lock ownership changed; refusing to remove it.");
    unlinkSync(path);
    released = true;
  };
}

export function unlock(root) {
  const path = statePath(root, "operation.lock.json");
  if (!existsSync(path)) throw new Error("There is no demo lock to remove.");
  if (processExists(readJson(path).pid)) throw new Error("The lock owner is still running. Stop it normally; no process will be killed.");
  unlinkSync(path);
}

function filesIn(path, prefix = "") {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.isSymbolicLink()) {
      throw new Error(`Refusing to capture or reset repository metadata or a symbolic link: ${join(path, entry.name)}`);
    }
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesIn(join(path, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Not a regular app file: ${relative}`);
  }
  return files;
}

export function captureBaseline(root) {
  const path = join(root, "demo/shopping-list/baseline.json");
  if (existsSync(path)) throw new Error("The baseline already exists. It is intentionally immutable.");
  const app = join(root, "app");
  const files = Object.fromEntries(filesIn(app)
    .filter((file) => !file.startsWith("data/"))
    .map((file) => [file, readFileSync(join(app, file), "utf8")]));
  if (JSON.stringify(files).length > 500_000) throw new Error("The app is too large for a practice baseline; check for generated files.");
  writeFileSync(path, `${JSON.stringify({ version: 1, sha256: digest(files), files }, null, 2)}\n`, { flag: "wx" });
  return path;
}

export function loadBaseline(root) {
  const baseline = readJson(join(root, "demo/shopping-list/baseline.json"));
  if (baseline.version !== 1 || !baseline.files || Array.isArray(baseline.files) || digest(baseline.files) !== baseline.sha256) {
    throw new Error("Invalid baseline or digest mismatch. Nothing will be reset.");
  }
  for (const [path, content] of Object.entries(baseline.files)) {
    if (
      !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => ["", ".", "..", ".git", "data"].includes(part)) ||
      typeof content !== "string"
    ) throw new Error(`Unsafe baseline path or content: ${path}`);
  }
  for (const required of ["server.mjs", "seed.json", "package.json"]) {
    if (!(required in baseline.files)) throw new Error(`Baseline is missing ${required}.`);
  }
  return baseline;
}

function backupDirectory(root, id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid backup ID.");
  ensureState(root);
  directory(statePath(root, "backups"));
  const path = statePath(root, `backups/${id}`);
  directory(path);
  return path;
}

export function checkApp(root) {
  const app = join(root, "app");
  if (lstatSync(app).isSymbolicLink() || !lstatSync(app).isDirectory()) throw new Error("app/ must be a real directory.");
  filesIn(app);
}

export function restoreCode(root, baseline, id) {
  const backup = backupDirectory(root, id);
  const app = join(root, "app");
  const saved = join(backup, "app");
  const stage = join(backup, "replacement");
  const receipt = join(backup, "receipt.json");
  let journal = existsSync(receipt) ? readJson(receipt) : null;
  if (journal && journal.baseline !== baseline.sha256) {
    throw new Error("The pending restore used a different baseline. Inspect the backup before proceeding.");
  }
  if (journal?.phase === "done") return saved;
  checkApp(root);
  if (!journal) {
    journal = { baseline: baseline.sha256, id, phase: "preparing", entries: readdirSync(app) };
    writeJson(receipt, journal);
  }
  if (
    !["preparing", "saving", "installing"].includes(journal.phase) ||
    !Array.isArray(journal.entries) ||
    journal.entries.some((name) => !name || /[/\\]/.test(name) || [".", "..", ".git"].includes(name))
  ) throw new Error("Invalid restore journal. Inspect the backup before proceeding.");
  directory(saved);
  directory(stage);
  filesIn(saved);
  filesIn(stage);
  if (journal.phase === "preparing") {
    for (const [file, content] of Object.entries(baseline.files)) {
      const target = join(stage, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    journal.phase = "saving";
    writeJson(receipt, journal);
  }
  // Keep app/ itself in place so a shell running "npm run reset:code" stays in app/.
  if (journal.phase === "saving") {
    if (readdirSync(app).some((name) => !journal.entries.includes(name))) {
      throw new Error("New app files appeared during reset. Stop other editors before resuming.");
    }
    for (const name of journal.entries) {
      const source = join(app, name);
      const target = join(saved, name);
      if (existsSync(source) && !existsSync(target)) renameSync(source, target);
      else if (existsSync(source) || !existsSync(target)) {
        throw new Error(`Ambiguous interrupted backup of ${name}; previous files are preserved in ${saved}.`);
      }
    }
    journal.phase = "installing";
    writeJson(receipt, journal);
  }
  for (const name of new Set(Object.keys(baseline.files).map((file) => file.split("/")[0]))) {
    const source = join(stage, name);
    const target = join(app, name);
    if (existsSync(source) && !existsSync(target)) renameSync(source, target);
    else if (existsSync(source) || !existsSync(target)) {
      throw new Error(`Ambiguous interrupted restore of ${name}; previous files are preserved in ${saved}.`);
    }
  }
  const restored = Object.fromEntries(filesIn(app).map((file) => [file, readFileSync(join(app, file), "utf8")]));
  if (
    Object.keys(restored).length !== Object.keys(baseline.files).length ||
    Object.entries(baseline.files).some(([file, content]) => restored[file] !== content)
  ) throw new Error("App contents changed during restore. The previous version is still in the backup.");
  journal.phase = "done";
  writeJson(receipt, journal);
  rmdirSync(stage);
  return saved;
}

export function restoreData(root, id) {
  checkApp(root);
  const data = join(root, "app/data");
  if (!existsSync(data)) return null;
  const target = join(backupDirectory(root, id), "data");
  renameSync(data, target);
  return target;
}
