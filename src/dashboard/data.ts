import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

const RESULTS_CSV = path.resolve(process.cwd(), "results.csv");
const JOBS_HISTORY = path.resolve(process.cwd(), "data/jobs_history.csv");
const JOBS_CSV = path.resolve(process.cwd(), "data/jobs.csv");

export interface ResultRow {
  job_url: string;
  status: string;
  timestamp: string;
}

/** One row as the client consumes it: job facts merged with apply outcome. */
export interface DashboardRow {
  url: string;
  title: string;
  company: string;
  location: string;
  source: string;
  apply_type: string;
  role_category: string;
  score: string;
  fit_score: string;
  verdict: string;
  reason: string;
  red_flags: string[];
  posted_at: string;
  /** True when posted_at carries a clock time, not just a calendar date. */
  precise_age: boolean;
  description: string;
  status: string;
  updated_at: string;
}

function readCsv(file: string): Array<Record<string, string>> {
  if (!fs.existsSync(file)) return [];
  try {
    return parse(fs.readFileSync(file, "utf-8"), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    console.warn(`Failed to parse ${file}: ${(err as Error).message}`);
    return [];
  }
}

function readResults(): ResultRow[] {
  // results.csv is written append-only by apply.ts with three plain columns.
  if (!fs.existsSync(RESULTS_CSV)) return [];
  const rows = readCsv(RESULTS_CSV);
  if (rows.length) {
    return rows
      .map((r) => ({
        job_url: r["job_url"] ?? "",
        status: r["status"] ?? "",
        timestamp: r["timestamp"] ?? "",
      }))
      .filter((r) => r.job_url)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  return [];
}

function ageOf(posted: string): { hours: number | null; precise: boolean } {
  const raw = posted.trim();
  if (!raw) return { hours: null, precise: false };
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return { hours: null, precise: false };
  return {
    hours: Math.max(0, (Date.now() - when.getTime()) / 3600000),
    precise: /T\d{2}:/.test(raw),
  };
}

/**
 * Merges the job catalogue with apply results. jobs_history.csv is preferred
 * because it accumulates across runs, so a job that fell out of the latest
 * discovery still shows up.
 */
export function loadRows(): DashboardRow[] {
  const jobsFile = fs.existsSync(JOBS_HISTORY) ? JOBS_HISTORY : JOBS_CSV;
  const jobs = readCsv(jobsFile);
  const results = readResults();
  const resultByUrl = new Map(results.map((r) => [r.job_url, r]));

  const rows: DashboardRow[] = [];
  const seen = new Set<string>();

  for (const j of jobs) {
    const url = j["job_url"] ?? "";
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const result = resultByUrl.get(url);
    const posted = j["posted_at"] ?? "";
    const { precise } = ageOf(posted);

    rows.push({
      url,
      title: j["job_title"] || "Untitled",
      company: j["company"] || "Unknown",
      location: j["location"] || "",
      source: j["source"] || "linkedin",
      apply_type: j["apply_type"] || "",
      role_category: j["role_category"] || "",
      score: j["score"] || "",
      fit_score: j["fit_score"] || "",
      verdict: j["verdict"] || "",
      reason: j["reason"] || "",
      red_flags: (j["red_flags"] || "").split(";").map((f) => f.trim()).filter(Boolean),
      posted_at: posted,
      precise_age: precise,
      description: j["description"] || "",
      status: result?.status ?? "pending",
      updated_at: result?.timestamp ?? "",
    });
  }

  // Results for jobs no longer in the catalogue still deserve a row.
  for (const r of results) {
    if (seen.has(r.job_url)) continue;
    seen.add(r.job_url);
    rows.push({
      url: r.job_url,
      title: r.job_url,
      company: "Unknown",
      location: "",
      source: "linkedin",
      apply_type: "",
      role_category: "",
      score: "",
      fit_score: "",
      verdict: "",
      reason: "",
      red_flags: [],
      posted_at: "",
      precise_age: false,
      description: "",
      status: r.status,
      updated_at: r.timestamp,
    });
  }

  return rows;
}

export interface Summary {
  total: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  roles: string[];
  /** Actionable right now: pending, Easy Apply, no blocking red flags. */
  actionable: number;
  freshUnderDay: number;
  flagged: number;
  undated: number;
}

export function summarize(rows: DashboardRow[]): Summary {
  const bySource: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const roles = new Set<string>();

  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.role_category) roles.add(r.role_category);
  }

  return {
    total: rows.length,
    bySource,
    byStatus,
    roles: [...roles].sort(),
    actionable: rows.filter(
      (r) => r.status === "pending" && r.apply_type === "easy_apply" && r.verdict !== "skip"
    ).length,
    freshUnderDay: rows.filter((r) => {
      const { hours } = ageOf(r.posted_at);
      return hours !== null && hours < 24;
    }).length,
    flagged: rows.filter((r) => r.red_flags.length > 0).length,
    undated: rows.filter((r) => ageOf(r.posted_at).hours === null).length,
  };
}
