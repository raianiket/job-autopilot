import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { JobRow } from "./types";

export function readJobs(filePath: string): JobRow[] {
  const resolvedPath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`CSV file not found: ${resolvedPath}`);
  }

  const csvContent = fs.readFileSync(resolvedPath, "utf-8");
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as JobRow[];

  return records.filter((job) => Boolean(job.job_url));
}
