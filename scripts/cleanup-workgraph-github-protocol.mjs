#!/usr/bin/env node

import process from "node:process";

import {
  GitHubClient,
  cleanupRun,
  loadLiveConfig,
  validateRunMarker,
} from "../tests/support/workgraph-live-github.mjs";

try {
  const config = loadLiveConfig();
  const marker = validateRunMarker(
    process.env.WORKGRAPH_GITHUB_RUN_ID ?? "",
  );
  const actorIds = new Set(Object.values(config.roleIds));
  if (actorIds.size !== 1) {
    throw new Error(
      "cleanup requires every configured live-test role ID to match the token actor",
    );
  }
  const client = new GitHubClient(config.token);
  const viewer = await client.repositoryAndViewer();
  const [actorId] = actorIds;
  if (viewer.id !== actorId) {
    throw new Error("cleanup token identity does not match configured role IDs");
  }
  const cleaned = await cleanupRun(client, { marker, actorId });
  process.stdout.write(
    `${JSON.stringify({ marker, cleaned, openMarkerIssues: 0 })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
