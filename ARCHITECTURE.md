# Architecture: job-autopilot

## Problem Statement

LinkedIn Easy Apply has no public API. Application forms are dynamic, multi-step, and inconsistent across companies. Filling them manually for 50+ jobs a week wastes 3-4 hours of an engineer's time. The problem is not just automation — it's building a system that is reliable, safe, and keeps the human in control of every submission.

## System Overview

A two-phase pipeline: **discover** finds and scores jobs, **apply** fills forms and waits for human confirmation. Results sync to a cloud database and are visible in a real-time dashboard.

```
┌─────────────────────────────────────────────────────────────┐
│                        DISCOVER PHASE                        │
│                                                             │
│  profile.json ──► Playwright ──► LinkedIn Search ──► Cards  │
│       │                                    │                │
│  preferredRoles                    Extract: title,           │
│  preferredLocations                company, url,            │
│                                    apply_type,              │
│                                    posted_at                │
│                                         │                   │
│                                    AI Scorer (Claude)        │
│                                    score 1-10 per job        │
│                                         │                   │
│                                    jobs.csv  ◄── human review│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         APPLY PHASE                          │
│                                                             │
│  jobs.csv ──► for each job:                                 │
│                    │                                        │
│               Open job page                                 │
│               Find Easy Apply button                        │
│               Click → modal opens                           │
│               Upload resume                                 │
│               Fill fields (keyword matching)                │
│               Count unanswered required fields              │
│               Navigate steps                                │
│               ▼                                             │
│          STOP at Submit                                      │
│          ← human reviews →                                  │
│          y = applied | n = skip                             │
│                    │                                        │
│             results.csv + Supabase                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        DASHBOARD                             │
│                                                             │
│  Local:  HTTP server → reads results.csv + jobs.csv         │
│  Cloud:  Vercel → Supabase Realtime WebSocket               │
│                                                             │
│  Shows: stats, job list by category, apply status           │
└─────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Responsibility |
|---|---|---|
| Config loader | `src/config.ts` | Merges config.json + env vars, validates required fields |
| Profile loader | `src/profile.ts` | Loads candidate profile from JSON |
| Browser factory | `src/browser.ts` | Creates Playwright Chromium instance (headless/visible, slowMo) |
| Job discoverer | `src/discover.ts` | LinkedIn scraper — per-role search, card extraction, dedup |
| AI scorer | `src/score.ts` | Batch scores all jobs in one Claude API call, filters by minJobScore |
| Form filler | `src/apply.ts` | Multi-step form automation, keyword-based field matching |
| Supabase client | `src/supabase.ts` | Lazy client using service_role key — server-side only |
| Local dashboard | `src/dashboard.ts` | HTTP server, reads CSVs, serves categorized job list |
| Cloud dashboard | `dashboard/api/index.js` | Vercel serverless, injects Supabase keys, Realtime subscriptions |

## Data Flow

```
config.json          → AppConfig (validated at startup)
data/profile.json    → CandidateProfile
                          ├── preferredRoles → LinkedIn search URLs
                          ├── skills + headline → AI scoring context
                          └── all fields → form autofill

LinkedIn (Playwright) → RawJob[]
                          ├── job_url, job_title, company, location
                          ├── apply_type (easy_apply | external)
                          ├── posted_at (from <time datetime>)
                          └── linkedin_score (from card badge)

AI Scorer (Claude)    → score: 1-10, reason: string
                        → filter jobs below minJobScore

jobs.csv              → JobRow[] (human-reviewed queue)

Apply loop            → ApplyResult { job_url, status, timestamp }
                          ├── results.csv (local, append-only)
                          └── Supabase job_results (cloud, real-time)
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

### 3. Keyword-based field matching over AI-driven form filling
**Decision:** Match form fields by `name`, `id`, `placeholder` attributes against keyword patterns.
**Why:** Fast, deterministic, zero API cost per field. Works offline.
**Alternative considered:** Send the DOM to Claude and let it decide what to fill. Rejected — slow (1 API call per form step), expensive, and non-deterministic.

### 4. Never auto-submit
**Decision:** Always stop at the Submit button and wait for human confirmation.
**Why:** Trust. A bad auto-submit cannot be undone. One missed `required` field or wrong answer ruins the application. The human confirmation loop costs 5 seconds and prevents irreversible mistakes.

### 5. Fail-open on AI scoring
**Decision:** If the Claude API call fails, return all jobs unfiltered.
**Why:** Discovery should never fail due to an external API being unavailable. A missed filter is recoverable — a failed discover run means you start over.

### 6. Service role key server-side only
**Decision:** `SUPABASE_SERVICE_ROLE_KEY` is only used in `src/supabase.ts` (Node.js, never shipped to browser). The Vercel dashboard uses only the anon key.
**Why:** Service role key bypasses RLS — if it leaks, anyone can read/write your database. Anon key is scoped to SELECT by RLS policy.

## Failure Modes

| Failure | Behavior | Recovery |
|---|---|---|
| LinkedIn DOM changes | Selectors return empty strings — jobs extracted with "Unknown Title" | Update CSS selectors in `extractJobsFromPage` |
| Easy Apply button not found | Job marked as `external`, logged, browser stays open for manual apply | User applies manually, result tracked as `skipped` |
| Required field not filled | `getUnansweredRequiredCount` > 0 → auto-skip if `autoSkipUnansweredRequired: true` | Add field keyword to autofill map |
| Radio button group miscounted | Fixed: groups tracked by `name` attribute, counted as 1 field | — |
| LinkedIn rate limiting | `browserSlowMo` + `waitForTimeout` between pages adds natural delay | Increase `browserSlowMo` in config |
| Claude API down during scoring | Caught, warns, returns all jobs unfiltered | Re-run discover once API is back |
| Supabase insert fails | Warning logged, result still written to `results.csv` | Results not lost, can sync later |
| Session timeout during apply | Playwright throws, job marked `failed` | Re-run apply — failed jobs are retried |

## Scale Considerations

- **Current:** Single user, local machine, ~50 jobs/run
- **Per-role cap:** 10 jobs × 7 roles = 70 max per run, prevents LinkedIn rate limiting
- **AI scoring:** Single batch call regardless of job count — O(1) API calls
- **Apply throughput:** Human-gated, ~2-5 min per job — intentional bottleneck
- **Supabase:** Free tier handles thousands of rows — not a constraint at this scale

## What's Broken / Next Steps

1. **LinkedIn match score scraping** — DOM varies per user/session, often empty
2. **No per-job cover letter** — same cover letter for every application
3. **No job description parsing** — scoring uses title + company only, not the full JD
4. **No Slack/email notification** — can't run overnight without checking terminal
5. **External apply tracking** — marked `skipped` but user has no reminder to apply manually
