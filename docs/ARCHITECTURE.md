# Architecture: job-autopilot

## Problem Statement

LinkedIn Easy Apply has no public API. Application forms are dynamic, multi-step, and inconsistent across companies. Filling them manually for 50+ jobs a week wastes 3-4 hours of an engineer's time. The problem is not just automation — it's building a system that is reliable, safe, and keeps the human in control of every submission.

## System Overview

Four phases: **discover** finds and scores jobs from five kinds of source, **evaluate** deep-scores the best candidates against a rubric, **apply** fills forms and waits for human confirmation, **interview** preps you once you land one. Results sync to a cloud database and are visible in a real-time dashboard.

```
┌───────────────────────────────────────────────────────────────────┐
│                          DISCOVER PHASE                            │
│                                                                     │
│  profile.json ──► roles × locations                                │
│       │                                                             │
│       ├── Playwright ──► LinkedIn search ──► virtualized-list      │
│       │                                       harvest (scroll +    │
│       │                                       read while rendered) │
│       │                                                             │
│       ├── HTTP (no browser) ──► company boards ──► Greenhouse,     │
│       │                          data/companies.json    Lever, Ashby│
│       │                                                             │
│       └── HTTP (no browser) ──► aggregators ──► Instahyre,          │
│                                                  Remotive, RemoteOK  │
│                                         │                            │
│                                  bulk AI score (score.ts)            │
│                                  1–10, red flags, fail-open           │
│                                         │                            │
│                                  jobs.csv + jobs_history.csv          │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                    HARVEST PATH (LinkedIn alternative)              │
│                                                                     │
│  npm run harvest → scripts/harvest-linkedin.js pasted into a       │
│  browser you are ALREADY signed into (Claude/GPT extension or      │
│  DevTools) — no second login, because Chrome 136+ ignores          │
│  --remote-debugging-port on the default profile.                   │
│                                                                     │
│  Resumable cursor over roles × locations, checkpointed to           │
│  sessionStorage → linkedin-harvest.json → npm run import           │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                          EVALUATE PHASE                             │
│                                                                     │
│  jobs.csv ──► unscored rows, longest description first ──►         │
│  per-job Claude call, N concurrent ──► 6-dim weighted rubric ──►   │
│  fit_score (1–5) + verdict + red_flags ──► written back into        │
│  jobs.csv AND jobs_history.csv (not a side file)                   │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                           APPLY PHASE                                │
│                                                                     │
│  jobs.csv ──► for each job, dispatch on `source`:                   │
│                    │                                                │
│               linkedin+easy_apply → multi-step Easy Apply           │
│               greenhouse/lever    → portal form fill (src/portals)  │
│               ashby/external      → skipped, apply manually         │
│                    │                                                │
│               Upload resume + cover letter                          │
│               Fill fields (keyword matching + AI for open-ended)    │
│               Count unanswered required fields                      │
│                    ▼                                                │
│          STOP at Submit ← human reviews → y = applied | n = skip    │
│                    │                                                │
│             results.csv + Supabase                                   │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                      INTERVIEW PHASE (optional)                      │
│                                                                     │
│  STAR story bank generated once from profile.json ──►               │
│  prep <job>: likely questions, gaps, what to ask                    │
│  practice <job>: mock interview with per-answer AI feedback          │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                            DASHBOARD                                 │
│                                                                     │
│  Local:  loopback-only HTTP server, three routes:                    │
│            /          shell (palette, filters, triage strip)         │
│            /api/jobs  data the client polls every 15s, ETag'd        │
│            /app.js    the client, a real .js file                    │
│  Cloud:  Vercel → Supabase Realtime WebSocket (basic, pre-evaluate)   │
│                                                                     │
│  Shows: triage counts, source tabs, two-line rows with a rail        │
│         (hue = source, opacity = freshness), expandable detail        │
└───────────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Responsibility |
|---|---|---|
| Config loader | `src/config.ts` | Merges config.json + env vars into nested `sources`/`filters`/`evaluation`/`interview` sections, validates required fields |
| Profile loader | `src/profile.ts` | Loads candidate profile from JSON |
| Browser factory | `src/browser.ts` | Launches Playwright Chromium, or attaches over CDP to a Chrome already listening; manages session cache (14d default) |
| Job discoverer | `src/discover.ts` | Orchestrates all sources, dedupes by URL, writes jobs.csv + jobs_history.csv |
| Portal sources | `src/sources/{greenhouse,lever,ashby}.ts` | Public ATS JSON APIs, no browser or login |
| Aggregator sources | `src/sources/{instahyre,remotive,remoteok}.ts` | Broad job feeds, filtered against the profile locally |
| Source fetch layer | `src/sources/common.ts` | Retry with exponential backoff (max 5 attempts), per-run request de-dup |
| CSV read/write | `src/jobsCsv.ts` | Single column definition shared by discover and evaluate; migrates `jobs_history.csv` in place when columns are added |
| Bulk AI scorer | `src/score.ts` | Batch scores all jobs in one Claude call — 1–10, reason, red flags — fail-open |
| Deep evaluator | `src/evaluate.ts` | Per-job Claude call against the weighted rubric, N concurrent, skips already-scored rows, writes back into the CSVs |
| Form filler | `src/apply.ts` | Dispatches by `source`; multi-step LinkedIn Easy Apply, keyword matching + AI for open-ended questions |
| Portal form fillers | `src/portals/{greenhouse,lever,common}.ts` | Standard-field mapping + the same generic AI question pass, reused across portals |
| LinkedIn harvester | `scripts/harvest-linkedin.js` + `src/harvest.ts` | Browser-console alternative to Playwright login; resumable, checkpointed to sessionStorage |
| Job importer | `src/importJobs.ts` | Ingests harvested JSON into jobs.csv / jobs_history.csv, de-duping by URL |
| Interview tools | `src/interview.ts` | STAR story bank, role-specific prep, interactive mock interview |
| Supabase client | `src/supabase.ts` | Lazy client using service_role key — server-side only |
| Local dashboard | `src/dashboard.ts`, `src/dashboard/{data,render,theme}.ts`, `src/dashboard/client.js` | Loopback HTTP server; data/render/theme split server-side, client kept as a real `.js` file |
| Cloud dashboard | `dashboard/api/index.js` | Vercel serverless, injects Supabase keys, Realtime subscriptions — a simpler view, does not yet show verdict/fit_score/red_flags |

## Data Flow

```
config.json          → AppConfig (validated at startup)
data/profile.json    → CandidateProfile
                          ├── preferredRoles/preferredLocations → LinkedIn search + portal/aggregator filters
                          ├── skills + headline → AI scoring context
                          └── all fields → form autofill

LinkedIn (Playwright  → RawJob[]
 or harvest script)      ├── job_url, job_title, company, location
                          ├── apply_type (easy_apply | external)
                          ├── posted_at — Playwright parses "3 hours ago" text to an
                          │   absolute instant; the <time datetime> attribute alone
                          │   is only ever a calendar date
                          └── linkedin_score (from card badge)

Portals/Aggregators   → JobRow[] (source: greenhouse|lever|ashby|instahyre|remotive|remoteok)
 (HTTP only)              ├── job_url, job_title, company, location, posted_at
                          └── description (full JD where the API exposes one)

Bulk AI Scorer        → score: 1-10, reason: string, red_flags: string
(Claude, discover)      → filter jobs below minJobScore

Deep Evaluator         → scores per rubric dimension → fit_score (1-5, weighted
(Claude, evaluate)       mean) → verdict (strong_apply/apply/maybe/skip, red-flag
                          gated) → written back onto the same rows

jobs.csv              → JobRow[] (human-reviewed queue, refreshed each run)
jobs_history.csv      → JobRow[] (cumulative — never overwritten, used by dashboard;
                          schema-migrated in place when JobRow gains columns)

Apply loop            → ApplyResult { job_url, status, timestamp }
                          ├── results.csv (local, append-only)
                          └── Supabase job_results (cloud, real-time)

Dashboard /api/jobs   → { rows, summary } JSON, description capped to what an
                          expanded row renders, ETag'd so an unchanged poll
                          costs a 304 rather than a full re-send
```

## Key Design Decisions & Tradeoffs

### 1. Two-phase pipeline over one command
**Decision:** Separate discover and apply into independent commands with a CSV as the queue.
**Why:** Human review between phases. After discovery, you can delete rows, reorder, or add manual notes before applying. If apply crashes, rerun from the same CSV without re-scraping.
**Alternative considered:** Single pipeline. Rejected — no review window, higher risk of applying to bad jobs.

### 2. CSV as the job queue
**Decision:** `data/jobs.csv` is the queue between phases, not a database.
**Why:** Human-editable in any spreadsheet app. Zero infrastructure. The queue is ephemeral — refreshed each discover run.
**Alternative considered:** SQLite or Supabase as the queue. Rejected — adds infra overhead for data that is intentionally short-lived.

### 3. Keyword-based field matching for structured fields; AI for open-ended questions
**Decision:** Match structured fields (phone, name, location, dropdowns, radios) by `name`/`id`/`placeholder` patterns. Use Claude only for text/number inputs that can't be matched by keyword (e.g. "Years of React experience").
**Why:** Keywords are fast, deterministic, and free for the majority of fields. AI is reserved for genuinely ambiguous questions where context matters. Experience rule: 5 years if skill is in profile, 1 year if not.
**Alternative considered:** Send the full DOM to Claude for every field. Rejected — 1 API call per form step is slow and expensive at scale.

### 4. Never auto-submit
**Decision:** Always stop at the Submit button and wait for human confirmation.
**Why:** Trust. A bad auto-submit cannot be undone. One missed `required` field or wrong answer ruins the application. The human confirmation loop costs 5 seconds and prevents irreversible mistakes.

### 5. Fail-open on AI scoring
**Decision:** If the Claude API call fails, return all jobs unfiltered.
**Why:** Discovery should never fail due to an external API being unavailable. A missed filter is recoverable — a failed discover run means you start over.

### 6. Session caching
**Decision:** After login, `context.storageState()` is saved to `.linkedin-session.json` with a timestamp. Both `discover` and `apply` skip the login page if the file exists and is under 14 days old.
**Why:** Running discover then apply back-to-back previously required two manual logins. The session file stores cookies + localStorage, same as a browser remembering you.
**Security:** File is gitignored, never committed. The TTL limits exposure if the file is accidentally shared.

### 7. Service role key server-side only
**Decision:** `SUPABASE_SERVICE_ROLE_KEY` is only used in `src/supabase.ts` (Node.js, never shipped to browser). The Vercel dashboard uses only the anon key.
**Why:** Service role key bypasses RLS — if it leaks, anyone can read/write your database. Anon key is scoped to SELECT by RLS policy.

### 8. Portal APIs over scraping
**Decision:** Greenhouse, Lever, and Ashby are read through their public JSON APIs (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`), not by rendering their pages.
**Why:** No browser, no login, no DOM to break. A company that is not a customer of that portal simply 404s — treated as "no jobs," never as a run failure.
**Tradeoff:** Company boards need curating into `data/companies.json`; there is no crawl that discovers them for you. 103 tokens are shipped pre-verified in `data/companies.example.json`.

### 9. Retry with backoff, but only for retryable failures
**Decision:** `src/sources/common.ts` retries network errors, timeouts, 408/425/429, and 5xx up to 5 times with exponential backoff (0.5s/1s/2s/4s). A 404 or 401/403 returns immediately.
**Why:** Most of the 103 company tokens legitimately 404 (not a customer of that portal). Retrying those five times each would add minutes per run for zero benefit — only failures that might succeed on a second try are worth the wait.
**Also:** identical URLs are de-duplicated for the life of a run, so the same endpoint is never fetched twice.

### 10. Two ways to get LinkedIn jobs, because neither alone covers both cases
**Decision:** `npm run discover` drives Playwright's own browser; `npm run harvest` emits a script to paste into a browser already signed into LinkedIn.
**Why:** Since Chrome 136 (May 2025), Chrome silently ignores `--remote-debugging-port` on the *default* profile — a deliberate anti-cookie-theft fix. Playwright therefore cannot attach to a user's everyday Chrome and reuse its login; it must either launch its own browser (needing a login, cached 14 days) or attach to a Chrome started with a **dedicated** `--user-data-dir`.
**The harvest fallback:** `scripts/harvest-linkedin.js`, pasted into DevTools of any signed-in browser, needs no CDP at all. It bakes in `preferredRoles`/`preferredLocations` from config, walks them as a resumable cursor checkpointed to `sessionStorage`, and downloads a JSON file `npm run import` ingests.
**A shared bug both paths had to solve:** LinkedIn virtualizes its results list — every `<li>` exists but only ~7 have rendered contents at once, unrendering as you scroll past. Scrolling first and extracting after (the original approach) therefore only ever captured the handful of cards still rendered, regardless of match count. Both the Playwright extractor and the harvest script now scroll each card into view and read it immediately, keyed on `data-occludable-job-id`.

### 11. Deep evaluation is separate from bulk scoring
**Decision:** `score.ts` (used by discover) does one batch Claude call against just titles, for cheap triage across potentially hundreds of jobs. `evaluate.ts` is a separate, later step: one Claude call per job against the full description, scoring 6 weighted dimensions into a `fit_score` and `verdict`.
**Why:** Batching many jobs into one prompt degrades scoring quality once each job needs a full job description considered. Splitting the concerns means discover stays fast and cheap, and evaluate is run deliberately, only against the shortlist worth the deeper (and more expensive) pass.
**Also:** `evaluate` skips rows that already have a `verdict` unless `--force` is passed, so a re-run costs nothing for jobs already scored, and prioritizes rows with the longest description first since those produce a materially better evaluation.

### 12. The dashboard polls JSON; it does not re-render the page
**Decision:** Three routes — `/` (shell), `/api/jobs` (data), `/app.js` (client) — where the client polls `/api/jobs` every 15s and only replaces the row list.
**Why:** The previous design meta-refreshed the entire document every 15s, which reset the selected tab mid-browse and needed a `sessionStorage` workaround to compensate. Polling only the data means filters, scroll position, and expanded rows all survive a refresh without a workaround.
**Also:** `/api/jobs` ETags its response and returns 304 on an unchanged poll. This required moving `age_hours` computation to the client — a server-computed age changes by milliseconds on every request, which defeated the ETag entirely until it was removed from the wire format in favor of shipping `posted_at` and deriving age client-side.

### 13. Dashboard bound to loopback only
**Decision:** `server.listen(PORT, "127.0.0.1")`, not the previous bare `server.listen(PORT)` (which defaults to `0.0.0.0`).
**Why:** No route authenticates. Listening on every interface made every job row and full job description readable by anyone on the same network. `DASHBOARD_HOST` overrides it for deliberate exposure, and the startup log warns when it is not loopback.

## Failure Modes

| Failure | Behavior | Recovery |
|---|---|---|
| LinkedIn DOM changes | Selectors return empty strings — jobs extracted with "Unknown Title" | Update selectors in `harvestJobsFromPage` (discover.ts) and `scripts/harvest-linkedin.js` — they must be kept in sync |
| LinkedIn's virtualized list hides cards | Extraction reads each card while scrolled into view, keyed on `data-occludable-job-id`, not after-the-fact | If yield drops again, check whether the id attribute or card structure changed |
| Chrome refuses `--remote-debugging-port` | `createBrowser` falls back to launching its own browser and logs "No Chrome on port N" | Use `--user-data-dir` with a dedicated profile, or accept the fallback's own login |
| Easy Apply button not found | Job marked as `skipped`, debug screenshot saved to `debug/` | Check screenshot; listing may have expired or changed DOM |
| Required field not filled | `getUnansweredRequiredCount` > 0 → auto-skip if `autoSkipUnansweredRequired: true` | Add field keyword to autofill map |
| Portal API returns 5xx/429/timeout | Retried up to 5x with exponential backoff (`fetchJson`) | Usually resolves itself; persistent failure logs a warning and treats the board as empty |
| Portal token not a customer of that portal | 404, treated as "no jobs," never aborts the run | Remove the token from `data/companies.json` if it never resolves |
| jobs_history.csv has an older column set | Migrated in place on the next `writeJobsCsv` call, mapped by column name | Automatic; a log line reports the column count change |
| LinkedIn rate limiting | `browserSlowMo` + `waitForTimeout` between pages adds natural delay | Increase `browserSlowMo` in config |
| Claude API down during bulk scoring | Caught, warns, returns all jobs unfiltered | Re-run discover once API is back |
| Claude API down during evaluate | That job's evaluation is skipped with a warning; others continue | Re-run `npm run evaluate` — already-scored rows are skipped automatically |
| Supabase insert fails | Warning logged, result still written to `results.csv` | Results not lost, can sync later |
| Session timeout during apply | Playwright throws, job marked `failed` | Re-run apply — failed jobs are retried |
| Session cache expired mid-run | `isSessionValid()` returns false at startup, login prompted | Login once, new session saved for 14 days |

## Scale Considerations

- **Current:** Single user, local machine
- **Per-role cap:** `maxPerRole` × role count for LinkedIn; `maxPerCompany` per portal company; `maxPages`/`limitPerQuery` per aggregator — all config, not hardcoded
- **Portal/aggregator fetch:** pure HTTP, bounded by `concurrency` (default 5), so hundreds of company boards resolve in seconds, not minutes
- **Bulk AI scoring:** single batch call per discover run, regardless of job count — O(1) API calls
- **Deep evaluation:** one Claude call per job, `evaluation.concurrency` (default 4) at a time — scales linearly with jobs evaluated, so it is run against a shortlist, not the full catalogue
- **Apply throughput:** Human-gated, ~2-5 min per job — intentional bottleneck
- **Dashboard payload:** descriptions capped to what an expanded row renders (1600 chars), cutting the JSON response by roughly two-thirds; ETag'd so a steady-state 15s poll costs a 304
- **Supabase:** Free tier handles thousands of rows — not a constraint at this scale

## What's Broken / Next Steps

1. **LinkedIn match score scraping** — DOM varies per user/session, often empty
2. **One cover letter for every application** — same file uploaded regardless of the specific job
3. **No Slack/email notification** — can't run overnight without checking terminal
4. **Cloud (Vercel) dashboard predates verdict/fit_score/red_flags/source** — it renders the older column set; the local dashboard is the one with the full triage view
5. **Ashby applications are not automated** — discovery covers it, but there is no `src/portals/ashby.ts`; those postings are always skipped for manual application
6. **Naukri, Hirist, Wellfound have no usable public API** — Naukri needs private auth headers, the other two 404. Not fixable without scraping, which was deliberately avoided for the other sources.
