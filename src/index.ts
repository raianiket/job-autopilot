import { createBrowser, createContext, createPage, waitForLinkedInLogin } from "./browser";
import { loadConfig } from "./config";
import { readJobs } from "./csvReader";
import { processJobs } from "./apply";
import { loadProfile } from "./profile";
import { JobRow } from "./types";

interface CliArgs {
  file: string;
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let file = "data/jobs.csv";
  let config: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file" && argv[i + 1]) {
      file = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--config" && argv[i + 1]) {
      config = argv[i + 1];
      i += 1;
    }
  }

  return { file, config };
}

function deduplicateByUrl(jobs: JobRow[]): JobRow[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.job_url)) {
      return false;
    }
    seen.add(job.job_url);
    return true;
  });
}

function filterJobsByPreferredRoles(jobs: JobRow[], preferredRoles?: string[]): JobRow[] {
  if (!preferredRoles?.length) {
    return jobs;
  }

  const normalized = preferredRoles
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);

  if (!normalized.length) {
    return jobs;
  }

  return jobs.filter((job) => {
    const title = job.job_title.toLowerCase();
    return normalized.some((role) => title.includes(role));
  });
}

function getLocationPriority(job: JobRow, preferredLocations?: string[]): number {
  if (!preferredLocations?.length) {
    return Number.MAX_SAFE_INTEGER;
  }

  const location = (job.location ?? "").toLowerCase();
  const matchIndex = preferredLocations.findIndex((item) =>
    location.includes(item.trim().toLowerCase())
  );

  return matchIndex === -1 ? preferredLocations.length : matchIndex;
}

function sortJobsByLocationPriority(jobs: JobRow[], preferredLocations?: string[]): JobRow[] {
  if (!preferredLocations?.length) {
    return jobs;
  }

  return jobs
    .map((job, idx) => ({ job, idx, priority: getLocationPriority(job, preferredLocations) }))
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.idx - b.idx;
    })
    .map((entry) => entry.job);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  const profile = loadProfile(cfg.profilePath);
  const rawJobs = readJobs(args.file);
  const jobs = deduplicateByUrl(rawJobs);

  if (!jobs.length) {
    console.log("No jobs found in CSV.");
    return;
  }

  const filteredJobs = filterJobsByPreferredRoles(jobs, profile?.preferredRoles);

  if (!filteredJobs.length) {
    console.log("No jobs matched preferred roles in profile. Check job titles or preferredRoles.");
    return;
  }

  const prioritizedJobs = sortJobsByLocationPriority(filteredJobs, profile?.preferredLocations);

  console.log(`Loaded ${jobs.length} job(s) from ${args.file}`);

  if (rawJobs.length !== jobs.length) {
    console.log(`Removed ${rawJobs.length - jobs.length} duplicate URL(s).`);
  }

  if (profile?.preferredRoles?.length) {
    console.log(`Role filter: ${profile.preferredRoles.join(", ")}`);
    console.log(`Matched ${filteredJobs.length} job(s) after role filtering.`);
  }

  if (profile?.preferredLocations?.length) {
    console.log(`Location priority: ${profile.preferredLocations.join(" > ")}`);
  }

  if (profile) {
    console.log(`Profile: ${cfg.profilePath}`);
  } else {
    console.log(`Profile not found at ${cfg.profilePath}. Continuing with config-only autofill.`);
  }

  const browser = await createBrowser(cfg.headless, cfg.browserSlowMo);
  const context = await createContext(browser);

  try {
    // ── Login ────────────────────────────────────────────────────────────────
    const loginPage = await createPage(context);
    console.log("\nOpening LinkedIn login page...");
    await loginPage.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

    if (cfg.email) {
      const emailInput = loginPage
        .locator('input[name="session_key"], input#username')
        .first();
      if (await emailInput.count()) {
        await emailInput.fill(cfg.email);
        console.log(`Pre-filled email: ${cfg.email}`);
      }
    }

    if (process.env.LINKEDIN_PASSWORD) {
      const passwordInput = loginPage
        .locator('input[name="session_password"], input#password')
        .first();
      if (await passwordInput.count()) {
        await passwordInput.fill(process.env.LINKEDIN_PASSWORD);
        console.log("Pre-filled password from LINKEDIN_PASSWORD env var.");
      }
    }

    console.log("Complete the login in the browser, then wait — the script will continue automatically.");
    await waitForLinkedInLogin(loginPage);
    await loginPage.close();
    console.log("Login detected. Starting applications...\n");

    // ── Apply ────────────────────────────────────────────────────────────────
    await processJobs(prioritizedJobs, cfg, context, profile);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
