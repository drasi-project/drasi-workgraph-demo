import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import test from "node:test";
import { createStore, selectItems } from "../list.mjs";
import { fixture } from "./helpers.mjs";

test("serves the app and seeds six items without exposing data or repository files", async (t) => {
  const { request } = await fixture(t);
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Your next shop/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const asset of ["/app.js", "/summary.mjs", "/styles.css"]) {
    assert.equal((await request(asset)).status, 200);
  }
  for (const path of ["/data/items.json", "/.env", "/.github/mcp/workgraph-reporter.mjs", "/server.mjs"]) {
    assert.equal((await request(path)).status, 404);
  }
  const data = await (await request("/api/items")).json();
  assert.equal(data.items.length, 6);
  assert.equal(data.total, 6);
  assert.equal(data.bought, 2);
  assert.deepEqual(await (await request("/api/health")).json(), { status: "ok" });
});

test("add, buy, unbuy, and delete persist to the JSON file", async (t) => {
  const { request, dataFile } = await fixture(t);
  const response = await request("/api/items", "POST", { name: "  Strawberries  ", quantity: 2 });
  assert.equal(response.status, 201);
  const item = await response.json();
  assert.equal(item.name, "Strawberries");
  assert.equal(item.bought, false);
  assert.equal((await request(`/api/items/${item.id}`, "PATCH", { bought: true })).status, 200);
  const reopened = createStore(dataFile);
  assert.deepEqual(reopened.read().find((entry) => entry.id === item.id), { ...item, bought: true });
  assert.equal((await request(`/api/items/${item.id}`, "PATCH", { bought: false })).status, 200);
  assert.equal(reopened.read().find((entry) => entry.id === item.id).bought, false);
  assert.equal((await request(`/api/items/${item.id}`, "DELETE")).status, 204);
  assert.equal(reopened.read().some((entry) => entry.id === item.id), false);
  assert.equal((await request(`/api/items/${item.id}`, "DELETE")).status, 404);
  assert.equal((await request(`/api/items/${item.id}`, "PATCH", { bought: true })).status, 404);
});

test("rejects invalid names, quantities, and fields without modifying data", async (t) => {
  const { request, dataFile } = await fixture(t);
  const before = readFileSync(dataFile, "utf8");
  for (const body of [
    null, [], { name: " " }, { name: "a".repeat(81) },
    ...[0, -1, 100, 1.5, "2", null].map((quantity) => ({ name: "Milk", quantity })),
    { name: "Milk", bought: true },
  ]) assert.equal((await request("/api/items", "POST", body)).status, 400);
  for (const body of [null, [], { bought: "true" }, { name: "Changed" }, { bought: true, quantity: 9 }]) {
    assert.equal((await request("/api/items/milk", "PATCH", body)).status, 400);
  }
  assert.equal(readFileSync(dataFile, "utf8"), before);
});

test("validates JSON, content type, size, origin, and host", async (t) => {
  const { origin, dataFile } = await fixture(t);
  const before = readFileSync(dataFile, "utf8");
  for (const [headers, body, expected] of [
    [{ "Content-Type": "text/plain" }, '{"name":"Test"}', 400],
    [{ "Content-Type": "application/json" }, "{", 400],
    [{ "Content-Type": "application/json" }, JSON.stringify({ name: "a".repeat(5000) }), 400],
    [{ "Content-Type": "application/json", Origin: "https://example.com" }, '{"name":"Test"}', 403],
  ]) {
    const response = await fetch(`${origin}/api/items`, { method: "POST", headers, body });
    assert.equal(response.status, expected);
    assert.equal(typeof (await response.json()).error, "string");
  }
  const badHostStatus = await new Promise((resolve, reject) => {
    get(`${origin}/api/items`, { headers: { Host: "example.com" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal(readFileSync(dataFile, "utf8"), before);
});

test("concurrent additions do not lose writes", async (t) => {
  const { request, dataFile } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    request("/api/items", "POST", { name: `Item ${index}` })));
  assert.ok(responses.every((response) => response.status === 201));
  assert.equal(createStore(dataFile).read().length, 18);
});

test("filtered responses retain whole-list counts and sorting never changes saved order", async (t) => {
  const { request, dataFile } = await fixture(t);
  const before = readFileSync(dataFile, "utf8");
  const filtered = await (await request("/api/items?q=Milk")).json();
  assert.deepEqual(filtered.items.map((item) => item.name), ["Milk"]);
  assert.equal(filtered.total, 6);
  assert.equal(filtered.bought, 2);
  const alphabetical = await (await request("/api/items?sort=name")).json();
  assert.deepEqual(alphabetical.items.map((item) => item.name), ["Apples", "Bananas", "Bread", "Coffee", "Eggs", "Milk"]);
  assert.equal((await request("/api/items?sort=unknown")).status, 400);
  assert.equal(readFileSync(dataFile, "utf8"), before);
});

test("invalid stored JSON or schema is never silently replaced with seed data", async (t) => {
  const { dataFile } = await fixture(t);
  for (const content of ["{broken", '{"version":2,"items":[]}', '{"version":1,"items":[{}]}']) {
    writeFileSync(dataFile, content);
    assert.throws(() => createStore(dataFile));
    assert.equal(readFileSync(dataFile, "utf8"), content);
  }
});

test("literal markup and Unicode remain ordinary item names", async (t) => {
  const { request, dataFile } = await fixture(t);
  const name = '<img src=x onerror="alert(1)"> Caf\u00e9';
  const item = await (await request("/api/items", "POST", { name })).json();
  assert.equal(item.name, name);
  assert.equal(createStore(dataFile).read().find((entry) => entry.id === item.id).name, name);
});

test("selecting items does not mutate the caller's array", () => {
  const items = [{ name: "Z", quantity: 2 }, { name: "A", quantity: 1 }];
  const before = structuredClone(items);
  assert.deepEqual(selectItems(items, "", "name").map((item) => item.name), ["A", "Z"]);
  assert.deepEqual(items, before);
});
