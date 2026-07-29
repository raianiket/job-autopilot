import fs from "node:fs";
import path from "node:path";
import {
  AggregatorSourceConfig,
  AppConfig,
  EvaluationConfig,
  FilterConfig,
  InterviewConfig,
  LinkedInSourceConfig,
  PortalSourceConfig,
} from "./types";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.json");

const DEFAULT_LINKEDIN: LinkedInSourceConfig = {
  enabled: true,
  maxJobs: 100,
  maxPerRole: 10,
};

const DEFAULT_PORTALS: PortalSourceConfig = {
  enabled: true,
  companiesPath: "./data/companies.json",
  concurrency: 5,
  maxPerCompany: 25,
  greenhouse: true,
  lever: true,
  ashby: true,
};

const DEFAULT_AGGREGATORS: AggregatorSourceConfig = {
  enabled: true,
  instahyre: true,
  remotive: true,
  remoteok: true,
  maxPages: 5,
  limitPerQuery: 50,
};

const DEFAULT_FILTERS: FilterConfig = {
  excludeTitlePatterns: ["intern", "internship", "trainee", "fresher", "graduate program"],
  allowRemote: true,
  requireLocationMatch: true,
};

const DEFAULT_EVALUATION: EvaluationConfig = {
  enabled: true,
  weights: {
    skills_match: 0.3,
    seniority_fit: 0.2,
    location_fit: 0.15,
    tech_growth: 0.15,
    compensation: 0.1,
    company_health: 0.1,
  },
  thresholds: { strong_apply: 4.2, apply: 3.4, maybe: 2.5 },
  redFlagSkipCount: 3,
  maxDescriptionChars: 12000,
  concurrency: 4,
};

const DEFAULT_INTERVIEW: InterviewConfig = {
  storiesPath: "./data/stories.json",
  questionsPerSession: 8,
};

/** Shallow-merges a user section over its defaults, ignoring undefined values. */
function section<T extends object>(defaults: T, provided: unknown): T {
  if (!provided || typeof provided !== "object") return { ...defaults };
  const out = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(provided as Record<string, unknown>)) {
    if (value !== undefined && key in out) out[key] = value;
  }
  return out as T;
}

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ? path.resolve(process.cwd(), configPath) : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let parsed: Record<string, any>;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, any>;
  } catch (err) {
    throw new Error(`Failed to parse config file: ${resolvedPath}\n${(err as Error).message}`);
  }

  // Allow env vars to override config values so credentials are never committed.
  const phone = process.env.LINKEDIN_PHONE ?? parsed.phone ?? "";
  const email = process.env.LINKEDIN_EMAIL ?? parsed.email ?? "";

  const linkedin = section(DEFAULT_LINKEDIN, parsed.sources?.linkedin);
  const portals = section(DEFAULT_PORTALS, parsed.sources?.portals);
  const aggregators = section(DEFAULT_AGGREGATORS, parsed.sources?.aggregators);
  const filters = section(DEFAULT_FILTERS, parsed.filters);
  const evaluation = section(DEFAULT_EVALUATION, parsed.evaluation);
  const interview = section(DEFAULT_INTERVIEW, parsed.interview);

  // Nested objects need their own merge so a partial override keeps sibling defaults.
  evaluation.weights = { ...DEFAULT_EVALUATION.weights, ...(parsed.evaluation?.weights ?? {}) };
  evaluation.thresholds = {
    ...DEFAULT_EVALUATION.thresholds,
    ...(parsed.evaluation?.thresholds ?? {}),
  };

  // Back-compat: honour the flat pre-2.0 keys if the nested form is absent.
  if (parsed.companiesPath && !parsed.sources?.portals?.companiesPath) {
    portals.companiesPath = parsed.companiesPath;
  }
  if (parsed.storiesPath && !parsed.interview?.storiesPath) {
    interview.storiesPath = parsed.storiesPath;
  }

  const config: AppConfig = {
    maxApplicationsPerRun: parsed.maxApplicationsPerRun ?? 15,
    delayBetweenJobsSeconds: parsed.delayBetweenJobsSeconds ?? 30,
    resumePath: parsed.resumePath ?? "./data/documents/resume.pdf",
    coverLetterPath: parsed.coverLetterPath,
    profilePath: parsed.profilePath ?? "./data/profile.json",
    maxFormSteps: parsed.maxFormSteps ?? 8,
    autoSkipUnansweredRequired: parsed.autoSkipUnansweredRequired ?? true,
    phone,
    email,
    claudeModel: parsed.claudeModel ?? "",
    minJobScore: parsed.minJobScore ?? 0,
    headless: parsed.headless ?? false,
    browserSlowMo: parsed.browserSlowMo ?? 100,
    sources: { linkedin, portals, aggregators },
    filters,
    evaluation,
    interview,
  };

  if (config.maxApplicationsPerRun < 1) {
    throw new Error("maxApplicationsPerRun must be >= 1");
  }
  if (config.delayBetweenJobsSeconds < 0) {
    throw new Error("delayBetweenJobsSeconds must be >= 0");
  }
  if (config.maxFormSteps < 1) {
    throw new Error("maxFormSteps must be >= 1");
  }
  if (config.evaluation.concurrency < 1) {
    throw new Error("evaluation.concurrency must be >= 1");
  }
  if (config.sources.portals.concurrency < 1) {
    throw new Error("sources.portals.concurrency must be >= 1");
  }
  if (
    !config.sources.linkedin.enabled &&
    !config.sources.portals.enabled &&
    !config.sources.aggregators.enabled
  ) {
    throw new Error("At least one source under `sources` must be enabled.");
  }

  const { strong_apply, apply, maybe } = config.evaluation.thresholds;
  if (!(strong_apply > apply && apply > maybe)) {
    throw new Error(
      "evaluation.thresholds must satisfy strong_apply > apply > maybe " +
        `(got ${strong_apply}, ${apply}, ${maybe}).`
    );
  }

  if (!config.phone) {
    throw new Error("phone is required. Set it in config.json or via LINKEDIN_PHONE env var.");
  }

  config.resumePath = path.resolve(process.cwd(), config.resumePath);
  config.profilePath = path.resolve(process.cwd(), config.profilePath);
  config.sources.portals.companiesPath = path.resolve(
    process.cwd(),
    config.sources.portals.companiesPath
  );
  config.interview.storiesPath = path.resolve(process.cwd(), config.interview.storiesPath);

  if (config.coverLetterPath) {
    config.coverLetterPath = path.resolve(process.cwd(), config.coverLetterPath);
    if (!fs.existsSync(config.coverLetterPath)) {
      console.warn(
        `Warning: Cover letter not found at ${config.coverLetterPath}. Cover letter upload will be skipped.`
      );
    }
  }

  if (!fs.existsSync(config.resumePath)) {
    console.warn(`Warning: Resume not found at ${config.resumePath}. Resume upload will be skipped.`);
  }

  return config;
}
