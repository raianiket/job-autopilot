import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { readJobs } from "./csvReader";
import { AppConfig, CandidateProfile, JobRow } from "./types";

/** Human-readable labels for the rubric keys defined in config.evaluation.weights. */
const DIMENSION_LABELS: Record<string, string> = {
  skills_match: "Skills match",
  seniority_fit: "Seniority fit",
  location_fit: "Location / work setup",
  tech_growth: "Tech stack & growth",
  compensation: "Compensation signal",
  company_health: "Company stability",
};

export type Verdict = "strong_apply" | "apply" | "maybe" | "skip";

export interface JobEvaluation {
  index: number;
  scores: Record<string, number>;
  fit_score: number;
  verdict: Verdict;
  summary: string;
  red_flags: string[];
}

function verdictFor(fit: number, redFlagCount: number, config: AppConfig): Verdict {
  const { thresholds, redFlagSkipCount } = config.evaluation;
  // Legitimacy gate: enough red flags force a skip regardless of how well it fits.
  if (redFlagCount >= redFlagSkipCount) return "skip";
  if (redFlagCount >= redFlagSkipCount - 1 && fit < thresholds.strong_apply) return "maybe";
  if (fit >= thresholds.strong_apply) return "strong_apply";
  if (fit >= thresholds.apply) return "apply";
  if (fit >= thresholds.maybe) return "maybe";
  return "skip";
}

/** Weights are normalised by the total actually used, so they need not sum to 1. */
function weightedScore(scores: Record<string, number>, config: AppConfig): number {
  let total = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(config.evaluation.weights)) {
    const raw = scores[key];
    if (typeof raw !== "number" || Number.isNaN(raw)) continue;
    total += Math.min(5, Math.max(1, raw)) * weight;
    weightUsed += weight;
  }
  if (weightUsed === 0) return 0;
  return Number((total / weightUsed).toFixed(2));
}

export function profileSummary(profile: CandidateProfile | undefined): string {
  return [
    profile?.headline ? `Headline: ${profile.headline}` : null,
    profile?.currentTitle ? `Current title: ${profile.currentTitle}` : null,
    profile?.yearsOfExperience != null ? `Experience: ${profile.yearsOfExperience} years` : null,
    profile?.skills?.length ? `Skills: ${profile.skills.join(", ")}` : null,
    profile?.preferredRoles?.length ? `Target roles: ${profile.preferredRoles.join(", ")}` : null,
    profile?.preferredLocations?.length
      ? `Preferred locations: ${profile.preferredLocations.join(", ")}`
      : null,
    profile?.workAuthorization ? `Work authorization: ${profile.workAuthorization}` : null,
    profile?.requiresSponsorship != null
      ? `Requires sponsorship: ${profile.requiresSponsorship ? "yes" : "no"}`
      : null,
    profile?.expectedSalary ? `Expected salary: ${profile.expectedSalary}` : null,
    profile?.noticePeriod ? `Notice period: ${profile.noticePeriod}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function rubricText(config: AppConfig): string {
  return Object.entries(config.evaluation.weights)
    .map(([key, weight]) => `- ${key} (weight ${weight}): ${DIMENSION_LABELS[key] ?? key}`)
    .join("\n");
}

/**
 * Deep evaluation against the full job description. Unlike scoreJobs (which sees
 * only titles and is used for cheap bulk triage during discovery), this needs the
 * description text that portal sources provide.
 */
export async function evaluateJobs(
  jobs: JobRow[],
  profile: CandidateProfile | undefined,
  config: AppConfig
): Promise<Map<string, JobEvaluation>> {
  const results = new Map<string, JobEvaluation>();

  if (!config.claudeModel || !process.env.ANTHROPIC_API_KEY) {
    console.log("Skipping evaluation (claudeModel or ANTHROPIC_API_KEY not set).");
    return results;
  }
  if (!jobs.length) return results;

  const client = new Anthropic();
  const candidate = profileSummary(profile);
  const RUBRIC_TEXT = rubricText(config);

  // One job per call: descriptions are long and batching them degrades scoring quality.
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const description = (job.description ?? "").slice(0, config.evaluation.maxDescriptionChars);

    const prompt = `You are a rigorous job-fit evaluator. Score this role for this candidate.

CANDIDATE
${candidate}

JOB
Title: ${job.job_title}
Company: ${job.company}
Location: ${job.location}
${description ? `\nDescription:\n${description}` : "\n(No description available — score conservatively from the title and company.)"}

Score each dimension 1-5 (5 = excellent fit):
${RUBRIC_TEXT}

Also list red flags you can actually justify from the posting. Only include a flag if there is real evidence. Valid flags include: vague or missing responsibilities, no compensation info where it is legally expected, unrealistic experience requirements, signs of a ghost or perpetually reposted listing, excessive unpaid assessment work, unclear or misleading employer identity, obvious scam markers, severe seniority mismatch.

Return ONLY valid JSON, no markdown fences:
{"scores":{"skills_match":4,"seniority_fit":3,"location_fit":5,"tech_growth":4,"compensation":2,"company_health":4},"summary":"One or two sentences on the fit.","red_flags":["..."]}`;

    try {
      const message = await client.messages.create({
        model: config.claudeModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
      const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
      const parsed = JSON.parse(json) as {
        scores: Record<string, number>;
        summary?: string;
        red_flags?: string[];
      };

      const scores = parsed.scores ?? {};
      const fit = weightedScore(scores, config);
      const flags = Array.isArray(parsed.red_flags) ? parsed.red_flags : [];
      const verdict = verdictFor(fit, flags.length, config);

      results.set(job.job_url, {
        index: i,
        scores,
        fit_score: fit,
        verdict,
        summary: parsed.summary?.trim() ?? "",
        red_flags: flags,
      });

      console.log(
        `  [${i + 1}/${jobs.length}] ${job.job_title} @ ${job.company} — ${fit}/5 ${verdict}` +
          (flags.length ? ` (${flags.length} red flag${flags.length > 1 ? "s" : ""})` : "")
      );
    } catch (err) {
      console.warn(`  [${i + 1}/${jobs.length}] Evaluation failed: ${(err as Error).message}`);
    }
  }

  return results;
}

/** Merges evaluation output back onto the job rows for CSV writing. */
export function applyEvaluations(jobs: JobRow[], evals: Map<string, JobEvaluation>): JobRow[] {
  return jobs.map((job) => {
    const ev = evals.get(job.job_url);
    if (!ev) return job;
    return {
      ...job,
      score: Math.round(ev.fit_score * 2), // 1-5 rubric -> existing 1-10 column
      fit_score: ev.fit_score,
      verdict: ev.verdict,
      reason: ev.summary || job.reason,
      red_flags: ev.red_flags.join("; "),
    } as JobRow;
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let inFile = "data/jobs.csv";
  let limit = 25;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--in" && argv[i + 1]) { inFile = argv[i + 1]; i += 1; continue; }
    if (argv[i] === "--limit" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(n) && n > 0) limit = n;
      i += 1;
    }
  }

  const config = loadConfig();
  const profile = loadProfile(config.profilePath);
  const all = readJobs(inFile);

  // Prefer rows that have a description, they produce a far better evaluation.
  const withDesc = all.filter((j) => (j.description ?? "").length > 200);
  const target = (withDesc.length ? withDesc : all).slice(0, limit);

  const dimensions = Object.keys(config.evaluation.weights).length;
  console.log(`Evaluating ${target.length} job(s) against the ${dimensions}-dimension rubric...\n`);
  const evals = await evaluateJobs(target, profile, config);
  const merged = applyEvaluations(all, evals);

  const byVerdict = new Map<string, number>();
  for (const ev of evals.values()) {
    byVerdict.set(ev.verdict, (byVerdict.get(ev.verdict) ?? 0) + 1);
  }

  console.log("\nVerdict breakdown:");
  for (const v of ["strong_apply", "apply", "maybe", "skip"]) {
    console.log(`  ${v.padEnd(13)} ${byVerdict.get(v) ?? 0}`);
  }

  const outPath = path.resolve(process.cwd(), inFile.replace(/\.csv$/, "_evaluated.json"));
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), "utf-8");
  console.log(`\nWritten to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Evaluate failed:", err);
    process.exit(1);
  });
}
