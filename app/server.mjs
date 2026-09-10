import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock, ROOT } from "../demo/shopping-list/local.mjs";
import { createStore, InputError, selectItems } from "./list.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/summary.mjs", ["summary.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new InputError("Send application/json.");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      request.resume();
      throw new InputError("Request body is too large (maximum 4096 bytes).");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InputError("The request body must be valid JSON.");
  }
}

export function createApp({ dataFile = fileURLToPath(new URL("./data/items.json", import.meta.url)) } = {}) {
  const store = createStore(dataFile);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) {
        return json(response, 403, { error: "Use the localhost address printed by the server." });
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        return json(response, 403, { error: "Cross-origin requests are not allowed." });
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const body = readFileSync(new URL(`./public/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": contentType });
        return response.end(body);
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/api/items") {
        const sort = url.searchParams.get("sort") ?? "added";
        if (!["added", "name", "quantity"].includes(sort)) throw new InputError("Unknown sort order.");
        const all = store.read();
        return json(response, 200, {
          items: selectItems(all, url.searchParams.get("q") ?? "", sort),
          total: all.length,
          bought: all.filter((item) => item.bought).length,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/items") {
        return json(response, 201, store.add(await readJson(request)));
      }
      const match = /^\/api\/items\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (match && request.method === "PATCH") {
        const item = store.update(match[1], await readJson(request));
        return json(response, item ? 200 : 404, item ?? { error: "That item no longer exists. Refresh the list." });
      }
      if (match && request.method === "DELETE") {
        if (!store.remove(match[1])) return json(response, 404, { error: "That item no longer exists. Refresh the list." });
        response.writeHead(204);
        return response.end();
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof InputError) return json(response, 400, { error: error.message });
      console.error("Shopping-list request failed:", error);
      return json(response, 500, { error: "The server could not read or save your list. Check the terminal." });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let release;
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
    release = acquireLock(ROOT, "shopping-list server");
    const server = createApp();
    server.on("error", (error) => {
      console.error(`Shopping list could not start: ${error.message}`);
      release();
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Shopping List: http://127.0.0.1:${port}`);
      console.log("Saving to app/data/items.json. Ctrl+C to stop before resetting.");
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => server.close(() => {
        release();
        process.exit(0);
      }));
    }
    process.once("exit", release);
  } catch (error) {
    release?.();
    console.error(`Shopping list could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
