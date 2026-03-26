import fs from "node:fs";
import path from "node:path";
import { AppConfig } from "./types";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config.json");

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ? path.resolve(process.cwd(), configPath) : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let parsed: Partial<AppConfig>;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf-8");
    parsed = JSON.parse(raw) as Partial<AppConfig>;
  } catch (err) {
    throw new Error(`Failed to parse config file: ${resolvedPath}\n${(err as Error).message}`);
  }

  // Allow env vars to override config values so credentials are never committed.
  const phone = process.env.LINKEDIN_PHONE ?? parsed.phone ?? "";
  const email = process.env.LINKEDIN_EMAIL ?? parsed.email ?? "";

  const config: AppConfig = {
    maxApplicationsPerRun: parsed.maxApplicationsPerRun ?? 15,
    delayBetweenJobsSeconds: parsed.delayBetweenJobsSeconds ?? 30,
    resumePath: parsed.resumePath ?? "./data/resume.pdf",
    profilePath: parsed.profilePath ?? "./data/profile.json",
    maxFormSteps: parsed.maxFormSteps ?? 8,
    autoSkipUnansweredRequired: parsed.autoSkipUnansweredRequired ?? true,
    phone,
    email,
    claudeModel: parsed.claudeModel ?? "",
    headless: parsed.headless ?? false,
    browserSlowMo: parsed.browserSlowMo ?? 100,
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

  if (!config.phone) {
    throw new Error("phone is required. Set it in config.json or via LINKEDIN_PHONE env var.");
  }

  config.resumePath = path.resolve(process.cwd(), config.resumePath);
  config.profilePath = path.resolve(process.cwd(), config.profilePath);

  if (!fs.existsSync(config.resumePath)) {
    console.warn(`Warning: Resume not found at ${config.resumePath}. Resume upload will be skipped.`);
  }

  return config;
}
