import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { readJobs } from "./csvReader";
import { profileSummary } from "./evaluate";
import { AppConfig, CandidateProfile, JobRow, StarStory } from "./types";

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Interview tools need it.");
  }
  return new Anthropic();
}

async function ask(model: string, prompt: string, maxTokens = 2048): Promise<string> {
  const message = await client().messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

function parseJson<T>(text: string): T {
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as T;
}

// ── Story bank ──────────────────────────────────────────────────────────────

export function loadStories(storiesPath: string): StarStory[] {
  if (!fs.existsSync(storiesPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(storiesPath, "utf-8")) as StarStory[];
  } catch {
    return [];
  }
}

/**
 * Builds the STAR bank from the profile. The bullets already describe real work,
 * so the model is restructuring facts rather than inventing achievements.
 */
async function buildStories(config: AppConfig, profile: CandidateProfile): Promise<void> {
  const existing = loadStories(config.interview.storiesPath);
  if (existing.length) {
    console.log(`${existing.length} story/stories already exist at ${config.interview.storiesPath}.`);
    console.log("Delete that file to regenerate from scratch.\n");
    existing.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}  [${s.tags.join(", ")}]`));
    return;
  }

  console.log("Generating STAR stories from your profile...\n");

  const text = await ask(
    config.claudeModel,
    `Turn this candidate's real experience into STAR interview stories.

CANDIDATE
${profileSummary(profile)}

${profile.coverLetter ? `Background:\n${profile.coverLetter}` : ""}

Write 6-8 stories covering distinct themes: system design, debugging a hard production issue, leading or mentoring, handling conflict or disagreement, shipping under pressure, improving performance, and owning a failure.

Ground every story in the candidate's stated experience. Do not invent employers, metrics, or projects that are not implied by the profile. Where a specific number is unknown, describe the outcome qualitatively instead of inventing a figure.

Return ONLY a JSON array, no markdown:
[{"id":"kebab-case-id","title":"Short title","tags":["system-design","leadership"],"situation":"...","task":"...","action":"...","result":"..."}]`,
    4096
  );

  const stories = parseJson<StarStory[]>(text);
  fs.writeFileSync(config.interview.storiesPath, JSON.stringify(stories, null, 2), "utf-8");

  console.log(`Wrote ${stories.length} stories to ${config.interview.storiesPath}\n`);
  stories.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}  [${s.tags.join(", ")}]`));
  console.log("\nEdit that file to correct any detail before an interview.");
}

// ── Job lookup ──────────────────────────────────────────────────────────────

function findJob(target: string): JobRow | undefined {
  const jobs = [
    ...(fs.existsSync("data/jobs.csv") ? readJobs("data/jobs.csv") : []),
    ...(fs.existsSync("data/jobs_history.csv") ? readJobs("data/jobs_history.csv") : []),
  ];
  if (!target) return undefined;

  const asIndex = Number.parseInt(target, 10);
  if (!Number.isNaN(asIndex) && String(asIndex) === target.trim()) return jobs[asIndex - 1];

  const lower = target.toLowerCase();
  return (
    jobs.find((j) => j.job_url === target) ??
    jobs.find((j) => j.company.toLowerCase().includes(lower)) ??
    jobs.find((j) => j.job_title.toLowerCase().includes(lower))
  );
}

function jobContext(job: JobRow | undefined, config: AppConfig): string {
  if (!job) return "No specific job selected. Prepare for a generic senior backend interview.";
  return [
    `Title: ${job.job_title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    job.description
      ? `\nDescription:\n${job.description.slice(0, config.evaluation.maxDescriptionChars)}`
      : "",
  ].join("\n");
}

// ── Prep ────────────────────────────────────────────────────────────────────

interface PrepOutput {
  likely_questions: Array<{ question: string; why: string; use_story?: string }>;
  gaps: string[];
  questions_to_ask: string[];
  company_watch_outs: string[];
}

async function prep(config: AppConfig, profile: CandidateProfile, target: string): Promise<void> {
  const job = findJob(target);
  if (target && !job) {
    console.log(`No job matched "${target}". Falling back to a generic prep.\n`);
  }
  if (job) console.log(`Preparing for: ${job.job_title} @ ${job.company}\n`);

  const stories = loadStories(config.interview.storiesPath);
  const storyList = stories.length
    ? stories.map((s) => `- ${s.id}: ${s.title} [${s.tags.join(", ")}]`).join("\n")
    : "(No story bank yet — run `npm run interview stories` first.)";

  const text = await ask(
    config.claudeModel,
    `Prepare this candidate for an interview.

CANDIDATE
${profileSummary(profile)}

STORY BANK
${storyList}

JOB
${jobContext(job, config)}

Produce exactly ${config.interview.questionsPerSession} likely interview questions for this specific role, mapping each to the most relevant story id where one fits. Then list honest gaps between the candidate and the role, good questions for the candidate to ask, and anything about the posting worth probing.

Return ONLY JSON, no markdown:
{"likely_questions":[{"question":"...","why":"...","use_story":"story-id or null"}],"gaps":["..."],"questions_to_ask":["..."],"company_watch_outs":["..."]}`,
    3072
  );

  const out = parseJson<PrepOutput>(text);

  console.log("LIKELY QUESTIONS");
  out.likely_questions.forEach((q, i) => {
    console.log(`\n  ${i + 1}. ${q.question}`);
    console.log(`     why: ${q.why}`);
    if (q.use_story) console.log(`     story: ${q.use_story}`);
  });

  const block = (title: string, items: string[]) => {
    if (!items?.length) return;
    console.log(`\n${title}`);
    items.forEach((g) => console.log(`  - ${g}`));
  };

  block("GAPS TO ADDRESS", out.gaps);
  block("ASK THEM", out.questions_to_ask);
  block("WATCH OUTS", out.company_watch_outs);
}

// ── Practice ────────────────────────────────────────────────────────────────

async function practice(config: AppConfig, profile: CandidateProfile, target: string): Promise<void> {
  const job = findJob(target);
  const rl = readline.createInterface({ input, output });

  console.log(
    job ? `Mock interview: ${job.job_title} @ ${job.company}` : "Mock interview: generic senior backend"
  );
  console.log(`${config.interview.questionsPerSession} questions. Type "skip" to pass, Ctrl+C to quit.\n`);

  const questionsText = await ask(
    config.claudeModel,
    `Generate exactly ${config.interview.questionsPerSession} interview questions for this role, ordered easy to hard, mixing behavioural and technical.

JOB
${jobContext(job, config)}

CANDIDATE
${profileSummary(profile)}

Return ONLY a JSON array of strings, no markdown: ["question 1","question 2"]`
  );

  const questions = parseJson<string[]>(questionsText);
  const transcript: Array<{ q: string; a: string }> = [];

  for (let i = 0; i < questions.length; i += 1) {
    console.log(`\n─── Question ${i + 1}/${questions.length} ───`);
    console.log(questions[i]);
    const answer = (await rl.question("\n> ")).trim();

    if (!answer || answer.toLowerCase() === "skip") {
      console.log("  (skipped)");
      continue;
    }

    transcript.push({ q: questions[i], a: answer });

    const feedback = await ask(
      config.claudeModel,
      `You are an interview coach. Give short, direct feedback on this answer.

QUESTION: ${questions[i]}
ANSWER: ${answer}

Reply in at most 5 lines: what worked, the single biggest weakness, and one concrete rewrite suggestion. Be honest rather than encouraging. No preamble.`,
      600
    );
    console.log(`\n  ${feedback.split("\n").join("\n  ")}`);
  }

  rl.close();

  if (!transcript.length) {
    console.log("\nNo answers given, so no summary.");
    return;
  }

  const summary = await ask(
    config.claudeModel,
    `Summarise this mock interview performance in at most 8 lines: overall readiness, the two strongest areas, and the two things to fix before the real interview.

${transcript.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a}`).join("\n\n")}`,
    800
  );

  console.log(`\n═══ SESSION SUMMARY ═══\n${summary}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const target = rest.filter((a) => !a.startsWith("--")).join(" ");

  const config = loadConfig();
  const profile = loadProfile(config.profilePath);

  if (!profile) throw new Error(`No profile found at ${config.profilePath}`);
  if (!config.claudeModel) throw new Error("claudeModel is not set in config.json.");

  switch (command) {
    case "stories":
      return buildStories(config, profile);
    case "prep":
      return prep(config, profile, target);
    case "practice":
      return practice(config, profile, target);
    default:
      console.log(`Usage: npm run interview <command> [job]

  stories             Build the STAR story bank from your profile
  prep [job]          Likely questions, gaps, and what to ask
  practice [job]      Interactive mock interview with feedback

[job] accepts a row number from data/jobs.csv, a company name, or a job URL.
Omit it for generic preparation.

Examples:
  npm run interview stories
  npm run interview prep stripe
  npm run interview practice 3`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Interview command failed:", (err as Error).message);
    process.exit(1);
  });
}
