import { Page } from "playwright";
import { AppConfig, CandidateProfile } from "../types";
import { answerWithAI, applyAnswers, fill, readQuestions, uploadFile } from "./common";

/**
 * Lever uses a single full-name field and name-attribute selectors rather than ids.
 */
export async function fillLeverForm(
  page: Page,
  profile: CandidateProfile,
  config: AppConfig
): Promise<{ filled: number; unanswered: number }> {
  const fullName =
    profile.fullName ?? [profile.firstName, profile.lastName].filter(Boolean).join(" ");

  await fill(page, ['input[name="name"]'], fullName);
  await fill(page, ['input[name="email"]'], profile.email ?? config.email ?? "");
  await fill(page, ['input[name="phone"]'], config.phone);
  await fill(page, ['input[name="org"]', 'input[name="company"]'], profile.currentCompany ?? "");
  await fill(page, ['input[name="urls[LinkedIn]"]'], profile.linkedinUrl ?? "");
  await fill(page, ['input[name="urls[GitHub]"]'], profile.githubUrl ?? "");
  await fill(
    page,
    ['input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]'],
    profile.portfolioUrl ?? profile.website ?? ""
  );

  await uploadFile(
    page,
    ['input[name="resume"]', 'input[type="file"]'],
    config.resumePath
  );

  if (profile.coverLetter) {
    await fill(page, ['textarea[name="comments"]'], profile.coverLetter);
  }

  const questions = await readQuestions(page);
  const answers = await answerWithAI(questions, profile, config);
  const filled = await applyAnswers(page, questions, answers);

  const remaining = await readQuestions(page);
  return { filled, unanswered: remaining.length };
}
