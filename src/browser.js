// Browser launch + navigation helpers.
//
// WHY THIS FILE EXISTS (read before touching launch options):
// All four Tim Moran sites sit behind bot-detection edges (Akamai on the
// three Team Velocity sites, Cloudflare on the Dealer Inspire Chevy site).
//
// The daily run happens inside a claude.ai cloud "routine" sandbox whose
// network egress is policy-restricted: it cannot download ANY browser
// binary (Chrome or Playwright's pinned Chromium revision both blocked --
// see incident 2026-09-23). That sandbox DOES already have a Chromium
// build pre-installed on disk at /opt/pw-browsers/chromium. Playwright's
// own `chromium.launch()` (no executablePath) refuses to use a
// pre-installed binary unless its build number happens to match the exact
// revision this pinned `playwright` version expects -- a mismatch there
// crashed the entire pipeline before a single site was visited, even
// though a perfectly usable browser was sitting right there.
//
// The fix: try a short list of known-good executable paths FIRST, in
// order, and hand the first one that exists on disk to
// `chromium.launch({ executablePath })` directly. That bypasses
// Playwright's revision-matching entirely -- we're not asking it to
// resolve or download a build, just to drive the binary we point it at.
// Only if none of those paths exist do we fall through to Playwright's
// normal resolution (`channel: 'chrome'`, then plain `chromium.launch()`,
// which may itself try to download its pinned build) -- this keeps local
// dev machines (which have neither of the sandbox's fixed paths but do
// have a real Chrome install or a `playwright install`-ed cache) working
// unchanged.
//
// Bot-detection evasion: bundled/pre-installed Chromium (not a real
// Chrome channel) CAN get past Akamai and Cloudflare on all four sites
// PROVIDED it is launched with the hardening below -- realistic UA,
// matching sec-ch-ua client hints, `navigator.webdriver` patched out,
// `--disable-blink-features=AutomationControlled`, a plausible viewport/
// locale/timezone, and a google.com referer on navigation. Verified
// 2026-09-23 against the live sites using Playwright's bundled Chromium
// via `executablePath` (i.e. deliberately NOT `channel: 'chrome'`) --
// reproduced the real Ford consent-mode-default-GRANTED finding and the
// real timmorancan.com / timmoranchevy.com consent-mode-default-DENIED
// findings. If a site's edge tightens further in the future and bundled
// Chromium starts getting blocked again, `gotoResilient` below reports
// `blocked: true` rather than crashing, and callers (see
// `src/checks/consent.js`) must degrade the tracking-pixel-consent check
// to an honest "COULD NOT VERIFY" status rather than crash or guess.

const fs = require('fs');
const { chromium } = require('playwright');

const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const EXTRA_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="129", "Not=A?Brand";v="8", "Google Chrome";v="129"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

const BLOCK_TITLE_RE = /access denied|attention required|request unsuccessful|errors\.edgesuite\.net/i;

// Fixed paths to a pre-installed browser binary, checked in order before
// ever asking Playwright to resolve/download its own pinned build. The
// first one only applies to the specific cloud sandbox this pipeline runs
// in today; the rest are best-effort for other environments (a machine
// with a real Chrome install baked in at a non-channel path, etc).
const KNOWN_EXECUTABLE_PATHS = [
  '/opt/pw-browsers/chromium', // pre-installed in the claude.ai cloud routine sandbox
  '/opt/google/chrome/chrome', // common path if a real Chrome install ever does land here
];

const HARDENING_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
];

async function tryLaunch(label, options) {
  const browser = await chromium.launch(options);
  return { browser, launchMode: label };
}

async function launchBrowser() {
  // Optional operator override (also handy for testing this fallback chain
  // without touching the fixed-path list) -- checked ahead of the built-in
  // paths so a new sandbox layout can be pointed at without a code change.
  const candidatePaths = process.env.AUDIT_BROWSER_EXECUTABLE_PATH
    ? [process.env.AUDIT_BROWSER_EXECUTABLE_PATH, ...KNOWN_EXECUTABLE_PATHS]
    : KNOWN_EXECUTABLE_PATHS;

  // 1. Known fixed paths to a browser binary already on disk -- launched
  //    via executablePath so Playwright never tries to resolve/download
  //    its own pinned revision.
  for (const execPath of candidatePaths) {
    if (fs.existsSync(execPath)) {
      try {
        return await tryLaunch(`executablePath:${execPath}`, {
          headless: true,
          executablePath: execPath,
          args: HARDENING_ARGS,
        });
      } catch (err) {
        console.log(`[browser] found ${execPath} on disk but it failed to launch (${err.message}); trying next option.`);
      }
    }
  }

  // 2. Whatever `channel: 'chrome'` / `channel: 'chromium'` resolves to on
  //    this machine (a real local Chrome install, useful for local dev).
  //    Channel resolution only checks known OS install locations -- it does
  //    not attempt a network download -- so this is safe to try even in a
  //    network-restricted sandbox; it just fails fast there.
  for (const channel of ['chrome', 'chromium']) {
    try {
      return await tryLaunch(`channel:${channel}`, {
        headless: true,
        channel,
        args: HARDENING_ARGS,
      });
    } catch (err) {
      console.log(`[browser] channel '${channel}' unavailable (${err.message}); trying next option.`);
    }
  }

  // 3. Last resort: let Playwright resolve/download its own pinned build.
  //    This is what makes a totally fresh local dev machine (that has run
  //    `npx playwright install chromium`, or is willing to try) work with
  //    no other setup -- it's simply not viable in the network-restricted
  //    cloud sandbox, which is exactly why steps 1-2 exist and are tried
  //    first.
  console.log('[browser] no pre-installed browser found via fixed paths or channels; falling back to chromium.launch() (may attempt to download the pinned build).');
  return tryLaunch('bundled-chromium-default', {
    headless: true,
    args: HARDENING_ARGS,
  });
}

async function newHardenedContext(browser) {
  const ctx = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles', // matches the dealerships' real market (Hemet, CA / Riverside County)
    extraHTTPHeaders: EXTRA_HEADERS,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

/**
 * Navigate with retries, treating bot-detection block pages as a distinct
 * outcome from a hard network error so callers can decide what to do
 * (retry, fall back to Firecrawl, or report "blocked" honestly).
 */
async function gotoResilient(page, url, { maxAttempts = 3, waitAfterMs = 2000 } = {}) {
  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: 'load',
        timeout: 30000,
        referer: 'https://www.google.com/',
      });
      lastStatus = response ? response.status() : null;
      await page.waitForTimeout(waitAfterMs);

      const title = await page.title().catch(() => '');
      const blocked =
        (lastStatus && lastStatus >= 400) || BLOCK_TITLE_RE.test(title || '');

      if (!blocked) {
        return { ok: true, blocked: false, status: lastStatus, attempts: attempt };
      }

      console.log(`[browser] attempt ${attempt}/${maxAttempts} blocked on ${url} (status ${lastStatus}, title "${title}")`);
    } catch (err) {
      lastError = err;
      console.log(`[browser] attempt ${attempt}/${maxAttempts} error on ${url}: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      await page.waitForTimeout(1500 * attempt);
    }
  }

  return { ok: false, blocked: true, status: lastStatus, error: lastError ? lastError.message : null };
}

module.exports = { launchBrowser, newHardenedContext, gotoResilient, REALISTIC_UA };
