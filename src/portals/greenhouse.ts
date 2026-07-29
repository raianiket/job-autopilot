import { Page } from "playwright";
import { AppConfig, CandidateProfile } from "../types";
import { answerWithAI, applyAnswers, fill, readQuestions, uploadFile } from "./common";

/**
 * Greenhouse renders a plain server-side form with stable ids, so standard
 * fields map directly and everything else falls through to the AI pass.
 */
export async function fillGreenhouseForm(
  page: Page,
  profile: CandidateProfile,
  config: AppConfig
): Promise<{ filled: number; unanswered: number }> {
  await fill(page, ["#first_name", 'input[name="first_name"]'], profile.firstName ?? "");
  await fill(page, ["#last_name", 'input[name="last_name"]'], profile.lastName ?? "");
  await fill(page, ["#email", 'input[name="email"]'], profile.email ?? config.email ?? "");
  await fill(page, ["#phone", 'input[name="phone"]'], config.phone);

  await uploadFile(
    page,
    ['input[type="file"]#resume', 'input[type="file"][name*="resume" i]', 'input[type="file"]'],
    config.resumePath
  );

  if (config.coverLetterPath) {
    await uploadFile(
      page,
      ['input[type="file"]#cover_letter', 'input[type="file"][name*="cover" i]'],
      config.coverLetterPath
    );
  }

  for (const [selectors, value] of [
    [['input[name*="linkedin" i]', "#job_application_answers_attributes_0_text_value"], profile.linkedinUrl],
    [['input[name*="github" i]'], profile.githubUrl],
    [['input[name*="website" i]', 'input[name*="portfolio" i]'], profile.portfolioUrl ?? profile.website],
  ] as Array<[string[], string | undefined]>) {
    if (value) await fill(page, selectors, value);
  }

  const questions = await readQuestions(page);
  const answers = await answerWithAI(questions, profile, config);
  const filled = await applyAnswers(page, questions, answers);

  const remaining = await readQuestions(page);
  return { filled, unanswered: remaining.length };
}
