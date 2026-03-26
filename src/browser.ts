import { chromium, Browser, BrowserContext, Page } from "playwright";

export async function createBrowser(headless = false, slowMo = 100): Promise<Browser> {
  return chromium.launch({ headless, slowMo });
}

export async function createContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
}

export async function createPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
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
