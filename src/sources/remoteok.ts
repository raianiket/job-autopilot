import { JobRow } from "../types";
import { fetchJson, stripHtml } from "./common";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  date?: string;
  url?: string;
  apply_url?: string;
  description?: string;
}

/**
 * RemoteOK returns a single page of roughly 100 jobs. The first array element is
 * a legal/attribution notice rather than a posting, so entries without a
 * position are dropped. Their terms ask for a link back when reusing the feed.
 */
export async function fetchRemoteOkJobs(): Promise<JobRow[]> {
  const data = await fetchJson<RemoteOkJob[]>("https://remoteok.com/api");
  if (!Array.isArray(data)) return [];

  const fetchedAt = new Date().toISOString();

  return data
    .filter((job) => job.position && (job.url || job.apply_url))
    .map((job) => ({
      job_title: job.position!.trim(),
      company: job.company?.trim() || "Unknown Company",
      job_url: (job.url || job.apply_url)!,
      location: job.location?.trim() || "Remote",
      apply_type: "external" as const,
      source: "remoteok" as const,
      posted_at: job.date ?? "",
      fetched_at: fetchedAt,
      description: stripHtml(job.description ?? ""),
    }));
}
