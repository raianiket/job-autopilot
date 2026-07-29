import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { exec } from "node:child_process";
import { parse } from "csv-parse/sync";

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
  source: string;
  role_category: string;
  linkedin_score: string;
  score: string;
  reason: string;
  red_flags: string;
  fit_score: string;
  verdict: string;
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

  // csv-parse handles quoted commas and embedded newlines; a hand-rolled
  // line splitter corrupts rows once descriptions are in the file.
  let records: Array<Record<string, string>>;
  try {
    records = parse(fs.readFileSync(jobsFile, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    console.warn(`Failed to parse ${jobsFile}: ${(err as Error).message}`);
    return [];
  }

  const jobs: JobRow[] = [];
  for (const row of records) {
    jobs.push({
      job_title:      row["job_title"]      ?? "",
      company:        row["company"]        ?? "",
      job_url:        row["job_url"]        ?? "",
      location:       row["location"]       ?? "",
      apply_type:     row["apply_type"]     ?? "",
      source:         row["source"]         || "linkedin",
      role_category:  row["role_category"]  ?? "",
      linkedin_score: row["linkedin_score"] ?? "",
      score:          row["score"]          ?? "",
      reason:         row["reason"]         ?? "",
      red_flags:      row["red_flags"]      ?? "",
      fit_score:      row["fit_score"]      ?? "",
      verdict:        row["verdict"]        ?? "",
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

const SOURCE_COLORS: Record<string, string> = {
  linkedin: "#0a66c2",
  greenhouse: "#3aab6d",
  lever: "#7b5cff",
  ashby: "#d97706",
  instahyre: "#e11d48",
  remotive: "#0891b2",
  remoteok: "#65a30d",
};

function sourceBadge(source: string): string {
  const color = SOURCE_COLORS[source] ?? "#475569";
  return `<span style="background:${color};color:#fff;padding:.15rem .5rem;border-radius:9999px;font-size:.68rem;font-weight:600">${source}</span>`;
}

const VERDICT_COLORS: Record<string, string> = {
  strong_apply: "#16a34a",
  apply: "#22c55e",
  maybe: "#f59e0b",
  skip: "#ef4444",
};

function verdictBadge(verdict: string, fit: string): string {
  if (!verdict) return "";
  const color = VERDICT_COLORS[verdict] ?? "#475569";
  const label = verdict.replace("_", " ");
  const score = fit ? ` ${fit}/5` : "";
  return `<span class="badge" style="background:${color}">${label}${score}</span>`;
}

/** Red flags are semicolon-joined; show a count with the full list on hover. */
function redFlagCell(flags: string): string {
  if (!flags.trim()) return "";
  const list = flags.split(";").map((f) => f.trim()).filter(Boolean);
  const title = list.join(" • ").replace(/"/g, "&quot;");
  return `<span title="${title}" style="color:#ef4444;font-weight:600;cursor:help">⚑ ${list.length}</span>`;
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

  // Tabs are per source: with several thousand rows, source is the split that
  // actually reduces the list to something browsable.
  const sourceOf = (m: (typeof merged)[number]) => m.job?.source || "linkedin";
  const sourceTabs = [
    { value: "all", label: "All", count: merged.length },
    ...[...new Set(merged.map(sourceOf))].sort().map((s) => ({
      value: s,
      label: s,
      count: merged.filter((m) => sourceOf(m) === s).length,
    })),
  ];

  const categories = [...new Set(jobs.map((j) => j.role_category || "Other"))];
  const flagged = jobs.filter((j) => j.red_flags.trim()).length;
  const portalJobs = jobs.filter((j) => (j.source || "linkedin") !== "linkedin").length;

  const rows = merged.map((m, i) => {
    const { job, result, url } = m;
    const statusCell = result
      ? `<span class="badge" style="background:${statusColor(result.status)}">${result.status}</span>`
      : `<span style="color:#475569;font-size:.8rem">pending</span>`;
    const timeCell = result?.timestamp ? new Date(result.timestamp).toLocaleString() : "";
    const titleCell = job
      ? `<a href="${url}" target="_blank"><strong>${job.job_title}</strong></a><br/><small>${job.company}</small>`
      : `<a href="${url}" target="_blank">${url}</a>`;
    const status = result?.status ?? "pending";
    const search = `${job?.job_title ?? ""} ${job?.company ?? ""} ${job?.location ?? ""}`.toLowerCase();
    return `
    <tr class="job-row" data-category="${job?.role_category || "Other"}" data-source="${job?.source || "linkedin"}" data-status="${status}" data-search="${search.replace(/"/g, "")}">
      <td class="rownum">${i + 1}</td>
      <td>${titleCell}</td>
      <td style="color:#94a3b8;font-size:.8rem">${job?.location ?? ""}</td>
      <td>${sourceBadge(job?.source || "linkedin")}</td>
      <td>${applyTypeBadge(job?.apply_type ?? "")}</td>
      <td>${job?.score ? `<strong style="color:#6366f1">${job.score}/10</strong>` : ""}</td>
      <td>${verdictBadge(job?.verdict ?? "", job?.fit_score ?? "")}</td>
      <td>${redFlagCell(job?.red_flags ?? "")}</td>
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
    .tabs { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: 1rem;
            border-bottom: 1px solid #1e293b; padding-bottom: .5rem; }
    .tab { --accent: #6366f1; display: flex; align-items: center; gap: .45rem;
           background: transparent; border: 1px solid transparent; border-radius: .5rem;
           padding: .45rem .85rem; font-size: .85rem; cursor: pointer; color: #94a3b8;
           transition: background .15s, color .15s; text-transform: capitalize; }
    .tab:hover { background: #1e293b; color: #e2e8f0; }
    .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .tab-count { background: rgba(148,163,184,.18); border-radius: 9999px;
                 padding: .05rem .45rem; font-size: .7rem; font-weight: 600; }
    .tab.active .tab-count { background: rgba(255,255,255,.25); }

    .toolbar { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
    .toolbar input, .toolbar select {
      background: #1e293b; border: 1px solid #334155; border-radius: .5rem;
      padding: .45rem .7rem; font-size: .82rem; color: #e2e8f0; font-family: inherit;
    }
    .toolbar input { flex: 1; min-width: 220px; }
    .toolbar input:focus, .toolbar select:focus { outline: none; border-color: #6366f1; }
    .count { color: #64748b; font-size: .78rem; margin-left: auto; }

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
    <div class="stat"><div class="stat-label">Portals</div><div class="stat-value c-purple">${portalJobs}</div></div>
    <div class="stat"><div class="stat-label">Red Flags</div><div class="stat-value c-red">${flagged}</div></div>
  </div>

  <h2>All Jobs (${merged.length})</h2>
  ${merged.length === 0
    ? `<div class="empty">No jobs yet. Run <code>npm run discover</code> first.</div>`
    : `
  <div class="tabs">
    ${sourceTabs
      .map(
        (t, i) =>
          `<div class="tab${i === 0 ? " active" : ""}" data-value="${t.value}" onclick="filterBy(this)" style="${t.value === "all" ? "" : `--accent:${SOURCE_COLORS[t.value] ?? "#475569"}`}">${t.label}<span class="tab-count">${t.count}</span></div>`
      )
      .join("")}
  </div>

  <div class="toolbar">
    <input id="q" type="search" placeholder="Search title, company, or location..." oninput="applyFilters()" autocomplete="off"/>
    <select id="statusSel" onchange="applyFilters()">
      <option value="all">All statuses</option>
      <option value="pending">Pending</option>
      <option value="applied">Applied</option>
      <option value="skipped">Skipped</option>
      <option value="failed">Failed</option>
    </select>
    <select id="catSel" onchange="applyFilters()">
      <option value="all">All roles</option>
      ${categories.map((c) => `<option value="${c}">${c}</option>`).join("")}
    </select>
    <span id="count" class="count"></span>
  </div>

  <table>
    <thead><tr><th>#</th><th>Job</th><th>Location</th><th>Source</th><th>Type</th><th>Score</th><th>Verdict</th><th>Flags</th><th>Status</th><th>Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div id="noresults" class="empty" style="display:none">Nothing matches these filters.</div>

  <script>
    // The page meta-refreshes every 15s, which would otherwise reset every
    // filter mid-browse. State lives in sessionStorage and is restored on load.
    var STATE_KEY = 'jobAutopilotFilters';
    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}'); } catch (e) {}
    var activeSource = saved.source || 'all';

    function saveState() {
      try {
        sessionStorage.setItem(STATE_KEY, JSON.stringify({
          source: activeSource,
          status: document.getElementById('statusSel').value,
          cat: document.getElementById('catSel').value,
          q: document.getElementById('q').value
        }));
      } catch (e) {}
    }

    function filterBy(el) {
      activeSource = el.dataset.value;
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === el); });
      applyFilters();
    }

    function applyFilters() {
      var q = document.getElementById('q').value.trim().toLowerCase();
      var status = document.getElementById('statusSel').value;
      var cat = document.getElementById('catSel').value;
      var shown = 0;

      document.querySelectorAll('.job-row').forEach(function (r) {
        var ok =
          (activeSource === 'all' || r.dataset.source === activeSource) &&
          (status === 'all' || r.dataset.status === status) &&
          (cat === 'all' || r.dataset.category === cat) &&
          (!q || r.dataset.search.indexOf(q) !== -1);
        r.classList.toggle('visible', ok);
        if (ok) { shown++; r.querySelector('.rownum').textContent = shown; }
      });

      document.getElementById('count').textContent = shown + ' of ${merged.length}';
      document.getElementById('noresults').style.display = shown ? 'none' : 'block';
      saveState();
    }

    // Restore the previous selection before the first filter pass.
    if (saved.status) document.getElementById('statusSel').value = saved.status;
    if (saved.cat) document.getElementById('catSel').value = saved.cat;
    if (saved.q) document.getElementById('q').value = saved.q;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.value === activeSource);
    });

    applyFilters();
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
