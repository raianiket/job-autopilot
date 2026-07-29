import fs from "node:fs";
import path from "node:path";
import { createBrowser, createContext, createPage, waitForLinkedInLogin, isSessionValid, saveSession, isAttachedToExistingChrome } from "./browser";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { scoreJobs } from "./score";
import { fetchAggregatorJobs, fetchPortalJobs } from "./sources";
import { writeJobsCsv } from "./jobsCsv";
import { JobRow } from "./types";

interface CliArgs {
  config?: string;
  outFile: string;
  /** Undefined means "use the config value". */
  maxJobs?: number;
  maxPerRole?: number;
  roles: string[];
  /** Fetch company job boards only, never opening a browser or touching LinkedIn. */
  portalsOnly: boolean;
  /** Skip company job boards, LinkedIn only (the original behaviour). */
  skipPortals: boolean;
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
  let maxJobs: number | undefined;
  let maxPerRole: number | undefined;
  const roles: string[] = [];
  let portalsOnly = false;
  let skipPortals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--portals-only") { portalsOnly = true; continue; }
    if (token === "--skip-portals") { skipPortals = true; continue; }
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

  return { config, outFile, maxJobs, maxPerRole, roles, portalsOnly, skipPortals };
}

function normalizeLinkedInJobUrl(url: string): string {
  const clean = url.split("?")[0].trim();
  if (!clean.startsWith("http")) {
    return `https://www.linkedin.com${clean}`;
  }
  return clean;
}


/**
 * LinkedIn virtualizes the results list: the <li> elements all exist, but their
 * contents only render while near the viewport and unrender once scrolled past.
 * Scrolling first and extracting afterwards therefore only ever captures the
 * handful of cards still rendered, which is why this used to return ~7 jobs per
 * search regardless of how many matched. So each card is scrolled into view and
 * read immediately, keyed on data-occludable-job-id.
 */
async function harvestJobsFromPage(
  page: Awaited<ReturnType<typeof createPage>>
): Promise<RawJob[]> {
  // Pass as a string so esbuild never touches it and cannot inject __name helpers.
  return page.evaluate(`(async function () {
    function text(el) {
      return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    var acc = {};

    function grabRendered() {
      var cards = document.querySelectorAll('li[data-occludable-job-id]');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var id = card.getAttribute('data-occludable-job-id');
        if (!id || acc[id]) continue;

        var anchor = card.querySelector('a[href*="/jobs/view/"]');
        var title =
          text(anchor && anchor.querySelector("span[aria-hidden='true']")) ||
          text(card.querySelector('[class*="job-card-list__title"]')) ||
          text(anchor);
        // An unrendered card has no title yet; skip it and catch it on a later pass.
        if (!title) continue;

        var company =
          text(card.querySelector('.artdeco-entity-lockup__subtitle')) ||
          text(card.querySelector('[class*="job-card-container__primary-description"]')) ||
          text(card.querySelector('[class*="subtitle"], [class*="company"]')) ||
          'Unknown Company';
        var location =
          text(card.querySelector('.job-card-container__metadata-item')) ||
          text(card.querySelector('[class*="metadata"] li')) ||
          text(card.querySelector('[class*="metadata"] span')) ||
          'Unknown Location';

        var cardText = card.textContent || '';
        var easyApply = /easy apply/i.test(cardText) ||
          !!card.querySelector('[aria-label*="Easy Apply" i], [class*="easy-apply"]');
        var timeEl = card.querySelector('time[datetime]');
        var matchEl = card.querySelector('[class*="skill-match"], [aria-label*="match" i]');

        acc[id] = {
          job_url: 'https://www.linkedin.com/jobs/view/' + id + '/',
          job_title: title,
          company: company,
          location: location,
          apply_type: easyApply ? 'easy_apply' : 'external',
          posted_at: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
          linkedin_score: matchEl ? text(matchEl) : ''
        };
      }
    }

    // Walk the list, reading each card while it is rendered. Two passes, because
    // reaching the bottom makes LinkedIn append another batch of cards.
    for (var pass = 0; pass < 2; pass++) {
      var cards = document.querySelectorAll('li[data-occludable-job-id]');
      if (!cards.length) break;
      for (var i = 0; i < cards.length; i++) {
        cards[i].scrollIntoView({ block: 'center' });
        await new Promise(function (r) { setTimeout(r, 180); });
        grabRendered();
      }
      await new Promise(function (r) { setTimeout(r, 1200); });
      grabRendered();
      if (document.querySelectorAll('li[data-occludable-job-id]').length === cards.length) break;
    }

    return Object.keys(acc).map(function (k) { return acc[k]; });
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

  const byUrl = new Map<string, JobRow>();

  // ── Company job boards ─────────────────────────────────────────────────────
  // Pure HTTP against public ATS APIs, so this runs before any browser or login.
  if (!args.skipPortals && config.sources.portals.enabled) {
    const portalJobs = await fetchPortalJobs(config, profile);
    const scoredPortal = await scoreJobs(portalJobs, profile, config);
    for (const job of scoredPortal) {
      if (job.job_url) byUrl.set(job.job_url, job);
    }
    if (byUrl.size) {
      writeJobsCsv(args.outFile, Array.from(byUrl.values()));
      console.log(`✓ ${byUrl.size} portal job(s) written to CSV.`);
    }
  }

  // ── Job aggregators ────────────────────────────────────────────────────────
  if (!args.skipPortals && config.sources.aggregators.enabled) {
    const aggJobs = await fetchAggregatorJobs(config, profile);
    const fresh = aggJobs.filter((job) => !byUrl.has(job.job_url));
    const scoredAgg = await scoreJobs(fresh, profile, config);
    for (const job of scoredAgg) {
      if (job.job_url) byUrl.set(job.job_url, job);
    }
    if (fresh.length) {
      writeJobsCsv(args.outFile, Array.from(byUrl.values()));
      console.log(`✓ ${fresh.length} aggregator job(s) added (total ${byUrl.size}).`);
    }
  }

  if (args.portalsOnly || !config.sources.linkedin.enabled) {
    console.log(
      `\nDone (portals only). ${byUrl.size} job(s) in ${path.resolve(process.cwd(), args.outFile)}`
    );
    return;
  }

  // ── LinkedIn ───────────────────────────────────────────────────────────────
  const browser = await createBrowser(config.headless, config.browserSlowMo);
  const context = await createContext(browser);
  const page = await createPage(context);

  try {
    if (!isSessionValid() && !isAttachedToExistingChrome()) {
      console.log("Opening LinkedIn login page...");
      await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });

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

    console.log("Login detected. Starting LinkedIn discovery...\n");

    const countPerRole = new Map<string, number>();
    // maxJobs caps the LinkedIn scrape only; portal jobs already in byUrl must not
    // count against it or a big portal haul would skip LinkedIn entirely.
    const portalCount = byUrl.size;
    const maxJobs = args.maxJobs ?? config.sources.linkedin.maxJobs;
    const maxPerRole = args.maxPerRole ?? config.sources.linkedin.maxPerRole;

    // Filter roles if --roles flag provided
    const activeRoles = args.roles.length
      ? roles.filter((r) => args.roles.some((a) => r.toLowerCase().includes(a.toLowerCase())))
      : roles;

    if (args.roles.length) {
      console.log(`Running for selected roles: ${activeRoles.join(", ")}\n`);
    }

    for (const role of activeRoles) {
      const roleCount = countPerRole.get(role) ?? 0;
      if (roleCount >= maxPerRole) continue;

      const roleBatch: JobRow[] = [];

      for (const location of locations) {
        if (byUrl.size - portalCount >= maxJobs) break;
        if ((countPerRole.get(role) ?? 0) >= maxPerRole) break;

        const query = new URLSearchParams({ keywords: role, location, sortBy: "DD" });
        const url = `https://www.linkedin.com/jobs/search/?${query.toString()}`;

        console.log(`[${role}] Searching ${location}...`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1800);

        const found = await harvestJobsFromPage(page);
        for (const raw of found) {
          if ((countPerRole.get(role) ?? 0) >= maxPerRole) break;

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
            source: "linkedin",
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
