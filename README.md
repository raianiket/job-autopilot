# job-autopilot

> Automates LinkedIn Easy Apply. You stay in control of every submission.

Built with **Node.js · TypeScript · Playwright**

---

## How it works

```
npm run discover    →   finds jobs → scores with AI → data/jobs.csv
npm run apply       →   fills forms → you confirm → results.csv
npm run dashboard   →   opens browser dashboard with stats
```

**Discover** searches LinkedIn for every `role × location` combo from your profile, scrolls results, scores each job against your profile using AI, and saves to a CSV. Jobs are tagged `easy_apply` or `external`.

**Apply** reads that CSV, fills each Easy Apply form with your profile data, and stops at the Submit button — you review and hit `y` to confirm. External apply jobs are flagged for manual handling.

**Dashboard** opens a local web UI showing applied/skipped/failed counts and a full results table.

---

## Setup

```bash
npm install
npx playwright install chromium
```

**1. Copy and fill config**
```bash
cp config.example.json config.json
```
Only `phone` is required. Everything else has sensible defaults.

**2. Add your files to `data/`**

```bash
cp data/profile.example.json data/profile.json
```

| File | What it is |
|---|---|
| `data/resume.pdf` | Your resume — uploaded to every application |
| `data/profile.json` | Your details — name, roles, locations, cover letter, etc. |

---

## Run

```bash
# Step 1 — find jobs (scores each job with AI if claudeModel is set)
npm run discover

# Review data/jobs.csv — remove anything you don't want to apply to

# Step 2 — apply
npm run apply

# Step 3 — track results (opens http://localhost:3000)
npm run dashboard
```

---

## Results

Every attempt is logged to `results.csv` and shown in the dashboard:

| Status | Meaning |
|---|---|
| `applied` | You confirmed the submission |
| `skipped` | Easy Apply not found, unfillable fields, or you skipped |
| `failed` | Error — retried on next run |

Applied jobs are never retried. Failed/skipped ones are.

---

## Optional: AI scoring + real-time dashboard

Set these in a `.env` file (copy from `.env.example`):

| Variable | What it enables |
|---|---|
| `ANTHROPIC_API_KEY` | AI scores each job 1–10 against your profile during discover |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Syncs results to Supabase so the dashboard updates live |

Everything works without these — they're purely optional upgrades.

---

## Safety

- **Never auto-submits** — always stops for your confirmation
- Browser runs visible so you see every action
- `autoSkipUnansweredRequired: true` prevents incomplete submissions
- Type `q` at any prompt to stop immediately
