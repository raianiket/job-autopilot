import Anthropic from "@anthropic-ai/sdk";
import { AppConfig, CandidateProfile, JobRow } from "./types";

export async function scoreJobs(
  jobs: JobRow[],
  profile: CandidateProfile | undefined,
  config: AppConfig
): Promise<JobRow[]> {
  if (!config.claudeModel || !process.env.ANTHROPIC_API_KEY) {
    console.log("Skipping AI scoring (claudeModel or ANTHROPIC_API_KEY not set).");
    return jobs;
  }

  if (!jobs.length) {
    return jobs;
  }

  const profileSummary = [
    profile?.preferredRoles?.length ? `Target roles: ${profile.preferredRoles.join(", ")}` : null,
    profile?.yearsOfExperience != null ? `Experience: ${profile.yearsOfExperience} years` : null,
    profile?.headline ? `Headline: ${profile.headline}` : null,
    profile?.skills?.length ? `Skills: ${profile.skills.join(", ")}` : null,
    profile?.workAuthorization ? `Work authorization: ${profile.workAuthorization}` : null,
    profile?.expectedSalary ? `Expected salary: ${profile.expectedSalary}` : null,
    profile?.preferredLocations?.length
      ? `Preferred locations: ${profile.preferredLocations.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const jobList = jobs
    .map((j, i) => `${i + 1}. "${j.job_title}" at ${j.company} — ${j.location}`)
    .join("\n");

  const prompt = `You are a job-fit scorer. Score each job for how well it matches the candidate.

Candidate:
${profileSummary}

Jobs:
${jobList}

For each job also list red flags that are evident from the title, company, or location alone. Only flag what you can actually justify: severe seniority mismatch, location conflict with the candidate's preferences, vague or meaningless title, or an employer identity that looks like an agency mill or is unclear. Use an empty array when nothing stands out. This is a shallow pass, so do not speculate.

Return ONLY a JSON array — no markdown, no explanation:
[{"index":1,"score":8,"reason":"One sentence explaining the fit","red_flags":[]}]

Score 1–10 where 10 = perfect match.`;

  const client = new Anthropic();

  let scored: Array<{ index: number; score: number; reason: string; red_flags?: string[] }> = [];

  try {
    console.log(`AI scoring ${jobs.length} job(s) with ${config.claudeModel}...`);
    const message = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    scored = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as typeof scored;
  } catch (err) {
    console.warn("AI scoring failed — keeping all jobs:", (err as Error).message);
    return jobs;
  }

  const byIndex = new Map(scored.map((r) => [r.index, r]));

  const annotated = jobs.map((job, i) => {
    const result = byIndex.get(i + 1);
    return {
      ...job,
      score: result?.score ?? 10,
      reason: result?.reason ?? "",
      red_flags: (result?.red_flags ?? []).join("; "),
    };
  });

  const flagged = annotated.filter((j) => j.red_flags).length;
  if (flagged) {
    console.log(`  ${flagged} job(s) carry at least one red flag.`);
  }

  if (config.minJobScore > 0) {
    const before = annotated.length;
    const filtered = annotated.filter((j) => (j.score ?? 0) >= config.minJobScore);
    console.log(
      `Filtered ${before - filtered.length} job(s) below score ${config.minJobScore}. Keeping ${filtered.length}.`
    );
    return filtered;
  }

  return annotated;
}
