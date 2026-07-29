import fs from "node:fs";
import { Page } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import { AppConfig, CandidateProfile } from "./../types";

/** Fills the first selector that exists. Returns whether anything was filled. */
export async function fill(page: Page, selectors: string[], value: string): Promise<boolean> {
  if (!value) return false;
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (!(await el.count())) continue;
    try {
      await el.fill(value, { timeout: 4000 });
      return true;
    } catch {
      // Selector matched something unfillable (hidden, readonly) — try the next.
    }
  }
  return false;
}

export async function uploadFile(page: Page, selectors: string[], filePath: string): Promise<boolean> {
  if (!filePath || !fs.existsSync(filePath)) return false;
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (!(await input.count())) continue;
    try {
      await input.setInputFiles(filePath, { noWaitAfter: true });
      return true;
    } catch {
      // Not a real file input, or the page rejected it.
    }
  }
  return false;
}

export interface PortalQuestion {
  selector: string;
  label: string;
  kind: "text" | "select" | "radio";
  options: string[];
}

/**
 * Reads every unanswered visible field with its label. Portal-agnostic: it works
 * off `<label for>` / aria-label rather than any one ATS's markup.
 */
export async function readQuestions(page: Page): Promise<PortalQuestion[]> {
  return page.evaluate(`(function () {
    function labelFor(el) {
      var id = el.getAttribute('id');
      if (id) {
        var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return (lab.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      var wrap = el.closest('label');
      if (wrap) return (wrap.textContent || '').replace(/\\s+/g, ' ').trim();
      var aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      var group = el.closest('div,fieldset');
      var head = group && group.querySelector('label,legend');
      return head ? (head.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    var out = [];
    var seenRadio = {};
    var nodes = document.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'file' || type === 'submit' || type === 'button') continue;
      if (el.disabled || !visible(el)) continue;

      var id = el.getAttribute('id');
      var name = el.getAttribute('name');

      if (type === 'radio' || type === 'checkbox') {
        if (!name || seenRadio[name]) continue;
        seenRadio[name] = true;
        var group = document.querySelectorAll('input[name="' + CSS.escape(name) + '"]');
        var answered = false;
        var opts = [];
        for (var g = 0; g < group.length; g++) {
          if (group[g].checked) answered = true;
          opts.push(labelFor(group[g]));
        }
        if (answered) continue;
        out.push({ selector: 'input[name="' + name + '"]', label: labelFor(el), kind: 'radio', options: opts });
        continue;
      }

      if (el.tagName.toLowerCase() === 'select') {
        if (el.value) continue;
        var o = [];
        for (var s = 0; s < el.options.length; s++) o.push(el.options[s].text.trim());
        out.push({ selector: id ? '#' + id : 'select[name="' + name + '"]', label: labelFor(el), kind: 'select', options: o });
        continue;
      }

      if (el.value) continue;
      out.push({ selector: id ? '#' + id : '[name="' + name + '"]', label: labelFor(el), kind: 'text', options: [] });
    }
    return out;
  })()`) as Promise<PortalQuestion[]>;
}

/** Asks Claude to answer the questions it cannot infer from the profile alone. */
export async function answerWithAI(
  questions: PortalQuestion[],
  profile: CandidateProfile,
  config: AppConfig
): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  if (!questions.length || !config.claudeModel || !process.env.ANTHROPIC_API_KEY) return answers;

  const skills = (profile.skills ?? []).map((s) => s.toLowerCase());
  const summary = [
    profile.fullName ? `Name: ${profile.fullName}` : null,
    profile.currentTitle ? `Title: ${profile.currentTitle}` : null,
    profile.yearsOfExperience != null ? `Experience: ${profile.yearsOfExperience} years` : null,
    profile.location ? `Location: ${profile.location}` : null,
    profile.workAuthorization ? `Work authorization: ${profile.workAuthorization}` : null,
    profile.requiresSponsorship != null
      ? `Requires sponsorship: ${profile.requiresSponsorship ? "yes" : "no"}`
      : null,
    profile.noticePeriod ? `Notice period: ${profile.noticePeriod}` : null,
    profile.expectedSalary ? `Expected salary: ${profile.expectedSalary}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const list = questions
    .map((q, i) => {
      const opts = q.options.filter(Boolean).length
        ? `\n   Options: ${q.options.filter(Boolean).join(" | ")}`
        : "";
      return `${i + 1}. [${q.kind}] ${q.label || "(unlabelled field)"}${opts}`;
    })
    .join("\n");

  const prompt = `Fill out this job application for the candidate.

CANDIDATE
${summary}
Skills: ${skills.join(", ")}

QUESTIONS
${list}

Rules:
- Years-of-experience questions about a technology in the candidate's skill list: answer "5"
- Years-of-experience for a technology NOT in the skill list: answer "1"
- For [select] or [radio], reply with the exact option text
- Never invent qualifications the candidate does not have

Return ONLY a JSON array, no markdown:
[{"index":1,"answer":"..."}]`;

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Array<{
      index: number;
      answer: string;
    }>;
    for (const item of parsed) {
      const q = questions[item.index - 1];
      if (q && item.answer) answers.set(q.selector, String(item.answer));
    }
  } catch (err) {
    console.warn(`  AI answering failed: ${(err as Error).message}`);
  }

  return answers;
}

/** Applies AI answers back onto the form. */
export async function applyAnswers(
  page: Page,
  questions: PortalQuestion[],
  answers: Map<string, string>
): Promise<number> {
  let filled = 0;
  for (const q of questions) {
    const answer = answers.get(q.selector);
    if (!answer) continue;
    try {
      if (q.kind === "select") {
        await page.selectOption(q.selector, { label: answer }, { timeout: 3000 });
      } else if (q.kind === "radio") {
        const radio = page.locator(`${q.selector}`).filter({ hasText: answer }).first();
        if (await radio.count()) await radio.check({ timeout: 3000 });
        else await page.locator(q.selector).first().check({ timeout: 3000 });
      } else {
        await page.locator(q.selector).first().fill(answer, { timeout: 3000 });
      }
      filled += 1;
    } catch {
      // A single unfillable field must not abort the rest of the form.
    }
  }
  return filled;
}
