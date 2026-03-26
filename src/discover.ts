import fs from "node:fs";
import path from "node:path";
import { createBrowser, createContext, createPage, waitForLinkedInLogin } from "./browser";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { scoreJobs } from "./score";
import { JobRow } from "./types";

interface CliArgs {
  config?: string;
  outFile: string;
  maxJobs: number;
}

interface RawJob {
  job_url: string;
  job_title: string;
  company: string;
  location: string;
  apply_type: "easy_apply" | "external";
}

function parseArgs(argv: string[]): CliArgs {
  let config: string | undefined;
  let outFile = "data/jobs.csv";
  let maxJobs = 60;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--config" && argv[i + 1]) {
      config = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--out" && argv[i + 1]) {
      outFile = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--max" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        maxJobs = parsed;
      }
      i += 1;
    }
  }

  return { config, outFile, maxJobs };
}

function csvEscape(value: string): string {
  const normalized = value.replaceAll('"', '""');
  return `"${normalized}"`;
}

function writeJobsCsv(outFile: string, jobs: JobRow[]): void {
  const resolved = path.resolve(process.cwd(), outFile);
  const rows = ["job_title,company,job_url,location,apply_type,score,reason"];

  for (const job of jobs) {
    rows.push(
      [
        csvEscape(job.job_title),
        csvEscape(job.company),
        csvEscape(job.job_url),
        csvEscape(job.location),
        csvEscape(job.apply_type ?? ""),
        csvEscape(String(job.score ?? "")),
        csvEscape(job.reason ?? ""),
      ].join(",")
    );
  }

  fs.writeFileSync(resolved, `${rows.join("\n")}\n`, "utf-8");
}

function normalizeLinkedInJobUrl(url: string): string {
  const clean = url.split("?")[0].trim();
  if (!clean.startsWith("http")) {
    return `https://www.linkedin.com${clean}`;
  }
  return clean;
}

function buildSearchUrls(roles: string[], locations: string[]): string[] {
  const deduped = new Set<string>();

  for (const role of roles) {
    for (const location of locations) {
      const query = new URLSearchParams({
        keywords: role,
        location,
        sortBy: "DD"
      });
      deduped.add(`https://www.linkedin.com/jobs/search/?${query.toString()}`);
    }
  }

  return Array.from(deduped);
}

async function scrollResults(page: Awaited<ReturnType<typeof createPage>>): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(700);
  }
}

async function extractJobsFromPage(
  page: Awaited<ReturnType<typeof createPage>>
): Promise<RawJob[]> {
  // Pass as a string so esbuild never touches it and cannot inject __name helpers.
  return page.evaluate(`(function () {
    function text(el) {
      return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    var anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
    var jobs = [];
    var seen = new Set();
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var href = anchor.getAttribute('href');
      if (!href) continue;
      var key = href.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      var card = anchor.closest('li, div.job-card-container, div.jobs-search-results__list-item');
      var title =
        text(anchor.querySelector("span[aria-hidden='true']")) ||
        text(anchor.querySelector('span')) ||
        text(card && card.querySelector('h3 span, h3')) ||
        text(anchor) ||
        'Unknown Title';
      var company =
        text(card && card.querySelector('.job-card-container__primary-description')) ||
        text(card && card.querySelector('.base-search-card__subtitle')) ||
        text(card && card.querySelector('h4 a, h4')) ||
        text(card && card.querySelector('[class*="subtitle"], [class*="company"]')) ||
        'Unknown Company';
      var location =
        text(card && card.querySelector('.job-search-card__location')) ||
        text(card && card.querySelector('[class*="location"]')) ||
        text(card && card.querySelector('[class*="metadata"] span')) ||
        'Unknown Location';
      var easyApply = !!(card && card.querySelector('[aria-label*="Easy Apply" i], .job-card-container__apply-method'));
      jobs.push({ job_url: href.trim(), job_title: title, company: company, location: location, apply_type: easyApply ? 'easy_apply' : 'external' });
    }
    return jobs;
  })()`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const profile = loadProfile(config.profilePath);

  const roles = profile?.preferredRoles?.filter(Boolean) ?? [];
  const locations = profile?.preferredLocations?.filter(Boolean) ?? [];

  if (!roles.length) {
    throw new Error("No preferredRoles in profile.json. Add at least one role.");
  }

  if (!locations.length) {
    throw new Error("No preferredLocations in profile.json. Add at least one location.");
  }

  const searchUrls = buildSearchUrls(roles, locations);
  const browser = await createBrowser(config.headless, config.browserSlowMo);
  const context = await createContext(browser);
  const page = await createPage(context);

  try {
    console.log("Opening LinkedIn login page...");
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

    if (config.email) {
      const emailInput = page.locator('input[name="session_key"], input#username').first();
      if (await emailInput.count()) {
        await emailInput.fill(config.email);
        console.log(`Pre-filled email: ${config.email}`);
      }
    }

    if (process.env.LINKEDIN_PASSWORD) {
      const passwordInput = page
        .locator('input[name="session_password"], input#password')
        .first();
      if (await passwordInput.count()) {
        await passwordInput.fill(process.env.LINKEDIN_PASSWORD);
        console.log("Pre-filled password from LINKEDIN_PASSWORD env var.");
      }
    }

    console.log("Complete the login in the browser. Waiting up to 15 minutes...");
    await waitForLinkedInLogin(page);
    console.log("Login detected. Starting job discovery...\n");

    const byUrl = new Map<string, JobRow>();

    for (const url of searchUrls) {
      if (byUrl.size >= args.maxJobs) {
        break;
      }

      console.log(`Searching: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1800);
      await scrollResults(page);

      const found = await extractJobsFromPage(page);
      for (const raw of found) {
        const job_url = normalizeLinkedInJobUrl(raw.job_url);
        if (byUrl.has(job_url)) {
          continue;
        }

        // Skip intern / trainee / fresher roles
        const titleLower = (raw.job_title || "").toLowerCase();
        if (/\b(intern|internship|trainee|fresher|graduate\s+trainee)\b/.test(titleLower)) {
          console.log(`  Skipping intern role: ${raw.job_title}`);
          continue;
        }

        byUrl.set(job_url, {
          job_title: raw.job_title || "Unknown Title",
          company: raw.company || "Unknown Company",
          job_url,
          location: raw.location || "Unknown Location",
          apply_type: raw.apply_type,
        });

        if (byUrl.size >= args.maxJobs) {
          break;
        }
      }
    }

    const jobs = Array.from(byUrl.values());
    const profile = loadProfile(config.profilePath);
    const finalJobs = await scoreJobs(jobs, profile, config);
    writeJobsCsv(args.outFile, finalJobs);
    const easyCount = finalJobs.filter((j) => j.apply_type === "easy_apply").length;
    const externalCount = finalJobs.filter((j) => j.apply_type === "external").length;
    console.log(`\nWrote ${finalJobs.length} job(s) to ${path.resolve(process.cwd(), args.outFile)}`);
    console.log(`  Easy Apply: ${easyCount} | External: ${externalCount} (apply manually)`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Discover failed:", error);
  process.exitCode = 1;
});
