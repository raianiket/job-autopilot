/**
 * LinkedIn harvester — runs inside a browser tab you are already signed into.
 *
 * Why this exists: Playwright cannot reuse an already-signed-in Chrome, because
 * since Chrome 136 the browser silently ignores --remote-debugging-port on the
 * default profile. Rather than forcing a second login, this script runs in the
 * session you already have and writes a JSON file that `npm run import` ingests.
 *
 * Usage — paste into DevTools console on any linkedin.com page:
 *
 *   await harvestLinkedIn()                       // uses ROLES x LOCATIONS below
 *   await harvestLinkedIn({ roles: ['AI Engineer'], locations: ['Pune'] })
 *   await harvestLinkedIn({ resume: true })       // continue an interrupted run
 *
 * Progress is checkpointed to sessionStorage after every search, so a reload or
 * a mid-run failure never loses what was already collected.
 */
(function () {
  const STORE_KEY = "__ja_harvest";
  const CURSOR_KEY = "__ja_cursor";

  const ROLES = [
    "Lead Software Engineer",
    "Senior Software Engineer",
    "Senior Backend Engineer",
    "Backend Engineer",
    "Node.js Developer",
    "AI Engineer",
    "Full Stack Engineer",
    "Platform Engineer",
  ];
  const LOCATIONS = ["Hyderabad", "Pune", "Bangalore", "Chennai"];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) =>
    el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";

  function load(key, fallback) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "") ?? fallback;
    } catch {
      return fallback;
    }
  }
  const save = (key, val) => sessionStorage.setItem(key, JSON.stringify(val));

  /**
   * LinkedIn's <time datetime> attribute on a search card carries only a calendar
   * date, but the visible text says "3 hours ago" / "25 minutes ago". Converting
   * that relative text to an absolute instant is the only way to get better than
   * day precision out of the search results.
   */
  function parseRelativeAge(cardText) {
    const m = /(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i.exec(cardText || "");
    if (!m) return "";
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const perUnit = {
      minute: 60000,
      hour: 3600000,
      day: 86400000,
      week: 604800000,
      month: 2592000000,
    };
    const delta = n * perUnit[unit];
    if (!delta) return "";
    return new Date(Date.now() - delta).toISOString();
  }

  /**
   * Reads every currently-rendered card. LinkedIn virtualizes the list, so cards
   * only have contents while near the viewport — this must be called repeatedly
   * during the scroll, never once at the end.
   */
  function grabRendered(acc, role, location) {
    let added = 0;
    document.querySelectorAll("li[data-occludable-job-id]").forEach((card) => {
      const id = card.getAttribute("data-occludable-job-id");
      if (!id || acc[id]) return;

      const anchor = card.querySelector('a[href*="/jobs/view/"]');
      const title =
        txt(anchor && anchor.querySelector("span[aria-hidden='true']")) ||
        txt(card.querySelector('[class*="job-card-list__title"]')) ||
        txt(anchor);
      if (!title) return; // not rendered yet; a later pass will catch it

      const cardText = card.textContent || "";
      const timeEl = card.querySelector("time[datetime]");

      acc[id] = {
        job_url: "https://www.linkedin.com/jobs/view/" + id + "/",
        job_title: title,
        company:
          txt(card.querySelector(".artdeco-entity-lockup__subtitle")) ||
          txt(card.querySelector('[class*="subtitle"]')) ||
          "Unknown Company",
        location:
          txt(card.querySelector(".job-card-container__metadata-item")) ||
          txt(card.querySelector('[class*="metadata"] li')) ||
          location,
        apply_type: /easy apply/i.test(cardText) ? "easy_apply" : "external",
        // Prefer the relative text: it has hour/minute precision, whereas the
        // datetime attribute is only ever a calendar date.
        posted_at:
          parseRelativeAge(cardText) ||
          (timeEl ? timeEl.getAttribute("datetime") || "" : ""),
        role_category: role,
      };
      added += 1;
    });
    return added;
  }

  async function sweepCurrentPage(acc, role, location) {
    for (let pass = 0; pass < 2; pass += 1) {
      const cards = document.querySelectorAll("li[data-occludable-job-id]");
      if (!cards.length) break;

      for (const card of cards) {
        card.scrollIntoView({ block: "center" });
        await sleep(170);
        grabRendered(acc, role, location);
      }

      await sleep(1100);
      grabRendered(acc, role, location);

      // Reaching the bottom makes LinkedIn append a batch; stop when it doesn't.
      if (
        document.querySelectorAll("li[data-occludable-job-id]").length ===
        cards.length
      ) {
        break;
      }
    }
  }

  function download(rows) {
    const blob = new Blob([JSON.stringify(rows, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "linkedin-harvest.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  /**
   * Walks roles x locations as a flat, resumable cursor. Each search navigates
   * the tab, so state has to live in sessionStorage rather than a closure.
   */
  window.harvestLinkedIn = async function harvestLinkedIn(opts = {}) {
    const roles = opts.roles || ROLES;
    const locations = opts.locations || LOCATIONS;
    const perPage = opts.perPage || 25;

    const acc = opts.resume ? load(STORE_KEY, {}) : {};
    let cursor = opts.resume ? load(CURSOR_KEY, 0) : 0;
    const combos = [];
    for (const role of roles) for (const loc of locations) combos.push({ role, loc });

    if (!opts.resume) {
      save(STORE_KEY, acc);
      save(CURSOR_KEY, 0);
    }

    // A navigation tears down this script, so a run handles one search then
    // reloads into the next. On a fresh page the caller re-invokes with resume.
    for (; cursor < combos.length; cursor += 1) {
      const { role, loc } = combos[cursor];
      const want =
        "/jobs/search/?keywords=" +
        encodeURIComponent(role) +
        "&location=" +
        encodeURIComponent(loc) +
        "&sortBy=DD";

      if (location.pathname + location.search !== want) {
        save(CURSOR_KEY, cursor);
        save(STORE_KEY, acc);
        console.log(
          `[${cursor + 1}/${combos.length}] navigating: ${role} in ${loc} — ` +
            `re-run harvestLinkedIn({resume:true}) after load`
        );
        location.href = want;
        return { navigated: true, cursor, total: Object.keys(acc).length };
      }

      await sleep(2500);
      const before = Object.keys(acc).length;
      await sweepCurrentPage(acc, role, loc);
      save(STORE_KEY, acc);
      save(CURSOR_KEY, cursor + 1);

      const total = Object.keys(acc).length;
      console.log(
        `[${cursor + 1}/${combos.length}] ${role} in ${loc}: +${total - before} (total ${total})`
      );

      if (cursor + 1 < combos.length) {
        const next = combos[cursor + 1];
        location.href =
          "/jobs/search/?keywords=" +
          encodeURIComponent(next.role) +
          "&location=" +
          encodeURIComponent(next.loc) +
          "&sortBy=DD";
        return { navigated: true, cursor: cursor + 1, total };
      }
    }

    const rows = Object.values(acc);
    console.log(`Done. ${rows.length} unique job(s). Downloading...`);
    download(rows);
    return { done: true, count: rows.length, perPage };
  };

  /** Dump whatever has been collected so far without finishing the sweep. */
  window.harvestDump = function harvestDump() {
    const rows = Object.values(load(STORE_KEY, {}));
    console.log(`${rows.length} row(s) collected so far.`);
    download(rows);
    return rows.length;
  };

  /** Read a page of collected rows, for pulling data out without a file. */
  window.harvestPage = function harvestPage(offset = 0, limit = 6) {
    const rows = Object.values(load(STORE_KEY, {}));
    return {
      offset,
      limit,
      total: rows.length,
      hasMore: offset + limit < rows.length,
      rows: rows.slice(offset, offset + limit),
    };
  };

  console.log(
    "harvest-linkedin ready. Run: await harvestLinkedIn()\n" +
      "  resume:  await harvestLinkedIn({resume:true})\n" +
      "  dump:    harvestDump()\n" +
      "  page:    harvestPage(0, 6)"
  );
})();
