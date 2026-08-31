import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = resolve(root, "..", "drasi-dogfooding", "git-workgraph", "plugins");
const workflow = resolve(
  root,
  ".github/workgraph/workflows/issue-lifecycle.yaml",
);
const fixture = resolve(
  root,
  ".github/workgraph/fixtures/v1/issue-lifecycle.expected.json",
);

if (!existsSync(resolve(plugins, "workgraph-kernel/Cargo.toml"))) {
  console.log("SKIP: sibling workgraph-compile is unavailable");
  process.exit(0);
}

const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "workgraph-kernel",
    "--bin",
    "workgraph-compile",
    "--",
    workflow,
  ],
  { cwd: plugins, encoding: "utf8" },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (process.argv.includes("--write")) {
  writeFileSync(fixture, result.stdout);
  writeFileSync(
    resolve(root, ".github/workgraph/workflows/issue-lifecycle-v1.body"),
    JSON.parse(result.stdout).canonicalDefinitionBody,
  );
}

assert.deepEqual(
  JSON.parse(result.stdout),
  JSON.parse(readFileSync(fixture, "utf8")),
  "Demo compiler fixture is stale",
);
console.log("PASS: sibling workgraph-compile output matches Demo fixture exactly");
