import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";

export async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "shopping-list-test-"));
  const dataFile = join(directory, "items.json");
  const server = createApp({ dataFile });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", body) => fetch(`${origin}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { server, directory, dataFile, origin, request };
}
