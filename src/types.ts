export type JobSource =
  | "linkedin"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "instahyre"
  | "remotive"
  | "remoteok";

export interface JobRow {
  job_title: string;
  company: string;
  job_url: string;
  location: string;
  apply_type?: "easy_apply" | "external";
  source?: JobSource;
  role_category?: string;
  linkedin_score?: string;
  score?: number;
  reason?: string;
  red_flags?: string;
  /** Weighted rubric result, 1-5. Set by `npm run evaluate`. */
  fit_score?: number;
  verdict?: "strong_apply" | "apply" | "maybe" | "skip";
  posted_at?: string;
  fetched_at?: string;
  /** Full job description text. Populated by portal sources, used by prep. */
  description?: string;
}

/** Company board tokens per portal, loaded from data/companies.json */
export interface PortalCompanies {
  greenhouse?: string[];
  lever?: string[];
  ashby?: string[];
}

export interface StarStory {
  id: string;
  title: string;
  /** Skills/themes this story demonstrates, used to match against job requirements. */
  tags: string[];
  situation: string;
  task: string;
  action: string;
  result: string;
}

export type PortalName = "greenhouse" | "lever" | "ashby";
export type AggregatorName = "instahyre" | "remotive" | "remoteok";

export interface LinkedInSourceConfig {
  enabled: boolean;
  maxJobs: number;
  maxPerRole: number;
}

export interface PortalSourceConfig {
  enabled: boolean;
  companiesPath: string;
  /** How many company boards to fetch at once. */
  concurrency: number;
  /** Cap on relevant jobs kept per company, 0 means unlimited. */
  maxPerCompany: number;
  /** Per-portal on/off switches. */
  greenhouse: boolean;
  lever: boolean;
  ashby: boolean;
}

export interface AggregatorSourceConfig {
  enabled: boolean;
  /** Instahyre ignores search params, so it is paginated and filtered locally. */
  instahyre: boolean;
  remotive: boolean;
  remoteok: boolean;
  /** Pages of 100 to pull from paginated aggregators. */
  maxPages: number;
  /** Per-query result cap for aggregators that support search. */
  limitPerQuery: number;
}

export interface FilterConfig {
  /** Case-insensitive regex fragments; a title matching any of these is dropped. */
  excludeTitlePatterns: string[];
  /** Treat a remote posting as matching every preferred location. */
  allowRemote: boolean;
  /** When false, postings outside preferredLocations are kept anyway. */
  requireLocationMatch: boolean;
}

export interface EvaluationConfig {
  enabled: boolean;
  /** Rubric dimension -> weight. Weights are normalised, so they need not sum to 1. */
  weights: Record<string, number>;
  /** Minimum fit_score (1-5) for each verdict tier. */
  thresholds: { strong_apply: number; apply: number; maybe: number };
  /** This many red flags forces a "skip" verdict regardless of fit. */
  redFlagSkipCount: number;
  /** Job description characters sent to the model. */
  maxDescriptionChars: number;
  /** How many jobs to evaluate in parallel. */
  concurrency: number;
}

export interface InterviewConfig {
  storiesPath: string;
  /** Questions generated per prep or practice session. */
  questionsPerSession: number;
}

export interface AppConfig {
  maxApplicationsPerRun: number;
  delayBetweenJobsSeconds: number;
  resumePath: string;
  coverLetterPath?: string;
  profilePath: string;
  maxFormSteps: number;
  autoSkipUnansweredRequired: boolean;
  phone: string;
  email?: string;
  claudeModel: string;
  minJobScore: number;
  headless: boolean;
  browserSlowMo: number;
  sources: {
    linkedin: LinkedInSourceConfig;
    portals: PortalSourceConfig;
    aggregators: AggregatorSourceConfig;
  };
  filters: FilterConfig;
  evaluation: EvaluationConfig;
  interview: InterviewConfig;
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
  noticePeriod?: string;
  skills?: string[];
  workAuthorization?: string;
  requiresSponsorship?: boolean;
  gender?: string;
  veteran?: boolean;
  disability?: boolean;
  coverLetter?: string;
  email?: string;
}

export type ApplyStatus = "applied" | "skipped" | "failed";

export interface ApplyResult {
  job_url: string;
  status: ApplyStatus;
  timestamp: string;
}
