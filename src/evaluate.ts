import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { readJobs } from "./csvReader";
import { updateHistoryRows, writeJobsCsv } from "./jobsCsv";
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
  let done = 0;

  // One job per call: descriptions are long and batching them degrades scoring
  // quality. Calls run concurrently in bounded waves instead.
  const evaluateOne = async (job: JobRow, i: number): Promise<void> => {
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
        `  [${++done}/${jobs.length}] ${job.job_title} @ ${job.company} — ${fit}/5 ${verdict}` +
          (flags.length ? ` (${flags.length} red flag${flags.length > 1 ? "s" : ""})` : "")
      );
    } catch (err) {
      console.warn(`  [${++done}/${jobs.length}] Evaluation failed: ${(err as Error).message}`);
    }
  };

  const size = Math.max(1, config.evaluation.concurrency);
  for (let i = 0; i < jobs.length; i += size) {
    await Promise.all(jobs.slice(i, i + size).map((job, k) => evaluateOne(job, i + k)));
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

interface EvalArgs {
  inFile: string;
  limit: number;
  force: boolean;
  minFit: number;
  onlyVerdict?: Verdict;
  source?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { inFile: "data/jobs.csv", limit: 25, force: false, minFit: 0, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--force") { args.force = true; continue; }
    if (t === "--dry-run") { args.dryRun = true; continue; }
    if (t === "--in" && argv[i + 1]) { args.inFile = argv[++i]; continue; }
    if (t === "--source" && argv[i + 1]) { args.source = argv[++i].toLowerCase(); continue; }
    if (t === "--verdict" && argv[i + 1]) { args.onlyVerdict = argv[++i] as Verdict; continue; }
    if (t === "--limit" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isNaN(n) && n > 0) args.limit = n;
      continue;
    }
    if (t === "--min-fit" && argv[i + 1]) {
      const n = Number.parseFloat(argv[++i]);
      if (!Number.isNaN(n)) args.minFit = n;
      continue;
    }
  }
  return args;
}

const VERDICT_ORDER: Verdict[] = ["strong_apply", "apply", "maybe", "skip"];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const profile = loadProfile(config.profilePath);
  const all = readJobs(args.inFile);

  let candidates = all;
  if (args.source) candidates = candidates.filter((j) => (j.source ?? "linkedin") === args.source);

  // Already-scored rows are skipped so a re-run costs nothing for work done.
  const unscored = args.force ? candidates : candidates.filter((j) => !j.verdict);
  const cached = candidates.length - unscored.length;

  // Rows with a real description score far better, so they go first.
  const ranked = [...unscored].sort(
    (a, b) => (b.description ?? "").length - (a.description ?? "").length
  );
  const target = ranked.slice(0, args.limit);

  const dims = Object.keys(config.evaluation.weights).length;
  console.log(
    `${candidates.length} job(s) in scope; ${cached} already scored, ${unscored.length} unscored.`
  );
  if (!target.length) {
    console.log("Nothing to evaluate. Use --force to re-score.");
    return;
  }
  console.log(
    `Evaluating ${target.length} against ${dims} dimensions, ${config.evaluation.concurrency} at a time...\n`
  );

  const evals = await evaluateJobs(target, profile, config);
  if (!evals.size) {
    console.log("\nNo evaluations produced.");
    return;
  }

  const merged = applyEvaluations(all, evals);

  // Persist into the files the dashboard actually reads.
  if (!args.dryRun) {
    writeJobsCsv(args.inFile, merged);
    const historyFile = path.resolve(path.dirname(path.resolve(args.inFile)), "jobs_history.csv");
    const updated = new Map(
      merged.filter((j) => evals.has(j.job_url)).map((j) => [j.job_url, j])
    );
    const n = updateHistoryRows(historyFile, updated);
    console.log(`\nWrote ${evals.size} evaluation(s) to ${args.inFile}; updated ${n} history row(s).`);
  } else {
    console.log("\n(--dry-run: nothing written)");
  }

  const byVerdict = new Map<string, number>();
  for (const ev of evals.values()) byVerdict.set(ev.verdict, (byVerdict.get(ev.verdict) ?? 0) + 1);

  console.log("\nVerdict breakdown");
  for (const v of VERDICT_ORDER) {
    const n = byVerdict.get(v) ?? 0;
    console.log(`  ${v.padEnd(13)} ${String(n).padStart(3)}  ${"█".repeat(n)}`);
  }

  const flagged = [...evals.values()].filter((e) => e.red_flags.length);
  if (flagged.length) {
    console.log(`\n${flagged.length} posting(s) carry red flags:`);
    for (const ev of flagged.slice(0, 5)) {
      const job = target[ev.index];
      console.log(`  ${job?.company ?? "?"} — ${ev.red_flags.join("; ")}`);
    }
  }

  // Ranked shortlist, honouring --verdict / --min-fit.
  let shortlist = merged.filter((j) => evals.has(j.job_url));
  if (args.onlyVerdict) shortlist = shortlist.filter((j) => j.verdict === args.onlyVerdict);
  if (args.minFit) shortlist = shortlist.filter((j) => (j.fit_score ?? 0) >= args.minFit);
  shortlist.sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0));

  if (shortlist.length) {
    console.log(`\nTop ${Math.min(10, shortlist.length)} by fit:`);
    for (const j of shortlist.slice(0, 10)) {
      const flag = j.red_flags ? " ⚑" : "";
      console.log(
        `  ${String(j.fit_score ?? "").padStart(4)}/5  ${(j.verdict ?? "").padEnd(13)} ${j.job_title} @ ${j.company}${flag}`
      );
    }
  }

  console.log("\nRun `npm run dashboard` to browse these with the verdict column.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Evaluate failed:", err);
    process.exit(1);
  });
}
