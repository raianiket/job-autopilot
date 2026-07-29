import fs from "node:fs";
import path from "node:path";
import { chromium, Browser, BrowserContext, Page } from "playwright";

const SESSION_FILE = path.resolve(process.cwd(), ".linkedin-session.json");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function isSessionValid(): boolean {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const { savedAt } = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return Date.now() - savedAt < SESSION_TTL_MS;
  } catch {
    return false;
  }
}

export async function saveSession(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: Date.now(), ...state }), "utf-8");
  console.log("Session saved (valid for 24 hours).");
}

export function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
}

/** Set when we attached to a real Chrome instead of launching our own. */
let attachedToExistingChrome = false;

export function isAttachedToExistingChrome(): boolean {
  return attachedToExistingChrome;
}

export async function createBrowser(headless = false, slowMo = 100): Promise<Browser> {
  // Attach to a Chrome the user already has open and logged in, if one is
  // listening. Start it with:
  //   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  const port = process.env.CHROME_CDP_PORT ?? "9222";
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    attachedToExistingChrome = true;
    console.log(`Connected to existing Chrome on port ${port} — reusing its logged-in session.`);
    return browser;
  } catch {
    attachedToExistingChrome = false;
    console.log(`No Chrome on port ${port} — launching a new browser.`);
    return chromium.launch({ headless, slowMo });
  }
}

export async function createContext(browser: Browser): Promise<BrowserContext> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // A CDP-attached Chrome already holds the real profile's cookies. Calling
  // newContext() here would hand back an empty context and throw the login away.
  if (attachedToExistingChrome) {
    const existing = browser.contexts()[0];
    if (existing) {
      console.log("Reusing the existing Chrome profile — no LinkedIn login needed.");
      return existing;
    }
    console.warn("Attached to Chrome but found no open context; falling back to a new one.");
  }

  if (isSessionValid()) {
    const { savedAt, ...state } = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    const remaining = Math.round((SESSION_TTL_MS - (Date.now() - savedAt)) / 60000);
    console.log(`Using cached session (expires in ~${remaining} min).`);
    return browser.newContext({ userAgent: ua, storageState: state, viewport: null });
  }

  return browser.newContext({ userAgent: ua, viewport: null });
}

export async function createPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // Position browser on right half of screen via CDP — no OS permission needed
  try {
    const browser = context.browser()!;
    const session = await browser.newBrowserCDPSession();
    const { targetInfos } = await (session as any).send("Target.getTargets", {});
    const target = (targetInfos as any[]).filter((t) => t.type === "page").pop();
    if (target) {
      const { windowId } = await (session as any).send("Browser.getWindowForTarget", { targetId: target.targetId });
      await (session as any).send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "fullscreen" },
      });
    }
    await session.detach();
  } catch {
    // CDP positioning unavailable — continue
  }
  return page;
}

export async function waitForLinkedInLogin(page: Page): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    const url = page.url();
    if (/linkedin\.com\/feed/i.test(url) || /linkedin\.com\/jobs/i.test(url)) {
      return;
    }

    const hasGlobalNav = await page
      .locator("nav.global-nav")
      .first()
      .count()
      .catch(() => 0);

    if (hasGlobalNav) {
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error("Login timeout after 15 minutes. Re-run and login again.");
}
