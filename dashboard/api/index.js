function buildHtml(supabaseUrl, supabaseAnonKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Job Autopilot — Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
    h1{font-size:1.5rem;font-weight:700}
    .sub{color:#64748b;font-size:.875rem;margin-bottom:2rem;margin-top:.25rem}
    .stats{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
    .stat{background:#1e293b;border-radius:.75rem;padding:1.25rem 1.75rem;flex:1;min-width:120px}
    .stat-label{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
    .stat-value{font-size:2rem;font-weight:700;margin-top:.25rem}
    .c-applied{color:#22c55e}.c-skipped{color:#f59e0b}.c-failed{color:#ef4444}.c-total{color:#e2e8f0}
    table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:.75rem;overflow:hidden}
    th{text-align:left;padding:.75rem 1rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1px solid #334155}
    td{padding:.75rem 1rem;border-bottom:1px solid #263148;font-size:.875rem;word-break:break-all}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#1a2640}
    .badge{padding:.2rem .6rem;border-radius:9999px;font-size:.75rem;font-weight:600;color:#fff}
    .b-applied{background:#22c55e}.b-skipped{background:#f59e0b}.b-failed{background:#ef4444}
    a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:.5rem;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .empty{text-align:center;padding:3rem;color:#475569}
    #tbody tr{animation:fadeIn .3s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  </style>
</head>
<body>
  <h1>Job Autopilot Dashboard</h1>
  <p class="sub"><span class="dot"></span>Live — updates in real time</p>

  <div class="stats">
    <div class="stat"><div class="stat-label">Applied</div><div class="stat-value c-applied" id="s-applied">—</div></div>
    <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value c-skipped" id="s-skipped">—</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value c-failed" id="s-failed">—</div></div>
    <div class="stat"><div class="stat-label">Total</div><div class="stat-value c-total" id="s-total">—</div></div>
  </div>

  <div id="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Status</th><th>Job</th><th>Company</th><th>Type</th><th>Score</th><th>Time</th></tr></thead>
      <tbody id="tbody"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>

  <script>
    const SUPABASE_URL = "${supabaseUrl}";
    const SUPABASE_ANON_KEY = "${supabaseAnonKey}";

    const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    let rows = [];

    function fmt(ts) {
      if (!ts) return "";
      return new Date(ts).toLocaleString();
    }

    function badgeClass(s) {
      return s === "applied" ? "b-applied" : s === "skipped" ? "b-skipped" : "b-failed";
    }

    function render() {
      const applied = rows.filter(r => r.status === "applied").length;
      const skipped = rows.filter(r => r.status === "skipped").length;
      const failed  = rows.filter(r => r.status === "failed").length;

      document.getElementById("s-applied").textContent = applied;
      document.getElementById("s-skipped").textContent = skipped;
      document.getElementById("s-failed").textContent  = failed;
      document.getElementById("s-total").textContent   = rows.length;

      const tbody = document.getElementById("tbody");
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">No results yet. Run npm run apply to start.</td></tr>';
        return;
      }

      tbody.innerHTML = rows.map((r, i) => \`
        <tr>
          <td>\${i + 1}</td>
          <td><span class="badge \${badgeClass(r.status)}">\${r.status}</span></td>
          <td><a href="\${r.job_url}" target="_blank">\${r.job_title || r.job_url}</a></td>
          <td>\${r.company || ""}</td>
          <td>\${r.apply_type ? r.apply_type.replace("_", " ") : ""}</td>
          <td>\${r.score != null ? r.score + "/10" : ""}</td>
          <td>\${fmt(r.created_at)}</td>
        </tr>\`).join("");
    }

    async function load() {
      const { data, error } = await sb
        .from("job_results")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) { console.error(error); return; }
      rows = data || [];
      render();
    }

    // Real-time: new row inserted → prepend and re-render
    sb.channel("job_results_changes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "job_results" }, (payload) => {
        rows.unshift(payload.new);
        render();
      })
      .subscribe();

    load();
  </script>
</body>
</html>`;
}

export default function handler(req, res) {
  const supabaseUrl     = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).send(
      "Missing env vars. Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel project settings."
    );
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(buildHtml(supabaseUrl, supabaseAnonKey));
}
