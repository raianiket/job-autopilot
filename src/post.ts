import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBrowser, createContext, createPage, waitForLinkedInLogin } from "./browser";
import { loadConfig } from "./config";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function generatePost(topic: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY env var is not set.");
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Write an engaging LinkedIn post about: "${topic}"

Guidelines:
- 150-250 words
- Start with a strong hook (not "I" as first word)
- Share an interesting fact, insight, or innovation angle
- Use short paragraphs (1-3 lines max)
- Add 3-5 relevant emojis naturally within the text (not all at the end)
- End with a thought-provoking question to drive comments
- Add 5-8 relevant hashtags on the last line
- Sound like a senior software engineer sharing genuine knowledge
- No fluff, no generic motivational filler
- Do NOT use em dashes (—). Use a comma, period, or colon instead.
- If there is a well-known public URL related to the topic (official announcement, article, docs), include it naturally in the post body.

Return ONLY the post text. No intro, no explanation.`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== "text") {
    throw new Error("Unexpected response type from Claude.");
  }
  return block.text.trim();
}

async function postToLinkedIn(content: string, imagePath?: string): Promise<void> {
  const config = loadConfig(undefined);
  const profile = (() => { try { return JSON.parse(require("node:fs").readFileSync(config.profilePath, "utf-8")); } catch { return {}; } })();
  const portfolioUrl: string = profile.portfolioUrl ?? "";
  const browser = await createBrowser(config.headless, config.browserSlowMo);
  const context = await createContext(browser);
  const page = await createPage(context);

  try {
    console.log("\nOpening LinkedIn...");
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

    if (config.email) {
      const emailInput = page.locator('input[name="session_key"], input#username').first();
      if (await emailInput.count()) {
        await emailInput.fill(config.email);
      }
    }

    if (process.env.LINKEDIN_PASSWORD) {
      const passwordInput = page.locator('input[name="session_password"], input#password').first();
      if (await passwordInput.count()) {
        await passwordInput.fill(process.env.LINKEDIN_PASSWORD);
      }
    }

    console.log("Complete the login in the browser. Waiting up to 15 minutes...");
    await waitForLinkedInLogin(page);
    console.log("Login detected. Opening post editor...\n");

    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // Click "Start a post" button in the feed
    const startPost = page.getByRole("button", { name: /start a post/i }).first();
    await startPost.waitFor({ state: "visible", timeout: 20000 });
    await startPost.click();
    await page.waitForTimeout(2000);

    // Upload image BEFORE typing (LinkedIn renders it above text)
    if (imagePath) {
      const absImagePath = path.resolve(imagePath);
      if (!fs.existsSync(absImagePath)) {
        console.warn(`⚠ Image not found at ${absImagePath} — skipping image upload.`);
      } else {
        console.log("Uploading image...");
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 15000 }),
          page.locator([
            'button[aria-label*="Add a photo"]',
            'button[aria-label*="photo"]',
            'button[aria-label*="Photo"]',
            'button[aria-label*="media"]',
            'button[aria-label*="Media"]',
            '.share-creation-state__footer button:first-child',
            'button.share-box-footer__social-action:first-child',
          ].join(", ")).first().click(),
        ]);
        await fileChooser.setFiles(absImagePath);
        await page.waitForTimeout(5000);
        console.log("✓ Image uploaded.");
      }
    }

    // Type into the post editor
    const editor = page.locator('.ql-editor, div[role="textbox"][contenteditable="true"], div.editor-content[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(500);

    // Type content line by line to preserve formatting
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      await editor.type(lines[i], { delay: 12 });
      if (i < lines.length - 1) {
        await page.keyboard.press("Enter");
      }
    }

    await page.waitForTimeout(1000);

    // Screenshot to verify content before posting
    await page.screenshot({ path: "data/post_preview.png" });
    console.log("Screenshot saved to data/post_preview.png — check it looks correct.");
    await page.waitForTimeout(2000);

    // Click Post button (exact match to avoid "Boost post" etc.)
    const postBtn = page.getByRole("button", { name: /^post$/i }).first();
    await postBtn.waitFor({ state: "visible", timeout: 10000 });
    await postBtn.click();

    console.log("Post submitted! Waiting for confirmation...");
    await page.waitForTimeout(5000);
    console.log("✓ Post published successfully.");

    // Post first comment with the portfolio link
    console.log("\nAdding portfolio link as first comment...");
    try {
      const commentBox = page.locator('div[aria-label*="comment"], div[data-placeholder*="comment"]').first();
      await commentBox.waitFor({ state: "visible", timeout: 10000 });
      await commentBox.click();
      await commentBox.type(portfolioUrl, { delay: 20 });
      await page.waitForTimeout(500);
      const submitComment = page.getByRole("button", { name: /^post$/i }).first();
      await submitComment.click();
      await page.waitForTimeout(2000);
      console.log("✓ Portfolio link posted as first comment.");
    } catch {
      console.log(`⚠ Could not auto-post comment — add the link manually: ${portfolioUrl}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main(): Promise<void> {
  try {
    console.log("=== LinkedIn Post Generator ===\n");

    const cfg = loadConfig(undefined);
    const contentFlagIndex = process.argv.indexOf("--content");
    const contentFileFlagIndex = process.argv.indexOf("--content-file");
    const imageFlagIndex = process.argv.indexOf("--image");
    const autoConfirm = process.argv.includes("--yes");

    const prewrittenContent = contentFlagIndex !== -1 ? process.argv[contentFlagIndex + 1] : null;
    const contentFile = contentFileFlagIndex !== -1 ? process.argv[contentFileFlagIndex + 1] : null;
    const imagePath = imageFlagIndex !== -1 ? process.argv[imageFlagIndex + 1] : undefined;

    let post: string;
    let topic: string | undefined;

    if (contentFile) {
      post = fs.readFileSync(path.resolve(contentFile), "utf-8").trim();
      console.log("Using content from file.\n");
    } else if (prewrittenContent) {
      post = prewrittenContent;
      console.log("Using provided content.\n");
    } else {
      topic = await ask("Enter the topic for your post: ");
      if (!topic) {
        console.log("No topic entered. Exiting.");
        rl.close();
        return;
      }

      console.log("\nGenerating post with Claude...\n");
      post = await generatePost(topic, cfg.claudeModel);
    }

    console.log("─".repeat(60));
    console.log(post);
    console.log("─".repeat(60));
    console.log(`\nCharacter count: ${post.length}`);
    if (imagePath) console.log(`Image: ${imagePath}`);

    let finalPost = post;

    if (!autoConfirm) {
      const verify = await ask("\nDoes this look good? (yes to proceed / no to regenerate / q to quit): ");

      if (verify.toLowerCase() === "q") {
        console.log("Cancelled.");
        rl.close();
        return;
      }

      if (verify.toLowerCase() === "no") {
        const feedback = await ask("Any specific feedback to improve it? (or press Enter to just regenerate): ");
        const newTopic = feedback ? `${topic!}. Additional notes: ${feedback}` : topic!;
        console.log("\nRegenerating...\n");
        finalPost = await generatePost(newTopic, cfg.claudeModel);
        console.log("─".repeat(60));
        console.log(finalPost);
        console.log("─".repeat(60));
      }

      const confirm = await ask("\nPost this to LinkedIn? (yes/no): ");
      rl.close();

      if (confirm.toLowerCase() !== "yes") {
        console.log("Cancelled. Post was NOT published.");
        return;
      }
    } else {
      rl.close();
      console.log("\nAuto-confirmed. Posting to LinkedIn...");
    }

    await postToLinkedIn(finalPost, imagePath);
  } catch (err) {
    rl.close();
    console.error("Post failed:", err);
    process.exitCode = 1;
  }
}

main();
