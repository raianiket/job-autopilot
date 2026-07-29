import { JobRow } from "../types";
import { fetchJson, stripHtml } from "./common";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  employmentType?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

export async function fetchAshbyJobs(token: string): Promise<JobRow[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
  const data = await fetchJson<AshbyResponse>(url);
  if (!data?.jobs?.length) return [];

  const fetchedAt = new Date().toISOString();

  return data.jobs.map((job) => ({
    job_title: job.title?.trim() || "Unknown Title",
    company: token,
    job_url: job.jobUrl || job.applyUrl || "",
    location: job.location?.trim() || "Unknown Location",
    apply_type: "external" as const,
    source: "ashby" as const,
    posted_at: job.publishedAt ?? "",
    fetched_at: fetchedAt,
    description: job.descriptionPlain?.trim() || stripHtml(job.descriptionHtml ?? ""),
  }));
}
