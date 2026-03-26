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
    profile?.workAuthorization ? `Work authorization: ${profile.workAuthorization}` : null,
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

Return ONLY a JSON array — no markdown, no explanation:
[{"index":1,"score":8,"reason":"One sentence explaining the fit"}]

Score 1–10 where 10 = perfect match.`;

  const client = new Anthropic();

  let scored: Array<{ index: number; score: number; reason: string }> = [];

  try {
    console.log(`AI scoring ${jobs.length} job(s) with ${config.claudeModel}...`);
    const message = await client.messages.create({
      model: config.claudeModel,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    scored = JSON.parse(text) as typeof scored;
  } catch (err) {
    console.warn("AI scoring failed — keeping all jobs:", (err as Error).message);
    return jobs;
  }

  const byIndex = new Map(scored.map((r) => [r.index, r]));

  const annotated = jobs.map((job, i) => {
    const result = byIndex.get(i + 1);
    return { ...job, score: result?.score ?? 10, reason: result?.reason ?? "" };
  });

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
