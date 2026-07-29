const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;

/** In-flight and completed responses, so the same URL is never fetched twice per run. */
const cache = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retrying only helps for failures that might not repeat. A 404 means the company
 * is simply not a customer of that portal, and 401/403 will not change on retry
 * either, so those return immediately rather than burning five attempts each.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchOnce<T>(url: string): Promise<{ data: T | null; retry: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "job-autopilot" },
    });

    if (res.ok) return { data: (await res.json()) as T, retry: false };

    // Honour Retry-After when the server tells us how long to wait.
    if (isRetryableStatus(res.status)) {
      const after = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      if (!Number.isNaN(after) && after > 0) await sleep(Math.min(after, 30) * 1000);
      return { data: null, retry: true };
    }

    return { data: null, retry: false };
  } catch {
    // Network error, DNS failure, or our own timeout: worth one more try.
    return { data: null, retry: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Portal boards are public and unauthenticated, but a company token that is not
 * a customer of that portal returns 404. Callers treat every failure as "no jobs"
 * so one bad token never aborts a discover run.
 *
 * Transient failures are retried up to MAX_ATTEMPTS with exponential backoff
 * (0.5s, 1s, 2s, 4s). Identical URLs are de-duplicated for the life of the run.
 */
export async function fetchJson<T>(url: string): Promise<T | null> {
  const hit = cache.get(url);
  if (hit) return hit as Promise<T | null>;

  const task = (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const { data, retry } = await fetchOnce<T>(url);
      if (data !== null || !retry) return data;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    return null;
  })();

  cache.set(url, task);
  return task;
}

/** Job descriptions arrive as escaped HTML. Flatten to plain text for the AI prompts. */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
