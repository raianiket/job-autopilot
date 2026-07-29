import { JobRow } from "../types";
import { fetchJson, stripHtml } from "./common";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  content?: string;
  location?: { name?: string };
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

/**
 * Greenhouse exposes every board publicly, no auth required.
 * `content=true` returns the full HTML job description in the same call,
 * which saves a request per job and gives `prep` something to work with.
 */
export async function fetchGreenhouseJobs(token: string): Promise<JobRow[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
  const data = await fetchJson<GreenhouseResponse>(url);
  if (!data?.jobs?.length) return [];

  const fetchedAt = new Date().toISOString();

  return data.jobs.map((job) => ({
    job_title: job.title?.trim() || "Unknown Title",
    company: token,
    job_url: job.absolute_url,
    location: job.location?.name?.trim() || "Unknown Location",
    apply_type: "external" as const,
    source: "greenhouse" as const,
    posted_at: job.updated_at ?? "",
    fetched_at: fetchedAt,
    description: stripHtml(job.content ?? ""),
  }));
}
