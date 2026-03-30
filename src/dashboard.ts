import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";

const RESULTS_CSV   = path.resolve(process.cwd(), "results.csv");
const JOBS_HISTORY  = path.resolve(process.cwd(), "data/jobs_history.csv");
const JOBS_CSV      = path.resolve(process.cwd(), "data/jobs.csv");

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
  role_category: string;
  linkedin_score: string;
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
  // Prefer history file (accumulates across discover runs) over current jobs.csv
  const jobsFile = fs.existsSync(JOBS_HISTORY) ? JOBS_HISTORY : JOBS_CSV;
  if (!fs.existsSync(jobsFile)) return [];

  const lines = fs.readFileSync(jobsFile, "utf-8").split("\n");
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
      job_title:      row["job_title"]      ?? "",
      company:        row["company"]        ?? "",
      job_url:        row["job_url"]        ?? "",
      location:       row["location"]       ?? "",
      apply_type:     row["apply_type"]     ?? "",
      role_category:  row["role_category"]  ?? "",
      linkedin_score: row["linkedin_score"] ?? "",
      score:          row["score"]          ?? "",
      reason:         row["reason"]         ?? "",
      posted_at:      row["posted_at"]      ?? "",
      fetched_at:     row["fetched_at"]     ?? "",
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
  const resultMap = new Map(results.map((r) => [r.job_url, r]));
  const jobMap    = new Map(jobs.map((j) => [j.job_url, j]));

  // Merge: start with all jobs from jobs.csv, then add any results entries not in jobs.csv
  const allUrls = new Set([...jobs.map((j) => j.job_url), ...results.map((r) => r.job_url)]);
  const merged = [...allUrls].map((url) => {
    const job    = jobMap.get(url);
    const result = resultMap.get(url);
    return { job, result, url };
  });

  // Sort: applied first (most recent), then failed, then skipped, then pending easy_apply, then pending external
  const statusOrder = (s?: string) => s === "applied" ? 0 : s === "failed" ? 1 : s === "skipped" ? 2 : 3;
  merged.sort((a, b) => {
    const sa = statusOrder(a.result?.status);
    const sb = statusOrder(b.result?.status);
    if (sa !== sb) return sa - sb;
    // Within same status: most recent first
    if (a.result && b.result) return b.result.timestamp.localeCompare(a.result.timestamp);
    // Pending: easy_apply before external
    if (!a.result && !b.result) {
      const ta = a.job?.apply_type === "easy_apply" ? 0 : 1;
      const tb = b.job?.apply_type === "easy_apply" ? 0 : 1;
      return ta - tb;
    }
    return 0;
  });

  const applied  = results.filter((r) => r.status === "applied").length;
  const skipped  = results.filter((r) => r.status === "skipped").length;
  const failed   = results.filter((r) => r.status === "failed").length;
  const easyJobs = jobs.filter((j) => j.apply_type === "easy_apply").length;
  const extJobs  = jobs.filter((j) => j.apply_type === "external").length;
  const pending  = easyJobs - results.filter((r) => {
    const j = jobMap.get(r.job_url);
    return j?.apply_type === "easy_apply";
  }).length;

  const categories = [...new Set(jobs.map((j) => j.role_category || "Other"))];

  const rows = merged.map((m, i) => {
    const { job, result, url } = m;
    const statusCell = result
      ? `<span class="badge" style="background:${statusColor(result.status)}">${result.status}</span>`
      : `<span style="color:#475569;font-size:.8rem">pending</span>`;
    const timeCell = result?.timestamp ? new Date(result.timestamp).toLocaleString() : "";
    const titleCell = job
      ? `<a href="${url}" target="_blank"><strong>${job.job_title}</strong></a><br/><small>${job.company}</small>`
      : `<a href="${url}" target="_blank">${url}</a>`;
    return `
    <tr class="job-row" data-category="${job?.role_category || "Other"}">
      <td>${i + 1}</td>
      <td>${titleCell}</td>
      <td style="color:#94a3b8;font-size:.8rem">${job?.location ?? ""}</td>
      <td>${applyTypeBadge(job?.apply_type ?? "")}</td>
      <td>${job?.score ? `<strong style="color:#6366f1">${job.score}/10</strong>` : ""}</td>
      <td>${statusCell}</td>
      <td style="font-size:.75rem;color:#94a3b8;white-space:nowrap">${timeCell}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta http-equiv="refresh" content="15"/>
  <title>Job Autopilot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; }
    h2 { font-size: 1rem; font-weight: 600; margin: 2rem 0 1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
    .sub { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; margin-top: .25rem; }
    .stats { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
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
    .cats { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .cat { background: #1e293b; border: 1px solid #334155; border-radius: .5rem; padding: .4rem .9rem; font-size: .8rem; cursor: pointer; color: #94a3b8; }
    .cat.active { background: #6366f1; border-color: #6366f1; color: #fff; font-weight: 600; }
    .job-row { display: none; }
    .job-row.visible { display: table-row; }
  </style>
</head>
<body>
  <h1>Job Autopilot Dashboard</h1>
  <p class="sub">Auto-refreshes every 15s &nbsp;·&nbsp; ${jobs.length} discovered &nbsp;·&nbsp; ${results.length} attempted</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Easy Apply</div><div class="stat-value c-purple">${easyJobs}</div></div>
    <div class="stat"><div class="stat-label">Pending</div><div class="stat-value c-white">${Math.max(0, pending)}</div></div>
    <div class="stat"><div class="stat-label">Applied</div><div class="stat-value c-green">${applied}</div></div>
    <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value c-yellow">${skipped}</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value c-red">${failed}</div></div>
    <div class="stat"><div class="stat-label">External</div><div class="stat-value c-white">${extJobs}</div></div>
  </div>

  <h2>All Jobs (${merged.length})</h2>
  ${merged.length === 0
    ? `<div class="empty">No jobs yet. Run <code>npm run discover</code> first.</div>`
    : `
  <div class="cats">
    <div class="cat active" onclick="filterCat('all', this)">All (${merged.length})</div>
    ${categories.map((c) => `<div class="cat" onclick="filterCat('${c}', this)">${c}</div>`).join("")}
  </div>
  <table>
    <thead><tr><th>#</th><th>Job</th><th>Location</th><th>Type</th><th>Score</th><th>Status</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    function filterCat(cat, el) {
      document.querySelectorAll('.cat').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.job-row').forEach(r => {
        r.classList.toggle('visible', cat === 'all' || r.dataset.category === cat);
      });
    }
    document.querySelectorAll('.job-row').forEach(r => r.classList.add('visible'));
  </script>`}

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
