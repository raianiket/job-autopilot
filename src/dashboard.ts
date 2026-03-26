import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";

const RESULTS_CSV = path.resolve(process.cwd(), "results.csv");

interface ResultRow {
  job_url: string;
  status: string;
  timestamp: string;
}

function readResults(): ResultRow[] {
  if (!fs.existsSync(RESULTS_CSV)) {
    return [];
  }

  const lines = fs.readFileSync(RESULTS_CSV, "utf-8").split("\n").slice(1);
  const results: ResultRow[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;
    const job_url = line.slice(0, firstComma).replace(/^"|"$/g, "").trim();
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    const status = (secondComma === -1 ? rest : rest.slice(0, secondComma)).replace(/^"|"$/g, "").trim();
    const timestamp = secondComma === -1 ? "" : rest.slice(secondComma + 1).replace(/^"|"$/g, "").trim();
    results.push({ job_url, status, timestamp });
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function statusColor(status: string): string {
  if (status === "applied") return "#22c55e";
  if (status === "skipped") return "#f59e0b";
  return "#ef4444";
}

function buildHtml(results: ResultRow[]): string {
  const applied = results.filter((r) => r.status === "applied").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const total = results.length;

  const rows = results
    .map(
      (r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge" style="background:${statusColor(r.status)}">${r.status}</span></td>
      <td><a href="${r.job_url}" target="_blank">${r.job_url}</a></td>
      <td>${r.timestamp ? new Date(r.timestamp).toLocaleString() : ""}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Job Autopilot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .sub { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
    .stats { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .stat { background: #1e293b; border-radius: 0.75rem; padding: 1.25rem 1.75rem; flex: 1; min-width: 120px; }
    .stat-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 2rem; font-weight: 700; margin-top: 0.25rem; }
    .applied { color: #22c55e; }
    .skipped { color: #f59e0b; }
    .failed  { color: #ef4444; }
    .total   { color: #e2e8f0; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 0.75rem; overflow: hidden; }
    th { text-align: left; padding: 0.75rem 1rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1px solid #334155; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #1e293b; font-size: 0.875rem; word-break: break-all; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #263148; }
    .badge { padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; color: #fff; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { text-align: center; padding: 3rem; color: #475569; }
  </style>
</head>
<body>
  <h1>Job Autopilot Dashboard</h1>
  <p class="sub">Auto-refreshes on reload &nbsp;·&nbsp; ${total} total attempts</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Applied</div><div class="stat-value applied">${applied}</div></div>
    <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value skipped">${skipped}</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value failed">${failed}</div></div>
    <div class="stat"><div class="stat-label">Total</div><div class="stat-value total">${total}</div></div>
  </div>

  ${
    total === 0
      ? `<div class="empty">No results yet. Run <code>npm run apply</code> to start applying.</div>`
      : `<table>
    <thead><tr><th>#</th><th>Status</th><th>Job URL</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</body>
</html>`;
}

const server = http.createServer((_req, res) => {
  const results = readResults();
  const html = buildHtml(results);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(3000, () => {
  console.log("Dashboard running at http://localhost:3000");
  exec("open http://localhost:3000", () => {});
});
