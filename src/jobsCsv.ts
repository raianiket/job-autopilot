import fs from "node:fs";
import path from "node:path";
import { JobRow } from "./types";

/** Column order for jobs.csv and jobs_history.csv. Appending is safe; reordering is not. */
export const JOBS_CSV_COLUMNS = [
  "job_title",
  "company",
  "job_url",
  "location",
  "apply_type",
  "source",
  "role_category",
  "linkedin_score",
  "score",
  "reason",
  "red_flags",
  "fit_score",
  "verdict",
  "posted_at",
  "fetched_at",
  "description",
] as const;

const HEADER = JOBS_CSV_COLUMNS.join(",");

export function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowFor(job: JobRow): string {
  return [
    csvEscape(job.job_title),
    csvEscape(job.company),
    csvEscape(job.job_url),
    csvEscape(job.location),
    csvEscape(job.apply_type ?? ""),
    csvEscape(job.source ?? "linkedin"),
    csvEscape(job.role_category ?? ""),
    csvEscape(job.linkedin_score ?? ""),
    csvEscape(String(job.score ?? "")),
    csvEscape(job.reason ?? ""),
    csvEscape(job.red_flags ?? ""),
    csvEscape(job.fit_score != null ? String(job.fit_score) : ""),
    csvEscape(job.verdict ?? ""),
    csvEscape(job.posted_at ?? ""),
    csvEscape(job.fetched_at ?? ""),
    // Flattened to one line: the history dedupe reads this file line-by-line,
    // so an embedded newline would split a record.
    csvEscape((job.description ?? "").replace(/\s+/g, " ").trim()),
  ].join(",");
}

/**
 * The column set grows over time. Appending new-schema rows under an old header
 * silently misaligns every field, so the history file is migrated in place first.
 */
function migrateHistoryIfNeeded(historyFile: string): void {
  if (!fs.existsSync(historyFile)) return;

  const lines = fs.readFileSync(historyFile, "utf-8").split("\n");
  if (!lines[0]?.trim() || lines[0].trim() === HEADER) return;

  const oldCols = (lines[0].match(/"(?:[^"]|"")*"|[^,]+/g) ?? []).map((c) =>
    c.replace(/^"|"$/g, "").trim()
  );
  const migrated = [HEADER];

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.match(/"(?:[^"]|"")*"/g) ?? [];
    const byName = new Map<string, string>();
    oldCols.forEach((col, i) => byName.set(col, parts[i] ?? '""'));
    migrated.push(JOBS_CSV_COLUMNS.map((col) => byName.get(col) ?? '""').join(","));
  }

  fs.writeFileSync(historyFile, `${migrated.join("\n")}\n`, "utf-8");
  console.log(`Migrated jobs_history.csv from ${oldCols.length} to ${JOBS_CSV_COLUMNS.length} columns.`);
}

/**
 * Writes the working CSV and upserts into the persistent history so the
 * dashboard never loses a job that fell out of the latest discovery run.
 */
export function writeJobsCsv(outFile: string, jobs: JobRow[]): void {
  const resolved = path.resolve(process.cwd(), outFile);
  const rows = [HEADER, ...jobs.map(rowFor)];

  fs.writeFileSync(resolved, `${rows.join("\n")}\n`, "utf-8");

  const historyFile = path.resolve(path.dirname(resolved), "jobs_history.csv");
  migrateHistoryIfNeeded(historyFile);

  const existingUrls = new Set<string>();
  if (fs.existsSync(historyFile)) {
    for (const line of fs.readFileSync(historyFile, "utf-8").split("\n").slice(1)) {
      if (!line.trim()) continue;
      const parts = line.match(/"(?:[^"]|"")*"/g) ?? [];
      if (parts[2]) existingUrls.add(parts[2].replace(/^"|"$/g, ""));
    }
  } else {
    fs.writeFileSync(historyFile, `${HEADER}\n`, "utf-8");
  }

  const newRows = jobs.filter((j) => j.job_url && !existingUrls.has(j.job_url)).map(rowFor);
  if (newRows.length) {
    fs.appendFileSync(historyFile, `${newRows.join("\n")}\n`, "utf-8");
  }
}

/**
 * Rewrites rows already present in the history file. Used by `evaluate`, whose
 * verdicts must land in the file the dashboard reads rather than a side file.
 */
export function updateHistoryRows(historyFile: string, updated: Map<string, JobRow>): number {
  if (!fs.existsSync(historyFile) || !updated.size) return 0;

  migrateHistoryIfNeeded(historyFile);

  const lines = fs.readFileSync(historyFile, "utf-8").split("\n");
  const out = [HEADER];
  let changed = 0;

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.match(/"(?:[^"]|"")*"/g) ?? [];
    const url = parts[2]?.replace(/^"|"$/g, "") ?? "";
    const job = url ? updated.get(url) : undefined;
    if (job) {
      out.push(rowFor(job));
      changed += 1;
    } else {
      out.push(line);
    }
  }

  fs.writeFileSync(historyFile, `${out.join("\n")}\n`, "utf-8");
  return changed;
}
