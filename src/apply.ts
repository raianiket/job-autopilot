import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserContext, Page } from "playwright";
import { createPage } from "./browser";
import { AppConfig, ApplyResult, ApplyStatus, CandidateProfile, JobRow } from "./types";

const RESULTS_CSV = path.resolve(process.cwd(), "results.csv");

function nowIso(): string {
  return new Date().toISOString();
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function writeResult(result: ApplyResult): void {
  if (!fs.existsSync(RESULTS_CSV)) {
    fs.writeFileSync(RESULTS_CSV, "job_url,status,timestamp\n", "utf-8");
  }

  const row =
    [result.job_url, result.status, result.timestamp].map(csvEscapeField).join(",") + "\n";
  fs.appendFileSync(RESULTS_CSV, row, "utf-8");
}

/**
 * Returns the set of job URLs that were already successfully applied to in a
 * previous run. Failed/skipped jobs are intentionally NOT excluded so they can
 * be retried.
 */
function loadAppliedUrls(): Set<string> {
  const applied = new Set<string>();

  if (!fs.existsSync(RESULTS_CSV)) {
    return applied;
  }

  const lines = fs.readFileSync(RESULTS_CSV, "utf-8").split("\n").slice(1);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    // Format: job_url,status,timestamp  — LinkedIn URLs contain no commas.
    const firstComma = line.indexOf(",");
    if (firstComma === -1) {
      continue;
    }

    const url = line.slice(0, firstComma).replace(/^"|"$/g, "").trim();
    const remainder = line.slice(firstComma + 1);
    const secondComma = remainder.indexOf(",");
    const status = (secondComma === -1 ? remainder : remainder.slice(0, secondComma))
      .replace(/^"|"$/g, "")
      .trim();

    if (status === "applied") {
      applied.add(url);
    }
  }

  return applied;
}

async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function safeFill(page: Page, selectors: string[], value: string): Promise<boolean> {
  if (!value) {
    return false;
  }

  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      try {
        await loc.fill(value);
        return true;
      } catch {
        // Try next selector.
      }
    }
  }

  return false;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value).trim();
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll('"', '\\"');
}

async function safeSelectOrFillByKeywords(
  page: Page,
  keywords: string[],
  rawValue: unknown
): Promise<boolean> {
  const value = asText(rawValue);
  if (!value) {
    return false;
  }

  for (const keyword of keywords) {
    const k = escapeAttributeValue(keyword);
    const selectors = [
      `input[name*="${k}" i]`,
      `input[id*="${k}" i]`,
      `input[placeholder*="${k}" i]`,
      `textarea[name*="${k}" i]`,
      `textarea[id*="${k}" i]`,
      `textarea[placeholder*="${k}" i]`,
      `select[name*="${k}" i]`,
      `select[id*="${k}" i]`
    ];

    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      if (!(await loc.count())) {
        continue;
      }

      try {
        const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
        if (tag === "select") {
          await loc.selectOption({ label: value }).catch(async () => {
            await loc.selectOption({ value });
          });
          return true;
        }

        await loc.fill(value);
        return true;
      } catch {
        // Try alternate selectors.
      }
    }
  }

  return false;
}

async function uploadResumeIfPossible(page: Page, resumePath: string): Promise<void> {
  if (!fs.existsSync(resumePath)) {
    return;
  }

  const fileInput = page.locator('input[type="file"]').first();
  if (!(await fileInput.count())) {
    return;
  }

  try {
    await fileInput.setInputFiles(resumePath);
  } catch {
    // Some forms reject uploads by selector — continue.
  }
}

async function answerBooleanQuestion(
  page: Page,
  keywords: string[],
  answer: boolean | undefined
): Promise<boolean> {
  if (answer === undefined) {
    return false;
  }

  const expected = answer ? /yes/i : /no/i;

  for (const keyword of keywords) {
    // Prefer fieldset (most semantically correct container for radio groups).
    let section = page
      .locator("fieldset")
      .filter({ hasText: new RegExp(keyword, "i") })
      .first();

    if (!(await section.count())) {
      // Fall back to a div that visibly contains a radio/checkbox AND a label with the keyword.
      section = page
        .locator("div")
        .filter({
          has: page.locator("label, legend, span", {
            hasText: new RegExp(keyword, "i")
          })
        })
        .filter({
          has: page.locator('input[type="radio"], input[type="checkbox"]')
        })
        .first();
    }

    if (!(await section.count())) {
      continue;
    }

    const option = section.getByLabel(expected).first();
    if (await option.count()) {
      try {
        await option.check();
        return true;
      } catch {
        try {
          await option.click();
          return true;
        } catch {
          // continue searching
        }
      }
    }
  }

  return false;
}

async function autofillFromProfile(page: Page, profile?: CandidateProfile, coverLetter?: string): Promise<void> {
  if (!profile) {
    return;
  }

  // Fill most-specific field names first to prevent generic keywords from
  // overwriting fields that were already filled by a more specific rule.
  await safeSelectOrFillByKeywords(
    page,
    ["firstname", "first_name", "first-name", "givenname", "given_name", "first", "given"],
    profile.firstName
  );
  await safeSelectOrFillByKeywords(
    page,
    ["lastname", "last_name", "last-name", "familyname", "family_name", "surname", "last", "family"],
    profile.lastName
  );
  await safeSelectOrFillByKeywords(
    page,
    ["fullname", "full_name", "full-name"],
    profile.fullName
  );
  await safeSelectOrFillByKeywords(
    page,
    ["headline", "jobtitle", "job_title", "currenttitle", "current_title", "professionaltitle"],
    profile.headline ?? profile.currentTitle
  );
  await safeSelectOrFillByKeywords(
    page,
    ["currentcompany", "current_company", "companyname", "company_name", "employer", "company"],
    profile.currentCompany
  );
  await safeSelectOrFillByKeywords(page, ["yearofexperience", "years_of_experience", "experience", "years"], profile.yearsOfExperience);
  await safeSelectOrFillByKeywords(page, ["city"], profile.city);
  await safeSelectOrFillByKeywords(page, ["location"], profile.location);
  await safeSelectOrFillByKeywords(page, ["linkedin"], profile.linkedinUrl);
  await safeSelectOrFillByKeywords(page, ["portfolio"], profile.portfolioUrl);
  await safeSelectOrFillByKeywords(page, ["github"], profile.githubUrl);
  await safeSelectOrFillByKeywords(page, ["website"], profile.website);
  await safeSelectOrFillByKeywords(
    page,
    ["salary", "compensation", "expectedctc", "expected_ctc", "ctc"],
    profile.expectedSalary
  );
  await safeSelectOrFillByKeywords(
    page,
    ["noticeperiod", "notice_period", "notice"],
    profile.noticePeriodDays
  );
  await safeSelectOrFillByKeywords(
    page,
    ["workauthorization", "work_authorization", "authorize", "workpermit", "work_permit", "visa"],
    profile.workAuthorization
  );
  await safeSelectOrFillByKeywords(
    page,
    ["additional", "summary", "coverletter", "cover_letter", "cover", "message"],
    coverLetter
  );

  await answerBooleanQuestion(page, ["sponsor", "sponsorship"], profile.requiresSponsorship);
}

async function clickNextIfPresent(page: Page): Promise<boolean> {
  const nextButton = page
    .getByRole("button", { name: /^(next|review|continue)$/i })
    .first();

  if (await nextButton.count()) {
    try {
      await nextButton.click();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(800);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function hasSubmitButton(page: Page): Promise<boolean> {
  const submitButton = page
    .getByRole("button", { name: /submit application|submit|send application/i })
    .first();
  return (await submitButton.count()) > 0;
}

async function getUnansweredRequiredCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const elements = Array.from(doc.querySelectorAll("input, textarea, select")) as any[];

    const isVisible = (el: any): boolean => {
      const style = win.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    let count = 0;

    // Track radio groups by name so the whole group counts as 1 unanswered field,
    // not N (one per radio button). Previously each unchecked radio in a group was
    // counted separately, causing premature skipping.
    const radioGroups = new Map<string, boolean>(); // groupKey -> hasCheckedMember

    for (let i = 0; i < elements.length; i += 1) {
      const el = elements[i];
      if (!isVisible(el) || !el.required || el.disabled) {
        continue;
      }

      const tag = String(el.tagName ?? "").toLowerCase();
      const type = String(el.type ?? "").toLowerCase();

      if (tag === "input" && type === "radio") {
        const groupKey = el.name || `__anon__${i}`;
        if (!radioGroups.has(groupKey)) {
          radioGroups.set(groupKey, false);
        }
        if (el.checked) {
          radioGroups.set(groupKey, true);
        }
        continue;
      }

      if (tag === "input" && type === "checkbox") {
        if (!el.checked) {
          count += 1;
        }
        continue;
      }

      if (!el.value || !String(el.value).trim()) {
        count += 1;
      }
    }

    // Each unanswered radio group counts as 1 missing field.
    for (const answered of radioGroups.values()) {
      if (!answered) {
        count += 1;
      }
    }

    return count;
  });
}

async function fillStandardContactFields(page: Page, config: AppConfig): Promise<void> {
  await safeFill(
    page,
    [
      'input[name*="phone"]',
      'input[id*="phone"]',
      'input[placeholder*="phone" i]',
      'input[type="tel"]'
    ],
    config.phone
  );

  if (config.email) {
    await safeFill(
      page,
      [
        'input[name*="email"]',
        'input[id*="email"]',
        'input[placeholder*="email" i]',
        'input[type="email"]'
      ],
      config.email
    );
  }
}

async function handleApplicationForm(
  page: Page,
  config: AppConfig,
  profile?: CandidateProfile,
  coverLetter?: string
): Promise<ApplyStatus> {
  for (let step = 1; step <= config.maxFormSteps; step += 1) {
    await uploadResumeIfPossible(page, config.resumePath);
    await fillStandardContactFields(page, config);
    await autofillFromProfile(page, profile, coverLetter);

    if (await hasSubmitButton(page)) {
      console.log(`  Reached submit step (step ${step}). Review in browser.`);
      const submitted = await promptLine("  Type 'y' if you submitted manually, anything else to skip: ");
      return /^y(es)?$/i.test(submitted) ? "applied" : "skipped";
    }

    const unansweredRequired = await getUnansweredRequiredCount(page);
    if (config.autoSkipUnansweredRequired && unansweredRequired > 0) {
      console.log(`  Auto-skip: ${unansweredRequired} required field(s) still unanswered.`);
      return "skipped";
    }

    const moved = await clickNextIfPresent(page);
    if (!moved) {
      console.log("  No Next/Review/Continue detected. Leaving for manual review.");
      const reviewed = await promptLine("  Type 'y' if this was successfully handled, anything else to skip: ");
      return /^y(es)?$/i.test(reviewed) ? "applied" : "skipped";
    }
  }

  console.log(`  Reached maxFormSteps (${config.maxFormSteps}) without submit. Skipping.`);
  return "skipped";
}

export async function processJobs(
  jobs: JobRow[],
  config: AppConfig,
  context: BrowserContext,
  profile?: CandidateProfile
): Promise<void> {
  const appliedUrls = loadAppliedUrls();

  const pending = jobs.filter((job) => {
    if (appliedUrls.has(job.job_url)) {
      console.log(`  Skipping (already applied): ${job.job_url}`);
      return false;
    }
    return true;
  });

  if (!pending.length) {
    console.log("All jobs in this list have already been applied to.");
    return;
  }

  const max = Math.min(config.maxApplicationsPerRun, pending.length);
  console.log(`Processing ${max} job(s) (${pending.length - max} deferred by maxApplicationsPerRun limit).`);

  for (let index = 0; index < max; index += 1) {
    const job = pending[index];
    const page = await createPage(context);

    console.log(`\n[${index + 1}/${max}] ${job.job_title} @ ${job.company}`);
    console.log(`  URL: ${job.job_url}`);

    const coverLetter = profile?.coverLetter;
    let status: ApplyStatus = "failed";

    try {
      await page.goto(job.job_url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      const easyApplyButton = page
        .getByRole("button", { name: /easy apply/i })
        .first();

      if (!(await easyApplyButton.count())) {
        console.log("  Easy Apply not found. Skipping.");
        status = "skipped";
      } else {
        await easyApplyButton.click();
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.waitForTimeout(1000);
        status = await handleApplicationForm(page, config, profile, coverLetter);
      }
    } catch (error) {
      console.error(`  Failed on ${job.job_url}:`, error);
      status = "failed";
    }

    // Always record the result and clean up the page regardless of what happened above.
    writeResult({ job_url: job.job_url, status, timestamp: nowIso() });
    console.log(`  Status: ${status}`);

    let response = "";
    try {
      response = await promptLine("\nPress Enter for next job (or type 'q' to stop): ");
    } finally {
      await page.close();
    }

    if (response.toLowerCase() === "q") {
      console.log("Stopped by user.");
      return;
    }

    if (index < max - 1 && config.delayBetweenJobsSeconds > 0) {
      const ms = config.delayBetweenJobsSeconds * 1000;
      console.log(`Waiting ${config.delayBetweenJobsSeconds}s before next job...`);
      await delay(ms);
    }
  }
}
