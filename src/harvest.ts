import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config";
import { loadProfile } from "./profile";

/**
 * Emits a browser-side harvester for the roles and locations in profile.json.
 *
 * There are two ways to collect LinkedIn jobs:
 *
 *   npm run discover   Playwright drives its own browser. Fully automated, but
 *                      needs its own login, because since Chrome 136 the browser
 *                      ignores --remote-debugging-port on the default profile
 *                      and an already-signed-in Chrome cannot be attached to.
 *
 *   npm run harvest    This command. Prints (and copies) a script to paste into
 *                      the console of a browser you are ALREADY signed into -
 *                      Chrome with the Claude or GPT extension, or plain
 *                      DevTools. No second login. Downloads a JSON file that
 *                      `npm run import` then ingests.
 */
const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/harvest-linkedin.js");

function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", { input: text });
      return true;
    }
    if (process.platform === "linux") {
      execSync("xclip -selection clipboard", { input: text });
      return true;
    }
  } catch {
    // No clipboard tool available; the script is printed instead.
  }
  return false;
}

function main(): void {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print");

  const config = loadConfig();
  const profile = loadProfile(config.profilePath);

  const roles = profile?.preferredRoles?.filter(Boolean) ?? [];
  const locations = profile?.preferredLocations?.filter(Boolean) ?? [];

  if (!roles.length || !locations.length) {
    throw new Error(
      `Set preferredRoles and preferredLocations in ${config.profilePath} first.`
    );
  }

  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`Harvester not found at ${SCRIPT_PATH}`);
  }

  // Bake the profile's roles and locations into the script so the browser side
  // needs no arguments and stays in sync with config.
  const template = fs.readFileSync(SCRIPT_PATH, "utf-8");
  const script = template
    .replace(
      /const ROLES = \[[\s\S]*?\];/,
      `const ROLES = ${JSON.stringify(roles, null, 2).replace(/\n/g, "\n  ")};`
    )
    .replace(
      /const LOCATIONS = \[[\s\S]*?\];/,
      `const LOCATIONS = ${JSON.stringify(locations)};`
    );

  const combos = roles.length * locations.length;

  if (printOnly) {
    process.stdout.write(script);
    return;
  }

  const copied = copyToClipboard(script);

  console.log(`
LinkedIn harvester ready — ${roles.length} role(s) x ${locations.length} location(s) = ${combos} searches.

  Roles     : ${roles.join(", ")}
  Locations : ${locations.join(", ")}

${copied ? "The script is on your clipboard." : "Copy the script printed by: npm run harvest -- --print"}

Steps
  1. Open a browser you are already signed into LinkedIn on, on any linkedin.com page.
  2. Open DevTools (Option+Cmd+I on macOS) and go to Console.
  3. Paste the script and press Return.
  4. Run:  await harvestLinkedIn()

It walks every role x location, checkpointing to sessionStorage after each search.
Navigation tears the script down, so after each page load re-paste and run:

     await harvestLinkedIn({ resume: true })

When it finishes it downloads linkedin-harvest.json. Then:

     npm run import -- --in ~/Downloads/linkedin-harvest.json

Other helpers available in the console:
     harvestDump()          download whatever is collected so far
     harvestPage(0, 6)      read a page of rows without downloading a file

Fully automated alternative that logs in separately:  npm run discover
`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("Harvest failed:", (err as Error).message);
    process.exit(1);
  }
}
