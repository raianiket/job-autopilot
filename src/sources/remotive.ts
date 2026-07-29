import { JobRow } from "../types";
import { fetchJson, stripHtml } from "./common";

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name?: string;
  candidate_required_location?: string;
  publication_date?: string;
  description?: string;
  salary?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

/** Remotive supports server-side search, so we query once per target role. */
export async function fetchRemotiveJobs(roles: string[], limit: number): Promise<JobRow[]> {
  const fetchedAt = new Date().toISOString();
  const byUrl = new Map<string, JobRow>();
  const queries = roles.length ? roles : [""];

  for (const role of queries) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (role) params.set("search", role);

    const data = await fetchJson<RemotiveResponse>(`https://remotive.com/api/remote-jobs?${params}`);
    for (const job of data?.jobs ?? []) {
      if (!job.url || byUrl.has(job.url)) continue;
      byUrl.set(job.url, {
        job_title: job.title?.trim() || "Unknown Title",
        company: job.company_name?.trim() || "Unknown Company",
        job_url: job.url,
        location: job.candidate_required_location?.trim() || "Remote",
        apply_type: "external",
        source: "remotive",
        posted_at: job.publication_date ?? "",
        fetched_at: fetchedAt,
        description: stripHtml(job.description ?? ""),
      });
    }
  }

  return [...byUrl.values()];
}
