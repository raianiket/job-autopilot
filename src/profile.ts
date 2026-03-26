import fs from "node:fs";
import { CandidateProfile } from "./types";

export function loadProfile(profilePath: string): CandidateProfile | undefined {
  if (!fs.existsSync(profilePath)) {
    return undefined;
  }

  let parsed: CandidateProfile;
  try {
    const raw = fs.readFileSync(profilePath, "utf-8");
    parsed = JSON.parse(raw) as CandidateProfile;
  } catch (err) {
    throw new Error(`Failed to parse profile file: ${profilePath}\n${(err as Error).message}`);
  }

  return parsed;
}
