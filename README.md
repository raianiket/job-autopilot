# job-autopilot

Automates LinkedIn Easy Apply — discovers jobs matching your roles and locations, fills forms from your profile, and lets you confirm every submission manually.

Built with Node.js, TypeScript, and Playwright.

---

## How It Works

Two phases:

### Phase 1 — Discover
Searches LinkedIn Jobs for every combination of your `preferredRoles` × `preferredLocations`, scrolls results to load more listings, and writes unique jobs to `data/jobs.csv`.

### Phase 2 — Apply
Reads `data/jobs.csv`, filters by role, sorts by location priority, and for each job:
- Clicks Easy Apply
- Uploads your resume
- Fills form fields from `profile.json` (name, phone, email, experience, cover letter, etc.)
- Answers the sponsorship question automatically
- Skips jobs with unanswered required fields (configurable)
- **Stops at the Submit button — you review and confirm manually**
- Logs every result to `results.csv`

Jobs already marked `applied` are skipped on subsequent runs. Jobs marked `failed` or `skipped` are retried.

---

## Setup

**Requirements:** Node.js 18+, npm

```bash
npm install
npx playwright install chromium
```

---

## Configuration

### 1. `config.json`

Copy `config.example.json` and fill in your details:

```json
{
  "phone": "+91XXXXXXXXXX",
  "email": "you@example.com"
}
```

All other fields have defaults. Only `phone` is required.

| Field | Default | Description |
|---|---|---|
| `phone` | — | **Required.** Your phone number |
| `email` | `""` | Your email address |
| `resumePath` | `./data/resume.pdf` | Path to your resume PDF |
| `profilePath` | `./data/profile.json` | Path to your profile JSON |
| `maxApplicationsPerRun` | `15` | Max jobs to attempt per run |
| `delayBetweenJobsSeconds` | `30` | Wait between jobs (seconds) |
| `maxFormSteps` | `8` | Max form steps before giving up |
| `autoSkipUnansweredRequired` | `true` | Skip jobs with unfillable required fields |
| `headless` | `false` | Run browser in headless mode |
| `browserSlowMo` | `100` | Slow down browser actions (ms) |
| `claudeModel` | `""` | AI model for post generation (e.g. `claude-opus-4-6`) |

> Credentials can also be set via env vars to avoid storing them in a file:
> ```bash
> LINKEDIN_PHONE='+91XXXXXXXXXX' LINKEDIN_EMAIL='you@example.com' npm run apply
> ```

### 2. `data/profile.json`

Your candidate profile — used to fill form fields and filter/sort jobs.

```json
{
  "preferredRoles": ["Senior Software Engineer", "Backend Engineer"],
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
  "portfolioUrl": "https://yourportfolio.com",
  "githubUrl": "https://github.com/yourusername",
  "workAuthorization": "Authorized to work in India",
  "requiresSponsorship": false,
  "expectedSalary": "25 LPA",
  "noticePeriodDays": 30,
  "coverLetter": "Dear Hiring Team, ..."
}
```

| Field | Purpose |
|---|---|
| `preferredRoles` | Discover search queries + Apply role filter |
| `preferredLocations` | Discover search + Apply sort order (first = highest priority) |
| `firstName`, `lastName`, `fullName` | Name fields |
| `headline`, `currentTitle` | Title / headline fields |
| `currentCompany` | Employer / company fields |
| `yearsOfExperience` | Experience fields |
| `city`, `location` | Location fields |
| `linkedinUrl`, `portfolioUrl`, `githubUrl`, `website` | URL fields |
| `expectedSalary` | Salary / compensation fields |
| `noticePeriodDays` | Notice period fields |
| `workAuthorization` | Work authorization / visa fields |
| `requiresSponsorship` | Answers the sponsorship Yes/No question |
| `coverLetter` | Cover letter / additional info / message fields |

### 3. `data/resume.pdf`

Your resume. Uploaded to any file input found on the form.

---

## Usage

### Step 1 — Discover jobs

```bash
npm run discover
```

Options:
| Flag | Default | Description |
|---|---|---|
| `--max <n>` | `60` | Max jobs to collect |
| `--out <path>` | `data/jobs.csv` | Output CSV path |
| `--config <path>` | `config.json` | Alternate config file |

> Review `data/jobs.csv` after discovery and remove any jobs you don't want to apply to.

### Step 2 — Apply

```bash
npm run apply
```

Options:
| Flag | Default | Description |
|---|---|---|
| `--file <path>` | `data/jobs.csv` | Jobs CSV to process |
| `--config <path>` | `config.json` | Alternate config file |

### Optional — Generate a LinkedIn post

```bash
npm run post
```

Uses Claude (requires `ANTHROPIC_API_KEY` and `claudeModel` in config) to write and publish a LinkedIn post. Supports `--content`, `--content-file`, `--image`, and `--yes` flags.

---

## Results

Logged to `results.csv`:

```
job_url,status,timestamp
https://www.linkedin.com/jobs/view/123,applied,2026-03-15T10:00:00.000Z
https://www.linkedin.com/jobs/view/456,skipped,2026-03-15T10:05:00.000Z
```

| Status | Meaning |
|---|---|
| `applied` | You confirmed the submission |
| `skipped` | Easy Apply not found, unfillable required fields, or manually skipped |
| `failed` | Unexpected error — retried on next run |

---

## Safety

- **Final submission is always manual** — the tool stops at the Submit button and asks you to confirm with `y`
- Browser runs **headed** (visible) by default so you can see every action
- Type `q` at any prompt to stop immediately
- `autoSkipUnansweredRequired: true` prevents submitting incomplete forms

---

## Type Check

```bash
npm run check
```
