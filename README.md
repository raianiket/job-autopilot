# LinkedIn Auto Apply

A local Node.js + TypeScript + Playwright tool that automates LinkedIn Easy Apply — with you staying in control of every final submission.

---

## How It Works

The tool has two phases:

### Phase 1 — Discover (`npm run discover`)

1. Opens a Chromium browser and navigates to the LinkedIn login page.
2. Pre-fills your email from config. You complete the login manually in the browser.
3. Searches LinkedIn Jobs for every combination of your `preferredRoles` × `preferredLocations`.
4. Scrolls each results page to load more listings, then extracts job title, company, location, and URL.
5. Writes up to `--max` (default 60) unique jobs to `data/jobs.csv`.

### Phase 2 — Apply (`npm run apply`)

1. Opens a Chromium browser and waits for you to log in to LinkedIn (same login flow as Discover).
2. Reads `data/jobs.csv`, removes duplicate URLs, filters by `preferredRoles`, then sorts by `preferredLocations` priority.
3. Skips any job that already has status `applied` in `results.csv` from a previous run.
4. For each job (up to `maxApplicationsPerRun`):
   - Navigates to the job URL in the **same browser session** (so LinkedIn sees you as logged in).
   - Clicks "Easy Apply". If the button is not found, marks the job as `skipped`.
   - Runs the form-filling loop (up to `maxFormSteps` steps):
     - Uploads `resume.pdf` if a file input is present.
     - Fills phone and email from config.
     - Auto-fills profile fields (name, headline, company, years of experience, LinkedIn URL, etc.) by matching form field names/IDs/placeholders against known keywords.
     - Answers the sponsorship Yes/No question if found.
     - Counts unanswered required fields. If any remain and `autoSkipUnansweredRequired` is `true`, marks the job as `skipped`.
     - Otherwise clicks the Next / Review / Continue button to advance.
   - When the Submit button appears, **you confirm the submission manually** (`y` to mark as applied).
5. Appends the result (`applied` / `skipped` / `failed`) and timestamp to `results.csv`.
6. Prompts you to press Enter for the next job, or type `q` to stop early.
7. Waits `delayBetweenJobsSeconds` before opening the next job.

---

## Setup

### Requirements

- Node.js 18+
- npm

### Install

```bash
npm install
npx playwright install chromium
```

### Configure

**1. `config.json`** — runtime settings:

```json
{
  "maxApplicationsPerRun": 15,
  "delayBetweenJobsSeconds": 30,
  "resumePath": "./data/resume.pdf",
  "profilePath": "./data/profile.json",
  "maxFormSteps": 8,
  "autoSkipUnansweredRequired": true,
  "phone": "+91XXXXXXXXXX",
  "email": "you@example.com"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `maxApplicationsPerRun` | no | `15` | Max jobs to attempt per run (≥ 1) |
| `delayBetweenJobsSeconds` | no | `30` | Wait between jobs in seconds (≥ 0) |
| `resumePath` | no | `./data/resume.pdf` | Path to your resume PDF |
| `profilePath` | no | `./data/profile.json` | Path to your profile JSON |
| `maxFormSteps` | no | `8` | Max form pages to navigate before giving up (≥ 1) |
| `autoSkipUnansweredRequired` | no | `true` | Auto-skip jobs that have required fields the tool cannot fill |
| `phone` | **yes** | — | Your phone number (or set `LINKEDIN_PHONE` env var) |
| `email` | no | `""` | Your email (or set `LINKEDIN_EMAIL` env var) |

> **Tip:** To avoid committing credentials, use environment variables instead of putting them in `config.json`:
> ```bash
> LINKEDIN_PHONE='+91XXXXXXXXXX' LINKEDIN_EMAIL='you@example.com' npm run apply
> ```

**2. `data/profile.json`** — your reusable candidate profile:

```json
{
  "preferredRoles": ["Senior Software Engineer", "Full Stack Engineer", "Backend Engineer"],
  "preferredLocations": ["Remote", "Hybrid", "Hyderabad"],
  "firstName": "Your First Name",
  "lastName": "Your Last Name",
  "fullName": "Your Full Name",
  "headline": "Senior Software Engineer at Acme Corp",
  "currentTitle": "Senior Software Engineer",
  "currentCompany": "Acme Corp",
  "yearsOfExperience": 5,
  "city": "Hyderabad",
  "location": "Hyderabad, Telangana",
  "linkedinUrl": "https://www.linkedin.com/in/yourprofile/",
  "workAuthorization": "Authorized to work in India",
  "requiresSponsorship": false,
  "expectedSalary": "25 LPA",
  "noticePeriodDays": 30,
  "additionalInfo": "Brief summary or cover letter text."
}
```

| Field | Purpose |
|---|---|
| `preferredRoles` | Used by Discover to build search queries, and by Apply to filter jobs |
| `preferredLocations` | Used by Discover for search + Apply for ordering (first = highest priority) |
| `firstName`, `lastName`, `fullName` | Filled into name fields |
| `headline`, `currentTitle` | Filled into title/headline fields |
| `currentCompany` | Filled into employer/company fields |
| `yearsOfExperience` | Filled into experience fields |
| `city`, `location` | Filled into location fields |
| `linkedinUrl`, `portfolioUrl`, `githubUrl`, `website` | Filled into respective URL fields |
| `expectedSalary` | Filled into salary/compensation fields |
| `noticePeriodDays` | Filled into notice period fields |
| `workAuthorization` | Filled into work authorization/visa fields |
| `requiresSponsorship` | Answers the sponsorship Yes/No question |
| `additionalInfo` | Filled into cover letter / additional info / summary fields |

**3. `data/resume.pdf`** — your resume. The tool uploads it to any file input it finds on the form.

---

## Running

### Step 1 — Discover jobs

```bash
npm run discover
```

Options:
- `--out <path>` — output CSV path (default: `data/jobs.csv`)
- `--max <n>` — max jobs to collect (default: `60`)
- `--config <path>` — alternate config file

With password pre-fill (password never saved to disk):
```bash
LINKEDIN_PASSWORD='your-password' npm run discover
```

> After running, review `data/jobs.csv` and remove any jobs you do not want to apply to before running the apply step.

### Step 2 — Apply

```bash
npm run apply
```

Options:
- `--file <path>` — jobs CSV path (default: `data/jobs.csv`)
- `--config <path>` — alternate config file

---

## Results

Each application attempt is logged to `results.csv` in the project root:

```
job_url,status,timestamp
https://www.linkedin.com/jobs/view/123,applied,2026-03-15T10:00:00.000Z
https://www.linkedin.com/jobs/view/456,skipped,2026-03-15T10:05:00.000Z
```

| Status | Meaning |
|---|---|
| `applied` | You manually confirmed submission |
| `skipped` | Easy Apply not found, required fields unanswered, or you chose to skip |
| `failed` | An unexpected error occurred (will be retried on next run) |

On subsequent runs, jobs with status `applied` are automatically skipped. Jobs with status `failed` or `skipped` are retried.

---

## Safety

- **Final submission is always manual.** The tool never clicks Submit on your behalf — it stops and asks you to review and submit, then confirm with `y`.
- The browser runs in **headed mode** (visible) so you can see exactly what is happening at every step.
- Type `q` at any prompt to stop the run immediately.
- `autoSkipUnansweredRequired: true` protects you from accidentally submitting incomplete forms.

---

## Type Check

```bash
npm run check
```