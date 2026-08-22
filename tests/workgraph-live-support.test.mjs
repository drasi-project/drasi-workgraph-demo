import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_REPOSITORY,
  GitHubClient,
  TASK_BODY,
  childTitle,
  cleanupRun,
  loadLiveConfig,
  makeRunMarker,
  parentBody,
  parentTitle,
  selectCleanupIssues,
} from "./support/workgraph-live-github.mjs";

const MARKER =
  "wg-protocol-it/20260822T180000Z/123e4567-e89b-12d3-a456-426614174000";
const ACTOR_ID = 42;
const REPOSITORY_URL =
  "https://api.github.com/repos/drasi-project/drasi-workgraph-demo";

function issue(kind, overrides = {}) {
  const parent = kind === "parent";
  return {
    id: parent ? 101 : 102,
    number: parent ? 11 : 12,
    node_id: parent ? "I_parent" : "I_child",
    title: parent ? parentTitle(MARKER) : childTitle(MARKER),
    body: parent ? parentBody(MARKER) : TASK_BODY,
    state: "open",
    repository_url: REPOSITORY_URL,
    user: { id: ACTOR_ID },
    ...overrides,
  };
}

test("live configuration refuses absent opt-in and non-demo repositories", () => {
  assert.throws(() => loadLiveConfig({}), /WORKGRAPH_GITHUB_INTEGRATION=1/);
  assert.throws(
    () =>
      loadLiveConfig({
        WORKGRAPH_GITHUB_INTEGRATION: "1",
        WORKGRAPH_GITHUB_REPOSITORY: "example/other",
      }),
    new RegExp(FIXED_REPOSITORY),
  );
});

test("cleanup selection is exact-marker scoped and rejects foreign matches", () => {
  const unrelated = issue("parent", {
    number: 99,
    title: "[another-run] parent",
  });
  assert.deepEqual(
    selectCleanupIssues(
      [unrelated, issue("child"), issue("parent")],
      MARKER,
      ACTOR_ID,
    ).map((entry) => entry.kind),
    ["child", "parent"],
  );
  assert.throws(
    () =>
      selectCleanupIssues(
        [issue("parent", { user: { id: 999 } })],
        MARKER,
        ACTOR_ID,
      ),
    /refusing cleanup/,
  );
  assert.throws(
    () =>
      selectCleanupIssues(
        [issue("child", { body: "not canonical" })],
        MARKER,
        ACTOR_ID,
      ),
    /refusing cleanup/,
  );
});

test("comment pagination combines pages and stops after the final short page", async () => {
  const calls = [];
  const client = Object.create(GitHubClient.prototype);
  client.rest = async (method, route) => {
    calls.push({ method, route });
    if (route.endsWith("page=1")) {
      return Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
    }
    if (route.endsWith("page=2")) {
      return [{ id: 101 }, { id: 102 }];
    }
    throw new Error(`unexpected pagination request: ${route}`);
  };
  const comments = await client.comments(17);
  assert.equal(comments.length, 102);
  assert.deepEqual(
    comments.map((comment) => comment.id),
    Array.from({ length: 102 }, (_, index) => index + 1),
  );
  assert.deepEqual(calls, [
    {
      method: "GET",
      route:
        "/repos/drasi-project/drasi-workgraph-demo/issues/17/comments?per_page=100&page=1",
    },
    {
      method: "GET",
      route:
        "/repos/drasi-project/drasi-workgraph-demo/issues/17/comments?per_page=100&page=2",
    },
  ]);
});

test("cleanup closes child before parent and verifies zero marker matches", async () => {
  const parent = issue("parent");
  const child = issue("child");
  const state = new Map([
    [parent.number, structuredClone(parent)],
    [child.number, structuredClone(child)],
  ]);
  const closes = [];
  const client = {
    async issue(number) {
      return structuredClone(state.get(number));
    },
    async openIssues() {
      return [...state.values()]
        .filter((item) => item.state === "open")
        .map((item) => structuredClone(item));
    },
    async parent() {
      return structuredClone(parent);
    },
    async closeIssue(number) {
      closes.push(number);
      state.get(number).state = "closed";
      return structuredClone(state.get(number));
    },
  };
  const cleaned = await cleanupRun(client, {
    marker: MARKER,
    actorId: ACTOR_ID,
    tracked: [
      { kind: "parent", number: parent.number },
      { kind: "child", number: child.number },
    ],
  });
  assert.deepEqual(closes, [child.number, parent.number]);
  assert.deepEqual(
    cleaned.sort((left, right) => left.number - right.number),
    [
      { kind: "parent", number: parent.number },
      { kind: "child", number: child.number },
    ],
  );
});

test("cleanup refuses a marker child attached to an unrelated parent", async () => {
  const child = issue("child");
  const unrelatedParent = issue("parent", {
    number: 77,
    node_id: "I_unrelated",
    title: "Unrelated parent",
    body: "Unrelated body",
  });
  const closes = [];
  const client = {
    async issue(number) {
      return structuredClone(
        number === child.number ? child : unrelatedParent,
      );
    },
    async openIssues() {
      return [structuredClone(child)];
    },
    async parent() {
      return structuredClone(unrelatedParent);
    },
    async closeIssue(number) {
      closes.push(number);
    },
  };
  await assert.rejects(
    cleanupRun(client, {
      marker: MARKER,
      actorId: ACTOR_ID,
      tracked: [{ kind: "child", number: child.number }],
    }),
    /native parent is not the run parent/,
  );
  assert.deepEqual(closes, []);
});

test("cleanup attempts the parent after a child close failure and reports both state checks", async () => {
  const parent = issue("parent");
  const child = issue("child");
  const state = new Map([
    [parent.number, structuredClone(parent)],
    [child.number, structuredClone(child)],
  ]);
  const closes = [];
  const client = {
    async issue(number) {
      return structuredClone(state.get(number));
    },
    async openIssues() {
      return [...state.values()]
        .filter((item) => item.state === "open")
        .map((item) => structuredClone(item));
    },
    async parent() {
      return structuredClone(parent);
    },
    async closeIssue(number) {
      closes.push(number);
      if (number === child.number) throw new Error("simulated close failure");
      state.get(number).state = "closed";
    },
  };
  await assert.rejects(
    cleanupRun(client, {
      marker: MARKER,
      actorId: ACTOR_ID,
      tracked: [
        { kind: "parent", number: parent.number },
        { kind: "child", number: child.number },
      ],
    }),
    /cleanup failed/,
  );
  assert.deepEqual(closes, [child.number, parent.number]);
  assert.equal(state.get(parent.number).state, "closed");
  assert.equal(state.get(child.number).state, "open");
});

test("run markers are unique, canonical, and non-secret", () => {
  const marker = makeRunMarker(
    new Date("2026-08-22T18:00:00Z"),
    "123e4567-e89b-12d3-a456-426614174000",
  );
  assert.equal(marker, MARKER);
});
