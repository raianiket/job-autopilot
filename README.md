# job-autopilot

> Automates LinkedIn Easy Apply. You stay in control of every submission.

Built with **Node.js · TypeScript · Playwright**

---

## How it works

```
npm run discover   →   finds jobs → data/jobs.csv
npm run apply      →   fills forms → you confirm → results.csv
```

**Discover** searches LinkedIn for every `role × location` combo from your profile, scrolls results, and saves matching jobs to a CSV.

**Apply** reads that CSV, fills each Easy Apply form with your profile data, and stops at the Submit button — you review and hit `y` to confirm.

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
# Step 1 — find jobs
npm run discover

# Review data/jobs.csv, remove anything you don't want

# Step 2 — apply
npm run apply
```

---

## Results

Every attempt is logged to `results.csv`:

| Status | Meaning |
|---|---|
| `applied` | You confirmed the submission |
| `skipped` | Easy Apply not found, unfillable fields, or you skipped |
| `failed` | Error — retried on next run |

Applied jobs are never retried. Failed/skipped ones are.

---

## Safety

- **Never auto-submits** — always stops for your confirmation
- Browser runs visible so you see every action
- `autoSkipUnansweredRequired: true` prevents incomplete submissions
- Type `q` at any prompt to stop immediately
