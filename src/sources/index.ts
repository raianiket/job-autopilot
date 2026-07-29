import fs from "node:fs";
import { AggregatorName, AppConfig, CandidateProfile, JobRow, PortalCompanies, PortalName } from "../types";
import { fetchGreenhouseJobs } from "./greenhouse";
import { fetchLeverJobs } from "./lever";
import { fetchAshbyJobs } from "./ashby";
import { fetchInstahyreJobs } from "./instahyre";
import { fetchRemotiveJobs } from "./remotive";
import { fetchRemoteOkJobs } from "./remoteok";

export function loadCompanies(companiesPath: string): PortalCompanies {
  if (!fs.existsSync(companiesPath)) {
    console.log(`No companies file at ${companiesPath} — skipping portal discovery.`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(companiesPath, "utf-8")) as PortalCompanies;
  } catch (err) {
    console.warn(`Failed to parse ${companiesPath}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Portal boards return every open role at a company, so unlike the LinkedIn
 * search we filter client-side using the same profile preferences.
 */
function matchesProfile(
  job: JobRow,
  profile: CandidateProfile | undefined,
  config: AppConfig
): boolean {
  const title = job.job_title.toLowerCase();

  for (const pattern of config.filters.excludeTitlePatterns) {
    if (!pattern) continue;
    try {
      if (new RegExp(pattern, "i").test(title)) return false;
    } catch {
      // A malformed pattern falls back to a plain substring test rather than throwing.
      if (title.includes(pattern.toLowerCase())) return false;
    }
  }

  const roles = (profile?.preferredRoles ?? []).map((r) => r.toLowerCase()).filter(Boolean);
  if (roles.length && !roles.some((role) => title.includes(role))) return false;

  const locations = (profile?.preferredLocations ?? []).map((l) => l.toLowerCase()).filter(Boolean);
  if (locations.length && config.filters.requireLocationMatch) {
    const jobLocation = job.location.toLowerCase();
    const isRemote = config.filters.allowRemote && /\bremote\b|\banywhere\b/.test(jobLocation);
    if (!isRemote && !locations.some((loc) => jobLocation.includes(loc))) return false;
  }

  return true;
}

/** Which preferred role this posting matched, so role_category stays populated. */
function categorize(job: JobRow, profile: CandidateProfile | undefined): string {
  const title = job.job_title.toLowerCase();
  const match = (profile?.preferredRoles ?? []).find((role) => title.includes(role.toLowerCase()));
  return match ?? "";
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

const FETCHERS: Record<PortalName, (token: string) => Promise<JobRow[]>> = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
};

/**
 * Fetches every configured company board across all enabled portals. Pure HTTP,
 * no browser and no LinkedIn session, so this runs before login.
 */
export async function fetchPortalJobs(
  config: AppConfig,
  profile: CandidateProfile | undefined
): Promise<JobRow[]> {
  const portalCfg = config.sources.portals;
  if (!portalCfg.enabled) {
    console.log("Portal discovery disabled in config.");
    return [];
  }

  const companies = loadCompanies(portalCfg.companiesPath);
  const collected: JobRow[] = [];

  for (const portal of Object.keys(FETCHERS) as PortalName[]) {
    if (!portalCfg[portal]) {
      console.log(`[${portal}] disabled in config — skipping.`);
      continue;
    }

    const tokens = companies[portal] ?? [];
    if (!tokens.length) continue;

    console.log(`\n[${portal}] Fetching ${tokens.length} company board(s)...`);

    const results = await inBatches(tokens, portalCfg.concurrency, async (token) => {
      const jobs = await FETCHERS[portal](token);
      if (!jobs.length) {
        console.log(`  ${token}: no jobs (not a ${portal} customer, or board empty)`);
        return [];
      }

      let relevant = jobs.filter((job) => job.job_url && matchesProfile(job, profile, config));
      if (portalCfg.maxPerCompany > 0) {
        relevant = relevant.slice(0, portalCfg.maxPerCompany);
      }

      console.log(`  ${token}: ${relevant.length} relevant of ${jobs.length} total`);
      return relevant.map((job) => ({ ...job, role_category: categorize(job, profile) }));
    });

    collected.push(...results.flat());
  }

  console.log(`\nPortal discovery found ${collected.length} relevant job(s).`);
  return collected;
}

/**
 * Job aggregators. Unlike company boards these have no per-company token: each
 * returns a broad feed that we filter against the profile locally.
 */
export async function fetchAggregatorJobs(
  config: AppConfig,
  profile: CandidateProfile | undefined
): Promise<JobRow[]> {
  const cfg = config.sources.aggregators;
  if (!cfg.enabled) {
    console.log("Aggregator discovery disabled in config.");
    return [];
  }

  const roles = (profile?.preferredRoles ?? []).filter(Boolean);
  const collected: JobRow[] = [];

  const runners: Array<[AggregatorName, () => Promise<JobRow[]>]> = [
    ["instahyre", () => fetchInstahyreJobs(cfg.maxPages)],
    ["remotive", () => fetchRemotiveJobs(roles, cfg.limitPerQuery)],
    ["remoteok", () => fetchRemoteOkJobs()],
  ];

  for (const [name, run] of runners) {
    if (!cfg[name]) {
      console.log(`[${name}] disabled in config — skipping.`);
      continue;
    }

    try {
      const jobs = await run();
      const relevant = jobs.filter((job) => job.job_url && matchesProfile(job, profile, config));
      console.log(`[${name}] ${relevant.length} relevant of ${jobs.length} fetched`);
      collected.push(...relevant.map((job) => ({ ...job, role_category: categorize(job, profile) })));
    } catch (err) {
      console.warn(`[${name}] failed: ${(err as Error).message}`);
    }
  }

  console.log(`\nAggregator discovery found ${collected.length} relevant job(s).`);
  return collected;
}
