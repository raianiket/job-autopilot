import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";

const RESULTS_CSV = path.resolve(process.cwd(), "results.csv");
const JOBS_CSV    = path.resolve(process.cwd(), "data/jobs.csv");

interface ResultRow {
  job_url: string;
  status: string;
  timestamp: string;
}

interface JobRow {
  job_title: string;
  company: string;
  job_url: string;
  location: string;
  apply_type: string;
  score: string;
  reason: string;
  posted_at: string;
  fetched_at: string;
}

function unquote(val: string): string {
  return val.replace(/^"|"$/g, "").trim();
}

function readResults(): ResultRow[] {
  if (!fs.existsSync(RESULTS_CSV)) return [];

  const lines = fs.readFileSync(RESULTS_CSV, "utf-8").split("\n").slice(1);
  const results: ResultRow[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;
    const job_url = unquote(line.slice(0, firstComma));
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    const status = unquote(secondComma === -1 ? rest : rest.slice(0, secondComma));
    const timestamp = secondComma === -1 ? "" : unquote(rest.slice(secondComma + 1));
    results.push({ job_url, status, timestamp });
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function readJobs(): JobRow[] {
  if (!fs.existsSync(JOBS_CSV)) return [];

  const lines = fs.readFileSync(JOBS_CSV, "utf-8").split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => unquote(h));
  const jobs: JobRow[] = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;

    // Parse CSV respecting quoted fields
    const fields: string[] = [];
    let current = "";
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { fields.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    fields.push(current.trim());

    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = fields[i] ?? ""; });

    jobs.push({
      job_title:  row["job_title"]  ?? "",
      company:    row["company"]    ?? "",
      job_url:    row["job_url"]    ?? "",
      location:   row["location"]   ?? "",
      apply_type: row["apply_type"] ?? "",
      score:      row["score"]      ?? "",
      reason:     row["reason"]     ?? "",
      posted_at:  row["posted_at"]  ?? "",
      fetched_at: row["fetched_at"] ?? "",
    });
  }

  return jobs;
}

function statusColor(status: string): string {
  if (status === "applied") return "#22c55e";
  if (status === "skipped") return "#f59e0b";
  return "#ef4444";
}

function applyTypeBadge(type: string): string {
  if (type === "easy_apply") return `<span style="background:#6366f1;color:#fff;padding:.15rem .5rem;border-radius:9999px;font-size:.7rem;font-weight:600">Easy Apply</span>`;
  if (type === "external")   return `<span style="background:#334155;color:#94a3b8;padding:.15rem .5rem;border-radius:9999px;font-size:.7rem;font-weight:600">External</span>`;
  return "";
}

function buildHtml(results: ResultRow[], jobs: JobRow[]): string {
  const applied  = results.filter((r) => r.status === "applied").length;
  const skipped  = results.filter((r) => r.status === "skipped").length;
  const failed   = results.filter((r) => r.status === "failed").length;
  const easyJobs = jobs.filter((j) => j.apply_type === "easy_apply").length;
  const extJobs  = jobs.filter((j) => j.apply_type === "external").length;

  // Build a map of job_url → job details for enriching results table
  const jobMap = new Map(jobs.map((j) => [j.job_url, j]));

  const resultRows = results.map((r, i) => {
    const job = jobMap.get(r.job_url);
    return `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge" style="background:${statusColor(r.status)}">${r.status}</span></td>
      <td>${job ? `<strong>${job.job_title}</strong><br/><small>${job.company}</small>` : `<a href="${r.job_url}" target="_blank">${r.job_url}</a>`}</td>
      <td>${job ? applyTypeBadge(job.apply_type) : ""}</td>
      <td>${job?.score ? job.score + "/10" : ""}</td>
      <td>${r.timestamp ? new Date(r.timestamp).toLocaleString() : ""}</td>
    </tr>`;
  }).join("");

  const jobRows = jobs.map((j, i) => {
    const result = results.find((r) => r.job_url === j.job_url);
    const statusCell = result
      ? `<span class="badge" style="background:${statusColor(result.status)}">${result.status}</span>`
      : `<span style="color:#475569;font-size:.8rem">pending</span>`;
    return `
    <tr>
      <td>${i + 1}</td>
      <td><a href="${j.job_url}" target="_blank"><strong>${j.job_title}</strong></a><br/><small style="color:#64748b">${j.company}</small></td>
      <td style="color:#94a3b8;font-size:.8rem">${j.location}</td>
      <td>${applyTypeBadge(j.apply_type)}</td>
      <td>${j.score ? `<strong style="color:#6366f1">${j.score}/10</strong>` : ""}</td>
      <td style="font-size:.75rem;color:#64748b;max-width:200px">${j.reason}</td>
      <td style="font-size:.75rem;color:#94a3b8;white-space:nowrap">${j.posted_at ? new Date(j.posted_at).toLocaleDateString() : ""}</td>
      <td style="font-size:.75rem;color:#475569;white-space:nowrap">${j.fetched_at ? new Date(j.fetched_at).toLocaleDateString() : ""}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Job Autopilot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; }
    h2 { font-size: 1rem; font-weight: 600; margin: 2rem 0 1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
    .sub { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; margin-top: .25rem; }
    .stats { display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .stat { background: #1e293b; border-radius: .75rem; padding: 1.25rem 1.75rem; flex: 1; min-width: 120px; }
    .stat-label { font-size: .75rem; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }
    .stat-value { font-size: 2rem; font-weight: 700; margin-top: .25rem; }
    .c-green { color: #22c55e; } .c-yellow { color: #f59e0b; } .c-red { color: #ef4444; } .c-white { color: #e2e8f0; } .c-purple { color: #6366f1; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: .75rem; overflow: hidden; }
    th { text-align: left; padding: .75rem 1rem; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #64748b; border-bottom: 1px solid #334155; }
    td { padding: .75rem 1rem; border-bottom: 1px solid #0f172a; font-size: .875rem; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #263148; }
    .badge { padding: .2rem .6rem; border-radius: 9999px; font-size: .75rem; font-weight: 600; color: #fff; }
    a { color: #60a5fa; text-decoration: none; } a:hover { text-decoration: underline; }
    .empty { text-align: center; padding: 3rem; color: #475569; }
    small { color: #64748b; }
  </style>
</head>
<body>
  <h1>Job Autopilot Dashboard</h1>
  <p class="sub">Refresh to update &nbsp;·&nbsp; ${jobs.length} discovered &nbsp;·&nbsp; ${results.length} attempted</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Discovered</div><div class="stat-value c-white">${jobs.length}</div></div>
    <div class="stat"><div class="stat-label">Easy Apply</div><div class="stat-value c-purple">${easyJobs}</div></div>
    <div class="stat"><div class="stat-label">External</div><div class="stat-value c-white">${extJobs}</div></div>
    <div class="stat"><div class="stat-label">Applied</div><div class="stat-value c-green">${applied}</div></div>
    <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value c-yellow">${skipped}</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value c-red">${failed}</div></div>
  </div>

  <h2>Results</h2>
  ${results.length === 0
    ? `<div class="empty">No applications yet. Run <code>npm run apply</code> to start.</div>`
    : `<table>
    <thead><tr><th>#</th><th>Job</th><th>Type</th><th>Score</th><th>Time</th></tr></thead>
    <tbody>${resultRows}</tbody>
  </table>`}

  <h2>Discovered Jobs (${jobs.length})</h2>
  ${jobs.length === 0
    ? `<div class="empty">No jobs yet. Run <code>npm run discover</code> first.</div>`
    : `<table>
    <thead><tr><th>#</th><th>Job</th><th>Location</th><th>Type</th><th>Score</th><th>Reason</th><th>Posted</th><th>Fetched</th><th>Status</th></tr></thead>
    <tbody>${jobRows}</tbody>
  </table>`}

</body>
</html>`;
}

const server = http.createServer((_req, res) => {
  const results = readResults();
  const jobs    = readJobs();
  const html    = buildHtml(results, jobs);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(3000, () => {
  console.log("Dashboard running at http://localhost:3000");
  exec("open http://localhost:3000", () => {});
});
