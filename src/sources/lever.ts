import { JobRow } from "../types";
import { fetchJson, stripHtml } from "./common";

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  categories?: { location?: string; team?: string; commitment?: string };
}

/**
 * Lever returns a bare array (not an envelope object) and 404s with
 * `{ok:false}` for companies that are not Lever customers.
 */
export async function fetchLeverJobs(token: string): Promise<JobRow[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
  const data = await fetchJson<LeverJob[] | { ok: false }>(url);

  if (!Array.isArray(data)) return [];

  const fetchedAt = new Date().toISOString();

  return data.map((job) => ({
    job_title: job.text?.trim() || "Unknown Title",
    company: token,
    job_url: job.hostedUrl || job.applyUrl || "",
    location: job.categories?.location?.trim() || "Unknown Location",
    apply_type: "external" as const,
    source: "lever" as const,
    posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : "",
    fetched_at: fetchedAt,
    description: job.descriptionPlain?.trim() || stripHtml(job.description ?? ""),
  }));
}
