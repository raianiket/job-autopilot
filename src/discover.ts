import fs from "node:fs";
import path from "node:path";
import { createBrowser, createContext, createPage, waitForLinkedInLogin, isSessionValid, saveSession } from "./browser";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { scoreJobs } from "./score";
import { JobRow } from "./types";

interface CliArgs {
  config?: string;
  outFile: string;
  maxJobs: number;
  maxPerRole: number;
  roles: string[];
}

interface RawJob {
  job_url: string;
  job_title: string;
  company: string;
  location: string;
  apply_type: "easy_apply" | "external";
  posted_at: string;
  linkedin_score: string;
}

function parseArgs(argv: string[]): CliArgs {
  let config: string | undefined;
  let outFile = "data/jobs.csv";
  let maxJobs = 100;
  let maxPerRole = 10;
  const roles: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--config" && argv[i + 1]) { config = argv[i + 1]; i += 1; continue; }
    if (token === "--out" && argv[i + 1]) { outFile = argv[i + 1]; i += 1; continue; }
    if (token === "--max" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) maxJobs = parsed;
      i += 1; continue;
    }
    if (token === "--per-role" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) maxPerRole = parsed;
      i += 1; continue;
    }
    if (token === "--roles" && argv[i + 1]) {
      roles.push(...argv[i + 1].split(",").map((r) => r.trim()).filter(Boolean));
      i += 1; continue;
    }
  }

  return { config, outFile, maxJobs, maxPerRole, roles };
}

function csvEscape(value: string): string {
  const normalized = value.replaceAll('"', '""');
  return `"${normalized}"`;
}

function writeJobsCsv(outFile: string, jobs: JobRow[]): void {
  const resolved = path.resolve(process.cwd(), outFile);
  const rows = ["job_title,company,job_url,location,apply_type,role_category,linkedin_score,score,reason,posted_at,fetched_at"];

  for (const job of jobs) {
    rows.push(
      [
        csvEscape(job.job_title),
        csvEscape(job.company),
        csvEscape(job.job_url),
        csvEscape(job.location),
        csvEscape(job.apply_type ?? ""),
        csvEscape(job.role_category ?? ""),
        csvEscape(job.linkedin_score ?? ""),
        csvEscape(String(job.score ?? "")),
        csvEscape(job.reason ?? ""),
        csvEscape(job.posted_at ?? ""),
        csvEscape(job.fetched_at ?? ""),
      ].join(",")
    );
  }

  fs.writeFileSync(resolved, `${rows.join("\n")}\n`, "utf-8");

  // Also upsert into persistent history so the dashboard never loses job details
  const historyFile = path.resolve(path.dirname(resolved), "jobs_history.csv");
  const existingUrls = new Set<string>();
  const header = rows[0];
  if (fs.existsSync(historyFile)) {
    const existing = fs.readFileSync(historyFile, "utf-8").split("\n").slice(1);
    for (const line of existing) {
      if (!line.trim()) continue;
      // Extract URL (3rd field, index 2) — fields are all quoted
      const parts = line.match(/"(?:[^"]|"")*"/g) ?? [];
      if (parts[2]) existingUrls.add(parts[2].replace(/^"|"$/g, ""));
    }
  }
  const newRows = rows.slice(1).filter((r) => {
    const parts = r.match(/"(?:[^"]|"")*"/g) ?? [];
    const url = parts[2]?.replace(/^"|"$/g, "") ?? "";
    return url && !existingUrls.has(url);
  });
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, `${header}\n`, "utf-8");
  }
  if (newRows.length > 0) {
    fs.appendFileSync(historyFile, `${newRows.join("\n")}\n`, "utf-8");
  }
}

function normalizeLinkedInJobUrl(url: string): string {
  const clean = url.split("?")[0].trim();
  if (!clean.startsWith("http")) {
    return `https://www.linkedin.com${clean}`;
  }
  return clean;
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
      var cardText = card ? (card.textContent || '') : '';
      var easyApply = /easy apply/i.test(cardText) ||
        !!(card && card.querySelector('[aria-label*="Easy Apply" i], .job-card-container__apply-method, [class*="easy-apply"], li-icon[type="linkedin-bug"]'));
      var timeEl = card && card.querySelector('time[datetime]');
      var posted_at = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
      // LinkedIn shows a match score like "Skills match" or a % badge
      var matchEl = card && card.querySelector('[class*="match"], [class*="skill-match"], [aria-label*="match" i], [aria-label*="skills" i]');
      var linkedin_score = matchEl ? (matchEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      jobs.push({ job_url: href.trim(), job_title: title, company: company, location: location, apply_type: easyApply ? 'easy_apply' : 'external', posted_at: posted_at, linkedin_score: linkedin_score });
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

  const browser = await createBrowser(config.headless, config.browserSlowMo);
  const context = await createContext(browser);
  const page = await createPage(context);

  try {
    if (!isSessionValid()) {
      console.log("Opening LinkedIn login page...");
      await page.goto("https://www.linkedin.com/login", { waitUntil: "networkidle" });

      if (config.email) {
        const emailInput = page.locator('input[name="session_key"], input#username').first();
        await emailInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        if (await emailInput.count()) {
          await emailInput.fill(config.email);
          console.log(`Pre-filled email: ${config.email}`);
        }
      }

      if (process.env.LINKEDIN_PASSWORD) {
        const passwordInput = page
          .locator('input[name="session_password"], input#password')
          .first();
        await passwordInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
        if (await passwordInput.count()) {
          await passwordInput.fill(process.env.LINKEDIN_PASSWORD);
          console.log("Pre-filled password from LINKEDIN_PASSWORD env var.");
        }
      }

      console.log("Complete the login in the browser. Waiting up to 15 minutes...");
      await waitForLinkedInLogin(page);
      await saveSession(context);
    }

    console.log("Login detected. Starting job discovery...\n");

    const byUrl = new Map<string, JobRow>();
    const countPerRole = new Map<string, number>();

    // Filter roles if --roles flag provided
    const activeRoles = args.roles.length
      ? roles.filter((r) => args.roles.some((a) => r.toLowerCase().includes(a.toLowerCase())))
      : roles;

    if (args.roles.length) {
      console.log(`Running for selected roles: ${activeRoles.join(", ")}\n`);
    }

    for (const role of activeRoles) {
      const roleCount = countPerRole.get(role) ?? 0;
      if (roleCount >= args.maxPerRole) continue;

      const roleBatch: JobRow[] = [];

      for (const location of locations) {
        if (byUrl.size >= args.maxJobs) break;
        if ((countPerRole.get(role) ?? 0) >= args.maxPerRole) break;

        const query = new URLSearchParams({ keywords: role, location, sortBy: "DD" });
        const url = `https://www.linkedin.com/jobs/search/?${query.toString()}`;

        console.log(`[${role}] Searching ${location}...`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1800);
        await scrollResults(page);

        const found = await extractJobsFromPage(page);
        for (const raw of found) {
          if ((countPerRole.get(role) ?? 0) >= args.maxPerRole) break;

          const job_url = normalizeLinkedInJobUrl(raw.job_url);
          if (byUrl.has(job_url)) continue;

          const titleLower = (raw.job_title || "").toLowerCase();
          if (/\b(intern|internship|trainee|fresher|graduate\s+trainee)\b/.test(titleLower)) {
            console.log(`  Skipping intern role: ${raw.job_title}`);
            continue;
          }

          const job: JobRow = {
            job_title: raw.job_title || "Unknown Title",
            company: raw.company || "Unknown Company",
            job_url,
            location: raw.location || "Unknown Location",
            apply_type: raw.apply_type,
            role_category: role,
            linkedin_score: raw.linkedin_score || "",
            posted_at: raw.posted_at || "",
            fetched_at: new Date().toISOString(),
          };

          byUrl.set(job_url, job);
          roleBatch.push(job);
          countPerRole.set(role, (countPerRole.get(role) ?? 0) + 1);
        }
      }

      const roleFound = countPerRole.get(role) ?? 0;
      console.log(`  → ${roleFound} job(s) found for "${role}" — scoring...`);

      // Score just this role's batch, then merge back into byUrl
      const scoredBatch = await scoreJobs(roleBatch, profile, config);
      for (const job of scoredBatch) {
        byUrl.set(job.job_url, job);
      }

      // Write after each role so dashboard updates in real time
      writeJobsCsv(args.outFile, Array.from(byUrl.values()));
      console.log(`  ✓ Written to CSV (total so far: ${byUrl.size})`);
    }

    const finalJobs = Array.from(byUrl.values());
    const easyCount = finalJobs.filter((j) => j.apply_type === "easy_apply").length;
    const externalCount = finalJobs.filter((j) => j.apply_type === "external").length;
    console.log(`\nDone. ${finalJobs.length} job(s) in ${path.resolve(process.cwd(), args.outFile)}`);
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
