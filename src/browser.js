// Browser launch + navigation helpers.
//
// WHY THIS FILE EXISTS (read before touching launch options):
// All four Tim Moran sites sit behind bot-detection edges (Akamai on the
// three Team Velocity sites, Cloudflare on the Dealer Inspire Chevy site).
// Plain `chromium.launch({ headless: true })` with Playwright's bundled
// Chromium build gets a 403 "Access Denied" / "Attention Required" page on
// EVERY one of the four sites, even with a spoofed UA string and
// navigator.webdriver patched out — the bot signal is coming from the
// automation-flagged Chromium binary itself (bundled headless build),
// not just JS-level fingerprinting.
//
// Launching via `channel: 'chrome'` (a real installed Google Chrome binary,
// still headless, still driven by Playwright/CDP) plus a realistic
// User-Agent, matching sec-ch-ua client hints, and a google.com referer
// passes on all four sites. That combination is what this file implements.
// If a real Chrome channel isn't available in a given sandbox, we fall back
// to bundled Chromium — it will still work for sites that don't block it,
// and callers must handle `blocked: true` results gracefully rather than
// assume a checked page loaded.

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

async function launchBrowser() {
  try {
    const browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    return { browser, launchMode: 'chrome-channel' };
  } catch (err) {
    console.log(
      `[browser] real Chrome channel unavailable (${err.message}); falling back to bundled Chromium. ` +
        'Sites with strict bot-detection may return blocked pages — checks will report "blocked" rather than false results.'
    );
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    return { browser, launchMode: 'bundled-chromium' };
  }
}

async function newHardenedContext(browser) {
  const ctx = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
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
