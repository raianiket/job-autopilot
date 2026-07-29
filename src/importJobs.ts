import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";
import { readJobs } from "./csvReader";
import { writeJobsCsv } from "./jobsCsv";
import { JobRow, JobSource } from "./types";

/**
 * Merges externally harvested jobs into data/jobs.csv.
 *
 * Playwright cannot reuse an already-signed-in Chrome (since Chrome 136 the
 * browser ignores --remote-debugging-port on the default profile), so LinkedIn
 * results can instead be collected through the Chrome extension against the
 * session the user already has open, dumped to JSON, and imported here.
 */
interface HarvestedJob {
  job_url: string;
  job_title: string;
  company?: string;
  location?: string;
  apply_type?: "easy_apply" | "external";
  role_category?: string;
  posted_at?: string;
  linkedin_score?: string;
  description?: string;
}

function normalize(raw: HarvestedJob, source: JobSource, fetchedAt: string): JobRow | null {
  if (!raw.job_url || !raw.job_title) return null;
  return {
    job_title: raw.job_title.trim(),
    company: raw.company?.trim() || "Unknown Company",
    job_url: raw.job_url.split("?")[0].trim(),
    location: raw.location?.trim() || "Unknown Location",
    apply_type: raw.apply_type ?? "external",
    source,
    role_category: raw.role_category ?? "",
    linkedin_score: raw.linkedin_score ?? "",
    posted_at: raw.posted_at ?? "",
    fetched_at: fetchedAt,
    description: raw.description ?? "",
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  let inFile = "";
  let outFile = "data/jobs.csv";
  let source: JobSource = "linkedin";

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--in" && argv[i + 1]) { inFile = argv[++i]; continue; }
    if (argv[i] === "--out" && argv[i + 1]) { outFile = argv[++i]; continue; }
    if (argv[i] === "--source" && argv[i + 1]) { source = argv[++i] as JobSource; continue; }
  }

  if (!inFile) {
    console.log(`Usage: npm run import -- --in <harvest.json> [--out data/jobs.csv] [--source linkedin]

Expects a JSON array of objects with at least job_url and job_title.`);
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), inFile);
  if (!fs.existsSync(resolved)) throw new Error(`Not found: ${resolved}`);

  const harvested = JSON.parse(fs.readFileSync(resolved, "utf-8")) as HarvestedJob[];
  if (!Array.isArray(harvested)) throw new Error("Input must be a JSON array.");

  const config = loadConfig();
  const profile = loadProfile(config.profilePath);
  const fetchedAt = new Date().toISOString();

  // Tag each row with the preferred role it matched, matching discover's behaviour.
  const roles = profile?.preferredRoles ?? [];
  const categorize = (title: string) =>
    roles.find((r) => title.toLowerCase().includes(r.toLowerCase())) ?? "";

  const incoming = harvested
    .map((raw) => normalize(raw, source, fetchedAt))
    .filter((j): j is JobRow => j !== null)
    .map((j) => ({ ...j, role_category: j.role_category || categorize(j.job_title) }));

  // Existing rows win on conflict so previously written scores are not clobbered.
  const byUrl = new Map<string, JobRow>();
  for (const job of incoming) byUrl.set(job.job_url, job);

  const existing = fs.existsSync(path.resolve(process.cwd(), outFile)) ? readJobs(outFile) : [];
  let kept = 0;
  for (const job of existing) {
    if (byUrl.has(job.job_url)) kept += 1;
    byUrl.set(job.job_url, job);
  }

  writeJobsCsv(outFile, [...byUrl.values()]);

  const added = incoming.length - kept;
  console.log(
    `Imported ${incoming.length} ${source} job(s): ${added} new, ${kept} already present.\n` +
      `${byUrl.size} total in ${outFile}.`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Import failed:", (err as Error).message);
    process.exit(1);
  }
}
