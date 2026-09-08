import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredPlugins = process.env.WORKGRAPH_PLUGINS_DIR;
if (!configuredPlugins) {
  throw new Error(
    "WORKGRAPH_PLUGINS_DIR must point to the canonical WorkGraph plugins workspace",
  );
}
const plugins = resolve(root, configuredPlugins);
const targets = [
  "issue-lifecycle",
  "fork-join-lifecycle",
  "mixed-control-flow",
  "scoped-control-flow",
  "human-parity",
  "assigner-parity",
  "human-assigner-live",
  "drasi-server-issue",
].map((name) => ({
  name,
  workflow: resolve(root, `.github/workgraph/workflows/${name}.yaml`),
  fixture: resolve(
    root,
    `.github/workgraph/fixtures/v1/${name}.expected.json`,
  ),
  body: resolve(root, `.github/workgraph/workflows/${name}-v1.body`),
}));

function validateExplicitWorkers(definition) {
  const validateTask = (task, context) => {
    const keys =
      task.worker && typeof task.worker === "object" && !Array.isArray(task.worker)
        ? Object.keys(task.worker).sort()
        : [];
    if (JSON.stringify(keys) !== JSON.stringify(["candidates", "selection"])) {
      throw new Error(`${context}.worker must be an explicit candidate set`);
    }
    for (const [id, child] of Object.entries(task.children?.tasks ?? {})) {
      validateTask(child, `${context}.children.tasks.${id}`);
    }
  };
  for (const [id, step] of Object.entries(definition.spec.steps)) {
    if (step.type === "task") validateTask(step, `workflow step '${id}'`);
  }
}

if (!existsSync(resolve(plugins, "workgraph-kernel/Cargo.toml"))) {
  throw new Error(
    `WORKGRAPH_PLUGINS_DIR does not contain workgraph-kernel: ${plugins}`,
  );
}

assert.equal(
  readFileSync(
    resolve(root, ".github/workgraph/contracts/runtime-v1.json"),
    "utf8",
  ),
  readFileSync(resolve(plugins, "..", "contract/runtime-v1.json"), "utf8"),
  "vendored runtime-v1 contract differs from the canonical WorkGraph contract",
);

for (const target of targets) {
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
      target.workflow,
    ],
    { cwd: plugins, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const output = JSON.parse(result.stdout);
  validateExplicitWorkers(output.definition);

  if (process.argv.includes("--write")) {
    writeFileSync(target.fixture, result.stdout);
    writeFileSync(target.body, output.canonicalDefinitionBody);
  }

  assert.deepEqual(
    output,
    JSON.parse(readFileSync(target.fixture, "utf8")),
    `${target.name} compiler fixture is stale`,
  );
}
console.log(
  `PASS: canonical WorkGraph artifacts match the vendored contract and ${targets.length} Demo fixtures`,
);
