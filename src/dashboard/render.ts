import { Summary } from "./data";
import { SOURCE_COLORS, STATUS_COLORS, THEME, VERDICT_COLORS } from "./theme";

function styles(): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:${THEME.ink}; --raised:${THEME.raised}; --raised-hi:${THEME.raisedHi};
  --edge:${THEME.edge}; --text:${THEME.text}; --muted:${THEME.muted};
  --faint:${THEME.faint}; --accent:${THEME.accent}; --fresh:${THEME.fresh};
  --warn:${THEME.warn}; --danger:${THEME.danger};
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;
}
body{background:var(--ink);color:var(--text);font-family:var(--sans);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:1.75rem 1.5rem 4rem}

/* Header ---------------------------------------------------------------- */
.top{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;
  padding-bottom:1rem;border-bottom:1px solid var(--edge);margin-bottom:1.5rem}
.brand{font-size:1.05rem;font-weight:800;letter-spacing:-0.02em}
.brand span{color:var(--accent)}
.meta{font-family:var(--mono);font-size:.72rem;color:var(--faint);margin-left:auto}
.meta b{color:var(--muted);font-weight:500}
#live{color:var(--fresh)}

/* Triage strip: the page's thesis, what to act on now ------------------- */
.triage{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:.75rem;margin-bottom:1.5rem}
.card{background:var(--raised);border:1px solid var(--edge);border-radius:10px;
  padding:.85rem 1rem;position:relative;overflow:hidden}
.card.lead{border-color:color-mix(in srgb,var(--accent) 45%,var(--edge))}
.card .n{font-family:var(--mono);font-size:1.65rem;font-weight:700;letter-spacing:-0.03em;
  line-height:1.1}
.card .k{font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;
  color:var(--faint);margin-top:.2rem}
.card .sub{font-size:.7rem;color:var(--muted);margin-top:.35rem}
.card.lead .n{color:var(--accent)}
.card.warn .n{color:var(--warn)}
.card.fresh .n{color:var(--fresh)}
.card.zero{opacity:.5}
.card.zero .n{color:var(--faint)}

/* Tabs ------------------------------------------------------------------ */
.tabs{display:flex;gap:.15rem;flex-wrap:wrap;margin-bottom:.85rem;
  border-bottom:1px solid var(--edge)}
.tab{display:flex;align-items:center;gap:.45rem;padding:.5rem .8rem;cursor:pointer;
  font-size:.82rem;color:var(--muted);border-bottom:2px solid transparent;
  text-transform:capitalize;transition:color .12s,border-color .12s;
  background:none;border-top:0;border-left:0;border-right:0;font-family:inherit}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{color:var(--text);border-bottom-color:var(--dot,var(--accent))}
.tab .dot{width:7px;height:7px;border-radius:50%;background:var(--dot,var(--accent));
  opacity:.85;flex:none}
.tab .c{font-family:var(--mono);font-size:.7rem;color:var(--faint)}
.tab[aria-selected="true"] .c{color:var(--muted)}

/* Toolbar --------------------------------------------------------------- */
.bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}
.bar input,.bar select{background:var(--raised);border:1px solid var(--edge);
  border-radius:7px;padding:.45rem .65rem;font-size:.82rem;color:var(--text);
  font-family:inherit}
.bar input{flex:1;min-width:200px}
.bar input:focus-visible,.bar select:focus-visible,.tab:focus-visible,
.row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bar .count{font-family:var(--mono);font-size:.72rem;color:var(--faint);margin-left:auto}

/* Time-group dividers: freshness as structure, not only as tint ---------- */
.grp{display:flex;align-items:center;gap:.6rem;margin:1.1rem 0 .35rem;
  font-size:.66rem;text-transform:uppercase;letter-spacing:.12em;color:var(--faint)}
.grp:first-child{margin-top:0}
.grp::after{content:"";flex:1;height:1px;background:var(--edge)}
.grp i{font-family:var(--mono);font-style:normal;order:3;color:var(--faint)}

/* Rows: two lines, rail encodes source hue + freshness opacity ---------- */
.list{display:flex;flex-direction:column;gap:2px}
.row{display:block;width:100%;text-align:left;background:var(--raised);
  border:1px solid transparent;border-left:4px solid var(--rail,var(--faint));
  border-radius:0 7px 7px 0;padding:.55rem .85rem;cursor:pointer;
  font-family:inherit;color:inherit;font-size:inherit;
  transition:background .12s,border-color .12s}
.row:hover{background:var(--raised-hi)}
.row.hot{box-shadow:inset 3px 0 0 -1px var(--rail)}
.row[aria-expanded="true"]{background:var(--raised-hi);border-color:var(--edge);
  border-left-color:var(--rail,var(--faint))}
.loc{color:var(--faint)}
.more{font-family:var(--mono);font-size:.66rem;color:var(--faint);
  border:1px solid var(--edge);border-radius:3px;padding:0 .2rem;margin-left:.25rem}
.l1{display:flex;align-items:baseline;gap:.6rem}
.l1 .t{font-weight:600;letter-spacing:-0.01em;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.l1 .age{font-family:var(--mono);font-size:.72rem;margin-left:auto;flex:none}
.l2{display:flex;align-items:center;gap:.55rem;margin-top:.2rem;
  font-size:.76rem;color:var(--muted);flex-wrap:wrap}
.l2 .co{color:var(--text)}
.sep{color:var(--edge)}
.pill{font-family:var(--mono);font-size:.66rem;padding:.1rem .4rem;border-radius:4px;
  border:1px solid;white-space:nowrap}
.flag{font-family:var(--mono);font-size:.7rem;color:var(--danger)}
.fit{font-family:var(--mono);font-size:.72rem;font-weight:700}
.st{font-family:var(--mono);font-size:.66rem;text-transform:uppercase;
  letter-spacing:.06em;margin-left:auto;flex:none}

/* Expanded detail: surfaces reason + description, collected but unseen -- */
.detail{background:var(--ink);border:1px solid var(--edge);border-left:3px solid var(--rail);
  border-top:0;border-radius:0 0 7px 0;padding:.85rem 1rem;font-size:.8rem}
.detail h4{font-size:.66rem;text-transform:uppercase;letter-spacing:.1em;
  color:var(--faint);margin-bottom:.3rem;font-weight:600}
.detail .blk{margin-bottom:.85rem}
.detail .blk:last-child{margin-bottom:0}
.detail p{color:var(--muted);line-height:1.6}
.detail ul{margin:0;padding-left:1.1rem;color:var(--danger)}
.detail .desc{max-height:8.5rem;overflow:auto;color:var(--muted);
  font-size:.76rem;line-height:1.65;white-space:pre-wrap}
.detail .acts{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem}
.detail a{display:inline-block;font-size:.76rem;color:var(--ink);
  background:var(--accent);padding:.35rem .7rem;border-radius:6px;
  text-decoration:none;font-weight:600}
.detail a.ghost{background:none;color:var(--muted);border:1px solid var(--edge)}
.detail a:hover{opacity:.9}
.dims{display:flex;gap:1.1rem;flex-wrap:wrap;font-family:var(--mono);font-size:.72rem}
.dims i{color:var(--faint);font-style:normal}

.empty{text-align:center;padding:3rem 1rem;color:var(--faint)}
.empty b{display:block;color:var(--muted);margin-bottom:.3rem}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media(max-width:640px){
  .wrap{padding:1.25rem 1rem 3rem}
  .l1 .age{margin-left:0}
  .st{margin-left:0}
}
`;
}

function card(n: number, label: string, sub: string, cls = ""): string {
  // A zero is not news; dim it so the numbers that matter carry the eye.
  const tone = n === 0 ? "zero" : cls;
  return `<div class="card ${tone}"><div class="n">${n}</div>
    <div class="k">${label}</div><div class="sub">${sub}</div></div>`;
}

export function renderShell(s: Summary): string {
  const sources = Object.keys(s.bySource).sort();

  const tabs = [
    `<button class="tab" role="tab" aria-selected="true" data-source="all">
       <span class="dot"></span>All<span class="c">${s.total}</span></button>`,
    ...sources.map(
      (src) =>
        `<button class="tab" role="tab" aria-selected="false" data-source="${src}"
           style="--dot:${SOURCE_COLORS[src] ?? THEME.faint}">
           <span class="dot"></span>${src}<span class="c">${s.bySource[src]}</span></button>`
    ),
  ].join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>job-autopilot</title>
<style>${styles()}</style>
</head><body>
<div class="wrap">

  <header class="top">
    <div class="brand">job<span>·</span>autopilot</div>
    <div class="meta"><b id="live">live</b> · updated <b id="stamp">—</b></div>
  </header>

  <section class="triage" aria-label="What needs action">
    ${card(s.actionable, "ready to apply", "pending · easy apply · not skipped", "lead")}
    ${card(s.freshUnderDay, "posted today", "under 24 hours old", "fresh")}
    ${card(s.byStatus.applied ?? 0, "applied", "you confirmed these")}
    ${card(s.flagged, "red flagged", "ghost or scam signals", "warn")}
    ${card(s.undated, "no date", "source publishes none")}
  </section>

  <div class="tabs" role="tablist" aria-label="Job source">${tabs}</div>

  <div class="bar">
    <input id="q" type="search" placeholder="Search title, company, or location" autocomplete="off" aria-label="Search jobs"/>
    <select id="status" aria-label="Filter by status">
      <option value="all">Any status</option>
      <option value="pending">Pending</option>
      <option value="applied">Applied</option>
      <option value="skipped">Skipped</option>
      <option value="failed">Failed</option>
    </select>
    <select id="role" aria-label="Filter by role">
      <option value="all">Any role</option>
      ${s.roles.map((r) => `<option value="${r}">${r}</option>`).join("")}
    </select>
    <select id="sort" aria-label="Sort order">
      <option value="fresh">Freshest first</option>
      <option value="fit">Best fit first</option>
      <option value="company">Company A–Z</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <div class="list" id="list"></div>
  <div class="empty" id="empty" hidden><b>Nothing matches</b>Loosen a filter or clear the search.</div>

</div>
<script src="/app.js"></script>
</body></html>`;
}

/** Colour maps the client needs, injected so there is one source of truth. */
export function clientConfig(): string {
  return JSON.stringify({
    source: SOURCE_COLORS,
    verdict: VERDICT_COLORS,
    status: STATUS_COLORS,
    theme: THEME,
  });
}
