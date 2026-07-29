import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { loadRows, summarize } from "./dashboard/data";
import { clientConfig, renderShell } from "./dashboard/render";

const PORT = Number.parseInt(process.env.DASHBOARD_PORT ?? "", 10) || 3000;
// tsc does not copy .js assets into dist, so fall back to the source tree.
const CLIENT_CANDIDATES = [
  path.resolve(__dirname, "dashboard/client.js"),
  path.resolve(process.cwd(), "src/dashboard/client.js"),
];

function readClient(): string | null {
  for (const candidate of CLIENT_CANDIDATES) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
  }
  return null;
}

/**
 * Routes:
 *   /           the shell — palette, layout, and filter controls
 *   /api/jobs   the data, polled every 15s by the client
 *   /app.js     the client, kept as a real .js file so tooling can read it
 *
 * The shell is rebuilt per request because the tab counts live in it; the list
 * itself is filled entirely by /api/jobs so a poll never disturbs the page.
 */
const server = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (url === "/api/jobs") {
    const rows = loadRows();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ rows, summary: summarize(rows) }));
    return;
  }

  if (url === "/app.js") {
    const js = readClient();
    if (js === null) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Client not found. Looked in:\n${CLIENT_CANDIDATES.join("\n")}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(`var COLORS = ${clientConfig()};\n${js}`);
    return;
  }

  if (url === "/") {
    const summary = summarize(loadRows());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderShell(summary));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

/**
 * Bound to loopback on purpose. There is no authentication on any route, so
 * listening on 0.0.0.0 would let anyone on the same network read every job and
 * its full description. Set DASHBOARD_HOST=0.0.0.0 to expose it deliberately.
 */
const HOST = process.env.DASHBOARD_HOST ?? "127.0.0.1";

server.listen(PORT, HOST, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  if (HOST !== "127.0.0.1") {
    console.warn(
      `Warning: bound to ${HOST}, so this is reachable from your network with no password.`
    );
  }
  exec(`open http://localhost:${PORT}`, () => {});
});
