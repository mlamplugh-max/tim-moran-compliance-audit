// Shared helper: fetch a URL's rendered content, Firecrawl-primary,
// hardened-Playwright fallback. Every content-based check (privacy policy,
// terms of use, CCPA link, pricing) goes through this so Firecrawl -- which
// runs from its own infrastructure, not this cloud sandbox -- is the
// primary path for all of them, not just a Hyundai-inventory-specific
// fallback like it used to be. Playwright is only reached when Firecrawl is
// unavailable (no FIRECRAWL_API_KEY set) or a specific call to it fails.

const { fetchPageViaFirecrawl, htmlToText } = require('./firecrawl');
const { newHardenedContext, gotoResilient } = require('./browser');

async function fetchUrlPrimary(url, { getBrowser } = {}) {
  const fc = await fetchPageViaFirecrawl(url);
  if (fc.ok) {
    return { ok: true, source: 'firecrawl', html: fc.html, text: fc.markdown || htmlToText(fc.html), links: fc.links };
  }

  if (!getBrowser) {
    return { ok: false, source: 'none', reason: fc.reason };
  }

  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return { ok: false, source: 'none', reason: `browser-launch-failed: ${err.message}` };
  }

  const ctx = await newHardenedContext(browser);
  try {
    const page = await ctx.newPage();
    const nav = await gotoResilient(page, url, { maxAttempts: 2 });
    if (!nav.ok) {
      return { ok: false, source: 'playwright', reason: `nav-failed (status ${nav.status})` };
    }

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).map((a) => ({
        text: (a.textContent || '').trim(),
        href: a.href,
        rawHref: a.getAttribute('href'),
      }))
    );

    return { ok: true, source: 'playwright', html, text, links };
  } finally {
    await ctx.close();
  }
}

function findLink(links, pattern) {
  return (links || []).find((l) => pattern.test((l.text || '').trim()));
}

module.exports = { fetchUrlPrimary, findLink };
