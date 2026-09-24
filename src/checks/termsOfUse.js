// Terms of Use check.
//
// On the Team Velocity sites (timmorancan/ford/hyundai) the "Terms Of Use"
// link has an empty href and opens a JS modal instead of navigating. On
// timmoranchevy.com (Dealer Inspire) it's a normal link to a real page.
//
// Firecrawl-primary for both shapes: a real page is just a normal
// Firecrawl-primary fetch (src/contentFetch.js); the JS-modal pattern uses
// Firecrawl's `executeJavascript` actions to dispatch the same bubbling
// click event Playwright used to dispatch, then reads back whichever
// modal/dialog is now visible -- see clickLinkAndReadModalViaFirecrawl in
// src/firecrawl.js. Hardened Playwright is kept as a fallback for the
// modal case only when that Firecrawl call fails.

const { fetchUrlPrimary, findLink } = require('../contentFetch');
const { clickLinkAndReadModalViaFirecrawl } = require('../firecrawl');
const { newHardenedContext, gotoResilient } = require('../browser');

const LINK_TEXT_RE = /^\s*terms\s*(of\s*use|&\s*conditions)\s*$/i;
const LINK_TEXT_SOURCE = '^\\s*terms\\s*(of\\s*use|&\\s*conditions)\\s*$';
const MODAL_HEADING_SOURCE = 'TERMS OF USE';

async function findVisibleModalWithHeadingPlaywright(page, headingRe) {
  return page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = el.textContent || '';
        return re.test(t) && t.length > 300 && t.length < 200000;
      })
      .sort((a, b) => b.textContent.length - a.textContent.length);
    if (!candidates.length) return null;
    const el = candidates[0];
    return { textLength: el.textContent.length, sample: el.textContent.trim().slice(0, 160) };
  }, headingRe);
}

async function runTermsOfUsePlaywrightModal(site, getBrowser) {
  const browser = await getBrowser();
  const ctx = await newHardenedContext(browser);
  try {
    const page = await ctx.newPage();
    const nav = await gotoResilient(page, site.url, { maxAttempts: 2 });
    if (!nav.ok) {
      return {
        status: 'error',
        finding: `Terms of Use link opens a JS modal, but the homepage could not be reloaded to click it (status ${nav.status}).`,
        evidence: null,
      };
    }
    const link = page.locator('a').filter({ hasText: LINK_TEXT_RE }).first();
    if ((await link.count()) === 0) {
      return { status: 'gap', finding: 'No "Terms of Use" link was found in the page.', evidence: null };
    }
    await link.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })));
    await page.waitForTimeout(1500);
    const modal = await findVisibleModalWithHeadingPlaywright(page, MODAL_HEADING_SOURCE);
    return {
      status: modal && modal.textLength > 500 ? 'good' : 'gap',
      finding: modal
        ? `Terms of Use link opens a modal with substantive content (${modal.textLength} chars) after a dispatched click event.`
        : 'Terms of Use link did not open a visible modal with substantive content.',
      evidence: { mode: 'modal', source: 'playwright', modal },
    };
  } finally {
    await ctx.close();
  }
}

async function runTermsOfUseCheck(homepage, site, getBrowser) {
  const link = findLink(homepage.links, LINK_TEXT_RE);
  if (!link) {
    return { status: 'gap', finding: 'No "Terms of Use" link was found in the page.', evidence: null };
  }

  const rawHref = (link.rawHref || '').trim();
  const isRealPage = rawHref !== '' && rawHref !== '#' && !/^javascript:/i.test(rawHref);

  if (isRealPage) {
    const target = link.href && link.href.startsWith('http') ? link.href : new URL(rawHref, site.url).toString();
    const fetched = await fetchUrlPrimary(target, { getBrowser });
    if (!fetched.ok) {
      return {
        status: 'error',
        finding: `Terms of Use link found (${target}) but the page could not be loaded to verify content.`,
        evidence: { href: target, reason: fetched.reason },
      };
    }
    const substantial = fetched.text.replace(/\s+/g, ' ').trim().length > 500;
    return {
      status: substantial ? 'good' : 'gap',
      finding: substantial
        ? `Terms of Use is a real page (${target}) with substantive content (${fetched.text.length} chars).`
        : `Terms of Use link resolves to ${target} but the page content looks thin (${fetched.text.length} chars).`,
      evidence: { href: target, mode: 'page', source: fetched.source, textLength: fetched.text.length },
    };
  }

  // JS-modal pattern (Team Velocity sites): Firecrawl-primary.
  const fc = await clickLinkAndReadModalViaFirecrawl(site.url, LINK_TEXT_SOURCE, MODAL_HEADING_SOURCE);
  if (fc.ok) {
    const modal = fc.modal;
    return {
      status: modal && modal.textLength > 500 ? 'good' : 'gap',
      finding: modal
        ? `Terms of Use link opens a modal with substantive content (${modal.textLength} chars) after a simulated click (via Firecrawl).`
        : 'Terms of Use link did not open a visible modal with substantive content (checked via a Firecrawl-simulated click).',
      evidence: { href: rawHref, mode: 'modal', source: 'firecrawl', modal },
    };
  }

  console.log(`  [terms-of-use] Firecrawl click-and-read failed for ${site.url} (${fc.reason}); falling back to hardened Playwright.`);
  if (!getBrowser) {
    return {
      status: 'error',
      finding: 'Terms of Use link opens a JS modal, but Firecrawl could not verify it and no Playwright fallback is available.',
      evidence: { href: rawHref, mode: 'modal', reason: fc.reason },
    };
  }
  return runTermsOfUsePlaywrightModal(site, getBrowser);
}

module.exports = { runTermsOfUseCheck };
