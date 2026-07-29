import { JobRow } from "../types";
import { fetchJson } from "./common";

interface InstahyreJob {
  id: number;
  title: string;
  locations?: string;
  public_url?: string;
  keywords?: string[];
  employer?: { company_name?: string };
}

interface InstahyreResponse {
  objects?: InstahyreJob[];
  meta?: { total_count?: number };
}

const REQUESTED_LIMIT = 100;

/**
 * India-focused aggregator. The API ignores every search parameter we tried, so
 * pagination plus client-side filtering is the only option. maxPages bounds it.
 *
 * The server caps a page well below whatever `limit` we ask for (35 at the time
 * of writing), so the offset advances by however many rows actually came back
 * rather than by the requested size.
 */
export async function fetchInstahyreJobs(maxPages: number): Promise<JobRow[]> {
  const fetchedAt = new Date().toISOString();
  const out: JobRow[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `https://www.instahyre.com/api/v1/job_search?limit=${REQUESTED_LIMIT}&offset=${offset}`;
    const data = await fetchJson<InstahyreResponse>(url);
    const jobs = data?.objects ?? [];
    if (!jobs.length) break;

    for (const job of jobs) {
      if (!job.public_url) continue;
      out.push({
        job_title: job.title?.trim() || "Unknown Title",
        company: job.employer?.company_name?.trim() || "Unknown Company",
        job_url: job.public_url,
        location: job.locations?.trim() || "Unknown Location",
        apply_type: "external",
        source: "instahyre",
        posted_at: "",
        fetched_at: fetchedAt,
        // No description field is exposed; the keyword list is the best signal.
        description: (job.keywords ?? []).join(", "),
      });
    }

    offset += jobs.length;
    const total = data?.meta?.total_count;
    if (total != null && offset >= total) break;
  }

  return out;
}
