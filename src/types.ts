export interface JobRow {
  job_title: string;
  company: string;
  job_url: string;
  location: string;
}

export interface AppConfig {
  maxApplicationsPerRun: number;
  delayBetweenJobsSeconds: number;
  resumePath: string;
  profilePath: string;
  maxFormSteps: number;
  autoSkipUnansweredRequired: boolean;
  phone: string;
  email?: string;
  claudeModel: string;
  headless: boolean;
  browserSlowMo: number;
}

export interface CandidateProfile {
  preferredRoles?: string[];
  preferredLocations?: string[];
  firstName?: string;
  lastName?: string;
  fullName?: string;
  headline?: string;
  currentTitle?: string;
  currentCompany?: string;
  yearsOfExperience?: number;
  city?: string;
  location?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;
  website?: string;
  expectedSalary?: string;
  noticePeriodDays?: number;
  workAuthorization?: string;
  requiresSponsorship?: boolean;
  coverLetter?: string;
  email?: string;
}

export type ApplyStatus = "applied" | "skipped" | "failed";

export interface ApplyResult {
  job_url: string;
  status: ApplyStatus;
  timestamp: string;
}
