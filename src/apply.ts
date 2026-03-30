import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { BrowserContext, Page } from "playwright";
import { createPage } from "./browser";
import { getSupabaseClient } from "./supabase";
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

    if (status === "applied" || status === "skipped" || status === "failed") {
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

async function uploadFileIfPossible(page: Page, filePath: string, inputSelector: string): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  const fileName = path.basename(filePath);

  // If already selected in a list (LinkedIn/SmartRecruiters radio list), skip
  const selected = await page.evaluate(`(function(name) {
    var radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (var i = 0; i < radios.length; i++) {
      var radio = radios[i];
      var container = radio.closest('li, div[class*="resume"], div[class*="cover"], label') || radio.parentElement;
      if (container && container.textContent && container.textContent.includes(name)) {
        if (radio.checked) return 'already-selected';
        radio.click();
        return 'selected';
      }
    }
    return 'not-found';
  })('${fileName.replace(/'/g, "\\'")}')`);

  if (selected === 'already-selected' || selected === 'selected') return;

  const fileInput = page.locator(inputSelector).first();
  if (!(await fileInput.count())) return;

  try {
    await fileInput.setInputFiles(filePath);
  } catch {
    // Form rejected upload — continue.
  }
}

async function uploadResumeIfPossible(page: Page, resumePath: string): Promise<void> {
  await uploadFileIfPossible(page, resumePath, 'input[type="file"]');
}

async function uploadCoverLetterIfPossible(page: Page, coverLetterPath: string): Promise<void> {
  if (!fs.existsSync(coverLetterPath)) return;

  const fileName = path.basename(coverLetterPath);
  const alreadyUploaded = await page.evaluate(`document.body.innerText.includes('${fileName.replace(/'/g, "\\'")}')`);
  if (alreadyUploaded) return;

  const hasCoverSection = await page.evaluate(`/cover letter/i.test(document.body.innerText)`);
  if (!hasCoverSection) return;

  // Strategy 1: find hidden file input directly inside the cover letter section
  const coverSection = page.locator("div, section, li").filter({ hasText: /cover letter/i }).last();
  const coverInput = coverSection.locator('input[type="file"]').first();
  if (await coverInput.count()) {
    try {
      await coverInput.setInputFiles(coverLetterPath, { noWaitAfter: true });
      console.log(`  Cover letter uploaded (direct input): ${fileName}`);
      await page.waitForTimeout(500);
      return;
    } catch { /* fall through */ }
  }

  // Strategy 2: click "Upload cover letter" button and intercept file chooser
  const uploadBtn = page.locator("button, a, span, div[role='button']").filter({ hasText: /upload cover letter/i }).first();
  if (!(await uploadBtn.count())) return;

  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }),
      uploadBtn.click({ force: true }),
    ]);
    await fileChooser.setFiles(coverLetterPath);
    console.log(`  Cover letter uploaded (file chooser): ${fileName}`);
    await page.waitForTimeout(500);
  } catch {
    // Strategy 3: try all file inputs except the first (which is the resume)
    const allInputs = page.locator('input[type="file"]');
    const count = await allInputs.count();
    for (let i = 1; i < count; i++) {
      try {
        await allInputs.nth(i).setInputFiles(coverLetterPath, { noWaitAfter: true });
        console.log(`  Cover letter uploaded (input[${i}]): ${fileName}`);
        await page.waitForTimeout(500);
        return;
      } catch { continue; }
    }
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

interface FormQuestion {
  id: string;
  question: string;
  type: "radio" | "select" | "checkbox" | "text";
  options: string[];
}

// Extracts all unanswered required questions from the page
async function extractUnansweredQuestions(page: Page): Promise<FormQuestion[]> {
  return page.evaluate(`(function() {
    var questions = [];
    var seen = new Set();

    // Radio groups
    var radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    var groups = {};
    radios.forEach(function(r) {
      var name = r.name || r.id;
      if (!groups[name]) groups[name] = [];
      groups[name].push(r);
    });
    Object.keys(groups).forEach(function(name) {
      var group = groups[name];
      var answered = group.some(function(r) { return r.checked; });
      if (answered) return;
      var first = group[0];
      var container = first.closest('fieldset, div[role], div, li') || first.parentElement;
      var label = container ? (container.querySelector('legend, label, p, span') || container) : first;
      var qtext = (label.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      if (!qtext || seen.has(qtext)) return;
      seen.add(qtext);
      var options = group.map(function(r) {
        var lbl = document.querySelector('label[for="' + r.id + '"]');
        return (lbl ? lbl.textContent : r.value || '').trim();
      }).filter(Boolean);
      questions.push({ id: name, question: qtext, type: 'radio', options: options });
    });

    // Text inputs (short-answer questions like "years of experience")
    var textInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], textarea'));
    textInputs.forEach(function(inp) {
      if ((inp.value || '').trim()) return; // already filled
      var container = inp.closest('fieldset, div, li') || inp.parentElement;
      var label = document.querySelector('label[for="' + inp.id + '"]') ||
        (container ? container.querySelector('label, legend, p, span') : null);
      var qtext = (label ? label.textContent : inp.placeholder || inp.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!qtext || seen.has(qtext)) return;
      seen.add(qtext);
      questions.push({ id: inp.id || inp.name || 'text-inp', question: qtext, type: 'text', options: [] });
    });

    // Selects
    var selects = Array.from(document.querySelectorAll('select'));
    selects.forEach(function(sel) {
      var val = sel.value;
      if (val && val !== '' && val !== 'SELECT') return;
      var container = sel.closest('fieldset, div, li') || sel.parentElement;
      var label = document.querySelector('label[for="' + sel.id + '"]') ||
        (container ? container.querySelector('label, legend, p, span') : null);
      var qtext = (label ? label.textContent : sel.name || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      if (!qtext || seen.has(qtext)) return;
      seen.add(qtext);
      var options = Array.from(sel.options).map(function(o) { return o.text.trim(); }).filter(function(t) { return t && !/select/i.test(t); });
      questions.push({ id: sel.id || sel.name, question: qtext, type: 'select', options: options });
    });

    // Unchecked declaration/consent checkboxes
    var checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    checkboxes.forEach(function(cb) {
      if (cb.checked) return;
      var parent = cb.closest('div, li, label') || cb.parentElement;
      var txt = (parent ? parent.textContent : '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      if (/declare|confirm|agree|consent|certify|acknowledge/i.test(txt) && !seen.has(txt)) {
        seen.add(txt);
        questions.push({ id: cb.id || cb.name || 'checkbox', question: txt, type: 'checkbox', options: ['Confirmed'] });
      }
    });

    return questions;
  })()`) as Promise<FormQuestion[]>;
}

// Uses Claude to answer form questions based on the candidate profile
async function answerPageQuestions(page: Page, profile: CandidateProfile, config: AppConfig): Promise<void> {
  const questions = await extractUnansweredQuestions(page);
  if (!questions.length) return;

  // Auto-check declaration checkboxes without calling Claude
  const declarations = questions.filter((q) => q.type === "checkbox");
  const toAsk = questions.filter((q) => q.type !== "checkbox");

  if (declarations.length) {
    await page.evaluate(`(function() {
      var checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach(function(cb) {
        if (!cb.checked) {
          var parent = cb.closest('div, li, label') || cb.parentElement;
          var txt = (parent ? parent.textContent : '').toLowerCase();
          if (/declare|confirm|agree|consent|certify|acknowledge/i.test(txt)) cb.click();
        }
      });
    })()`);
  }

  if (!toAsk.length) return;

  // Ask Claude to answer based on profile
  const client = new Anthropic();
  const profileSummary = JSON.stringify({
    name: profile.fullName,
    location: profile.location,
    workAuthorization: profile.workAuthorization,
    requiresSponsorship: profile.requiresSponsorship,
    noticePeriod: profile.noticePeriod,
    yearsOfExperience: profile.yearsOfExperience,
    expectedSalary: profile.expectedSalary,
    currentCompany: profile.currentCompany,
  });

  const skills = (profile.skills ?? []).map((s) => s.toLowerCase());

  const questionsText = toAsk.map((q, i) =>
    `${i + 1}. [${q.type}] ${q.question}\n   Options: ${q.options.join(", ")}`
  ).join("\n");

  let aiResponse: string;
  try {
    const msg = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `You are filling out a job application form for this candidate:\n${profileSummary}\nSkills: ${skills.join(", ")}\n\nAnswer these form questions. Reply with ONLY a JSON array like:\n[{"id":"fieldId","answer":"exact option text or number"}]\n\nRules for text/number inputs about experience:\n- If the skill/technology is in the candidate's skill list → answer "5"\n- If the skill/technology is NOT in the candidate's skill list → answer "1"\n- For yes/no questions → answer based on profile\n- For dropdown/radio questions → pick the closest matching option\n\nQuestions:\n${questionsText}`,
      }],
    });
    aiResponse = (msg.content[0] as { text: string }).text.trim();
  } catch {
    return;
  }

  let answers: { id: string; answer: string }[] = [];
  try {
    const match = aiResponse.match(/\[[\s\S]*\]/);
    if (match) answers = JSON.parse(match[0]);
  } catch {
    return;
  }

  for (const ans of answers) {
    const q = toAsk.find((q) => q.id === ans.id);
    if (!q) continue;

    await page.evaluate(`(function(id, answer, type) {
      function findByIdOrName(id) {
        return document.getElementById(id) || document.querySelector('[name="' + id + '"]');
      }
      if (type === 'radio') {
        var radios = Array.from(document.querySelectorAll('input[type="radio"][name="' + id + '"], input[type="radio"][id="' + id + '"]'));
        if (!radios.length) radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        for (var i = 0; i < radios.length; i++) {
          var r = radios[i];
          var lbl = document.querySelector('label[for="' + r.id + '"]');
          var text = (lbl ? lbl.textContent : r.value || '').trim().toLowerCase();
          if (text === answer.toLowerCase()) { r.click(); break; }
        }
      } else if (type === 'select') {
        var sel = document.getElementById(id) || document.querySelector('select[name="' + id + '"]');
        if (sel) {
          var opts = Array.from(sel.options);
          for (var o = 0; o < opts.length; o++) {
            if (opts[o].text.trim().toLowerCase() === answer.toLowerCase()) {
              sel.value = opts[o].value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
      } else if (type === 'text') {
        var inp = document.getElementById(id) || document.querySelector('[name="' + id + '"]');
        if (inp && !inp.value) {
          inp.focus();
          inp.value = answer;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    })('${ans.id.replace(/'/g, "\\'")}', '${ans.answer.replace(/'/g, "\\'")}', '${q.type}')`);
  }

  console.log(`  AI answered ${answers.length}/${toAsk.length} form question(s).`);
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
  // For autocomplete location fields (e.g. SmartRecruiters), pick first dropdown suggestion
  await page.waitForTimeout(800);
  const suggestion = page.locator("ul[role='listbox'] li, [role='option'], .suggestions li").first();
  if (await suggestion.count() > 0 && await suggestion.isVisible()) {
    await suggestion.click();
  }
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
    profile.noticePeriod
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

  // Work authorization / residency questions
  await answerBooleanQuestion(page, ["reside", "currently reside", "do you reside"], true);
  await answerBooleanQuestion(page, ["authorized", "authorised", "eligib", "legal"], true);
  await answerBooleanQuestion(page, ["sponsor", "sponsorship", "visa"], profile.requiresSponsorship);
  await answerBooleanQuestion(page, ["non-compete", "noncompete", "non compete"], false);
  await answerBooleanQuestion(page, ["felony", "convicted", "criminal"], false);
  await answerBooleanQuestion(page, ["disability", "disabled"], profile.disability ?? false);
  await answerBooleanQuestion(page, ["veteran", "military"], profile.veteran ?? false);

  // Dropdown versions of the same questions (SmartRecruiters uses <select>)
  await safeSelectOrFillByKeywords(page, ["sponsor", "sponsorship", "visa sponsorship"], (profile.requiresSponsorship ? "Yes" : "No"));
  await safeSelectOrFillByKeywords(page, ["non-compete", "noncompete"], "No");
  await safeSelectOrFillByKeywords(page, ["gender"], profile.gender ?? "");

  // Broad text-proximity fallback for SmartRecruiters and similar forms
  // Handles cases where question text is in <p>/<div> rather than <label>/<legend>
  await page.evaluate(`(function(requiresSponsorship) {
    var rules = [
      { pattern: /reside/i, answer: /yes/i },
      { pattern: /authorized|authorised|eligible.*work/i, answer: /yes/i },
      { pattern: /sponsorship|visa.*require|require.*visa/i, answer: requiresSponsorship ? /yes/i : /no/i },
      { pattern: /non.?compete/i, answer: /no/i },
      { pattern: /felony|convicted|criminal/i, answer: /no/i },
    ];

    // Group radio inputs by name
    var allRadios = Array.from(document.querySelectorAll('input[type="radio"]'));
    var groups = {};
    allRadios.forEach(function(r) {
      var key = r.name || r.getAttribute('data-name') || r.id;
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });

    Object.keys(groups).forEach(function(key) {
      var group = groups[key];
      if (group.some(function(r) { return r.checked; })) return; // already answered

      // Walk up DOM from first radio to find question text
      var el = group[0];
      var containerText = '';
      for (var i = 0; i < 6; i++) {
        el = el.parentElement;
        if (!el) break;
        containerText = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (containerText.length > 10) break;
      }

      rules.forEach(function(rule) {
        if (!rule.pattern.test(containerText)) return;
        group.forEach(function(r) {
          var lbl = document.querySelector('label[for="' + r.id + '"]');
          var labelText = lbl ? lbl.textContent : (r.value || r.nextSibling && r.nextSibling.textContent || '');
          if (rule.answer.test(String(labelText))) {
            r.click();
          }
        });
      });
    });

    // Handle <select> dropdowns by text proximity
    var selects = Array.from(document.querySelectorAll('select'));
    var selectRules = [
      { pattern: /sponsorship|visa.*require|require.*visa/i, answer: requiresSponsorship ? 'yes' : 'no' },
      { pattern: /non.?compete/i, answer: 'no' },
    ];
    selects.forEach(function(sel) {
      if (sel.value && sel.value !== '' && sel.value !== 'null') return;
      var container = sel.parentElement;
      for (var i = 0; i < 5; i++) {
        if (!container) break;
        var text = (container.textContent || '');
        selectRules.forEach(function(rule) {
          if (!rule.pattern.test(text)) return;
          var opts = Array.from(sel.options);
          for (var o = 0; o < opts.length; o++) {
            if (opts[o].text.trim().toLowerCase().startsWith(rule.answer)) {
              sel.value = opts[o].value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return;
            }
          }
        });
        container = container.parentElement;
      }
    });

    // Auto-check declaration/consent checkboxes
    var checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    checkboxes.forEach(function(cb) {
      if (cb.checked) return;
      var parent = cb.closest('div, li, label') || cb.parentElement;
      var txt = (parent ? parent.textContent : '').toLowerCase();
      if (/declare|confirm|agree|consent|certify|acknowledge/i.test(txt)) cb.click();
    });
  })(${profile.requiresSponsorship ?? false})`);
  await page.waitForTimeout(300);
}

async function clickNextIfPresent(page: Page): Promise<boolean> {
  // Find all visible, enabled buttons matching next/review/continue/submit
  // Skip carousel arrow buttons (data-testid contains "carousel")
  const allBtnLocs = page.locator("button");
  const count = await allBtnLocs.count();

  for (let i = 0; i < count; i++) {
    const btn = allBtnLocs.nth(i);
    if (!await btn.isVisible() || !await btn.isEnabled()) continue;

    const testId = (await btn.getAttribute("data-testid")) ?? "";
    if (/carousel/i.test(testId)) continue;

    const text = (await btn.textContent())?.replace(/\s+/g, " ").trim() ?? "";
    const aria = (await btn.getAttribute("aria-label")) ?? "";

    if (!/\b(next|review|continue|submit)\b/i.test(text) && !/\b(next|review|continue|submit)\b/i.test(aria)) continue;

    try {
      await btn.click({ timeout: 5000, force: true });
      console.log(`  Next clicked: text="${text}" aria="${aria}"`);
      await page.waitForTimeout(1500);
      return true;
    } catch {
      // Stale or intercepted — try next candidate
    }
  }

  // Debug: list all visible buttons
  const allBtns = await page.locator("button").all();
  const labels: string[] = [];
  for (const btn of allBtns) {
    if (await btn.isVisible()) {
      const t = ((await btn.textContent()) ?? "").trim().slice(0, 30);
      const a = ((await btn.getAttribute("aria-label")) ?? "").trim().slice(0, 30);
      if (t || a) labels.push(t || a);
    }
  }
  console.log(`  [debug] visible buttons: ${labels.join(" | ").slice(0, 300)}`);
  return false;
}

async function hasSubmitButton(page: Page): Promise<boolean> {
  const submitButton = page
    .getByRole("button", { name: /submit application|submit|send application/i })
    .first();
  return (await submitButton.count()) > 0;
}

async function getUnansweredRequiredCount(page: Page): Promise<number> {
  // Pass as string so esbuild never transforms it and cannot inject __name helpers
  return page.evaluate(`(function () {
    var elements = Array.from(document.querySelectorAll('input, textarea, select'));
    function isVisible(el) {
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }
    var count = 0;
    var radioGroups = {};
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!isVisible(el) || !el.required || el.disabled) continue;
      var tag = (el.tagName || '').toLowerCase();
      var type = (el.type || '').toLowerCase();
      if (tag === 'input' && type === 'radio') {
        var groupKey = el.name || ('__anon__' + i);
        if (radioGroups[groupKey] === undefined) radioGroups[groupKey] = false;
        if (el.checked) radioGroups[groupKey] = true;
        continue;
      }
      if (tag === 'input' && type === 'checkbox') {
        if (!el.checked) count++;
        continue;
      }
      if (!el.value || !String(el.value).trim()) count++;
    }
    for (var key in radioGroups) {
      if (!radioGroups[key]) count++;
    }
    return count;
  })()`) as Promise<number>;
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

async function promptWithTimeout(prompt: string, timeoutMs = 30000): Promise<string> {
  return Promise.race([
    promptLine(prompt),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), timeoutMs)),
  ]);
}

async function waitForSubmitSuccess(page: Page, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const detected = await page.evaluate(`(function() {
        var text = (document.body.innerText || '').toLowerCase();
        // LinkedIn success confirmation patterns
        if (/your application was sent|application submitted|successfully applied|application sent/i.test(text)) return true;
        // Modal closed + button changed to "Applied"
        var btn = document.querySelector('button[aria-label*="Applied" i], a[aria-label*="Applied" i]');
        if (btn) return true;
        // Post-submit confirmation modal
        var heading = document.querySelector('h2, h3');
        if (heading && /your application was sent|done|submitted/i.test(heading.textContent || '')) return true;
        return false;
      })()`);
      if (detected) return true;
    } catch {
      // page navigating — ignore
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function handleApplicationForm(
  page: Page,
  config: AppConfig,
  profile?: CandidateProfile,
  coverLetter?: string
): Promise<ApplyStatus> {
  // Continuous debug screenshots every 2s — only when DEBUG=true env var is set
  const debugMode = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  let ssCount = 0;
  const ssInterval = debugMode ? setInterval(async () => {
    try {
      await page.screenshot({ path: `debug/live-${String(++ssCount).padStart(3, "0")}-${Date.now()}.png` });
    } catch { /* page may be closing */ }
  }, 2000) : null;

  try {
  let stuckConsecutive = 0;
  for (let step = 1; step <= config.maxFormSteps; step += 1) {
    await uploadResumeIfPossible(page, config.resumePath);
    if (config.coverLetterPath) await uploadCoverLetterIfPossible(page, config.coverLetterPath);
    await fillStandardContactFields(page, config);
    await autofillFromProfile(page, profile, coverLetter);
    if (profile) await answerPageQuestions(page, profile, config);

    if (await hasSubmitButton(page)) {
      await page.screenshot({ path: `debug/submit-step-${Date.now()}.png` });
      console.log(`  Submit ready. Click "Submit application" in browser — auto-detecting, or type 'y' here.`);

      const result = await Promise.race([
        // Auto-detect LinkedIn's success confirmation (up to 60s)
        waitForSubmitSuccess(page, 60000).then((ok) => (ok ? "detected" : "timeout")),
        // Manual fallback: type 'y' in terminal
        promptWithTimeout("  (or type 'y' to mark applied): ", 60000).then((ans) =>
          /^y(es)?$/i.test(ans) ? "manual" : "timeout"
        ),
      ]);

      if (result === "detected") {
        console.log("  Application confirmed by LinkedIn.");
        return "applied";
      }
      if (result === "manual") {
        console.log("  Marked applied manually.");
        return "applied";
      }
      console.log("  No confirmation detected. Skipping.");
      return "skipped";
    }

    const unansweredRequired = await getUnansweredRequiredCount(page);
    if (config.autoSkipUnansweredRequired && unansweredRequired > 0) {
      await page.screenshot({ path: `debug/unanswered-step${step}-${Date.now()}.png` });
      console.log(`  Auto-skip: ${unansweredRequired} required field(s) unanswered (screenshot saved).`);
      return "skipped";
    }

    // Fingerprint = first 250 chars of visible modal text — always differs between steps
    const getFingerprint = `(function() {
      var dialog = document.querySelector(
        '.artdeco-modal__content, .jobs-easy-apply-content, ' +
        '.jobs-easy-apply-modal, [data-test-modal-container], ' +
        '[role="dialog"] .artdeco-modal__content, [role="dialog"]'
      );
      var root = dialog || document.body;
      return (root.innerText || root.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 250);
    })()`;

    const fingerprintBefore = await page.evaluate(getFingerprint).catch(() => "");

    const moved = await clickNextIfPresent(page);
    if (!moved) {
      await page.screenshot({ path: `debug/stuck-step${step}-${Date.now()}.png` });
      console.log(`  No Next/Review/Continue on step ${step} (screenshot saved). Skipping.`);
      return "skipped";
    }

    console.log(`  Step ${step} → Next clicked.`);
    await page.waitForTimeout(2000);

    // Check if form advanced
    const fingerprintAfter = await page.evaluate(getFingerprint).catch(() => "");
    console.log(`  Fingerprint: "${fingerprintBefore}" → "${fingerprintAfter}"`);

    if (fingerprintAfter === fingerprintBefore) {
      // Page didn't change — wait up to 8 more seconds
      await page.waitForTimeout(8000);
      const fingerprintFinal = await page.evaluate(getFingerprint).catch(() => "");

      if (fingerprintFinal === fingerprintBefore) {
        stuckConsecutive++;
        const ssPath = `debug/stuck-nochange-step${step}-${Date.now()}.png`;
        await page.screenshot({ path: ssPath });
        console.log(`  Step ${step} didn't advance after 10s (stuck x${stuckConsecutive}). Re-filling and retrying...`);

        if (stuckConsecutive >= 2) {
          console.log(`  Stuck on same page twice in a row. Skipping.`);
          return "skipped";
        }

        // Re-fill fields and retry Next once
        await fillStandardContactFields(page, config);
        await autofillFromProfile(page, profile, coverLetter);
        if (profile) await answerPageQuestions(page, profile, config);
        await page.waitForTimeout(1000);
        const retried = await clickNextIfPresent(page);
        if (!retried) {
          console.log(`  Still stuck after retry. Skipping.`);
          return "skipped";
        }
        await page.waitForTimeout(2000);
      } else {
        stuckConsecutive = 0;
      }
    } else {
      stuckConsecutive = 0; // page advanced normally
    }

    await page.screenshot({ path: `debug/step${step}-${Date.now()}.png` });
  }

  console.log(`  Reached maxFormSteps (${config.maxFormSteps}) without submit. Skipping.`);
  return "skipped";
  } finally {
    if (ssInterval) clearInterval(ssInterval);
  }
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

    console.log(`\n[${index + 1}/${max}] ${job.job_title} @ ${job.company}`);
    console.log(`  URL: ${job.job_url}`);

    const page = await createPage(context);
    const coverLetter = profile?.coverLetter;
    let status: ApplyStatus = "failed";

    try {
      await page.goto(job.job_url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Easy Apply can be an <a> or <button> depending on LinkedIn's page version
      // Buttons only (not links) to avoid clicking sidebar job card "Easy Apply" badges
      const easyApplyBtn = page.locator(
        "button[aria-label*='Easy Apply' i], " +
        "button.jobs-apply-button, " +
        "button.jobs-apply-button--top-card"
      ).or(page.getByRole("button", { name: /^easy apply$/i }))
       .first();
      const found = await easyApplyBtn.waitFor({ state: "visible", timeout: 15000 })
        .then(() => true).catch(() => false);

      if (!found) {
        const reason = job.apply_type === "external" ? "External job — apply manually." : "Easy Apply button not found on page.";
        await page.screenshot({ path: `debug/no-easy-apply-${Date.now()}.png` });
        console.log(`  ${reason} Skipping.`);
        status = "skipped";
      } else {
        await easyApplyBtn.scrollIntoViewIfNeeded();
        await easyApplyBtn.click();
        console.log("  Easy Apply clicked.");
        await page.waitForTimeout(10000);
        status = await handleApplicationForm(page, config, profile, coverLetter);
      }
    } catch (error) {
      console.error(`  Failed on ${job.job_url}:`, error);
      status = "failed";
    } finally {
      await page.close();
    }

    // Record result
    const timestamp = nowIso();
    writeResult({ job_url: job.job_url, status, timestamp });
    console.log(`  Status: ${status}`);

    // Sync to Supabase if configured
    const sb = getSupabaseClient();
    if (sb) {
      const { error } = await sb.from("job_results").insert({
        job_url: job.job_url,
        job_title: job.job_title,
        company: job.company,
        apply_type: job.apply_type ?? null,
        score: job.score ?? null,
        status,
      });
      if (error) console.warn("  Supabase sync failed:", error.message);
    }

    if (index < max - 1 && config.delayBetweenJobsSeconds > 0) {
      const ms = config.delayBetweenJobsSeconds * 1000;
      console.log(`Waiting ${config.delayBetweenJobsSeconds}s before next job...`);
      await delay(ms);
    }
  }
}
