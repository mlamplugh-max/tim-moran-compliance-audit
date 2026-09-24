// Cookie banner presence + the critical Google Consent Mode default check.
//
// Firecrawl-primary as of this rewrite: Firecrawl's `actions` support
// includes `executeJavascript` (see src/firecrawl.js), which lets us read
// window.dataLayer's gtag consent entries before AND after simulating a
// click on the Accept/Decline control -- all from Firecrawl's own
// infrastructure, which doesn't inherit the cloud sandbox's own network
// fingerprint problem that gets three of the four sites 403'd by Akamai
// when reached directly from here. Hardened Playwright (src/browser.js) is
// kept ONLY as a fallback for when FIRECRAWL_API_KEY is unset or the
// Firecrawl call itself fails -- in that case this ONE check may honestly
// report "COULD NOT VERIFY" if the sandbox's own browser also gets
// blocked, but every OTHER check for that site still runs via Firecrawl
// independently (see audit.js) instead of getting blanked out too, the way
// a single failed page.goto() used to wipe out the whole site's results.
//
// IMPORTANT: gtag.js pushes to window.dataLayer using the raw `arguments`
// object of each gtag() call, e.g. dataLayer.push(arguments). That object is
// array-LIKE (has numeric keys and .length) but Array.isArray() on it is
// FALSE. Checking `Array.isArray(entry) && entry[0] === 'consent'` silently
// finds nothing on every one of these sites. Index into entries directly
// (`entry && entry[0] === 'consent'`) instead -- this is the exact mistake
// that would make this script fail to reproduce the Ford bug. This still
// holds true after the JSON.stringify/JSON.parse round trip Firecrawl's
// executeJavascript return value goes through: the outer dataLayer stays a
// real array, but each `arguments`-shaped entry becomes a plain object with
// "0"/"1"/"2" string keys -- bracket indexing (entry[0]) behaves the same
// on both, so no logic below needs to change to account for that.

const { gotoResilient, newHardenedContext } = require('../browser');
const { checkConsentModeViaFirecrawl, extractLinks, htmlToText } = require('../firecrawl');

const TRACKER_DOMAINS = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'connect.facebook.net',
  'bat.bing.com',
  'analytics.tiktok.com',
];

function readConsentEntries(dataLayer) {
  const out = [];
  for (const entry of dataLayer || []) {
    if (entry && entry[0] === 'consent') {
      out.push({ command: entry[1], params: entry[2] || null });
    }
  }
  return out;
}

function isFullyDenied(params) {
  if (!params) return false;
  const keys = Object.keys(params).filter((k) => k !== 'security_storage');
  return keys.length > 0 && keys.every((k) => params[k] === 'denied');
}

function isAnyTrackingGranted(params) {
  if (!params) return false;
  const trackingKeys = ['ad_storage', 'analytics_storage', 'ad_personalization', 'ad_user_data'];
  return trackingKeys.some((k) => params[k] === 'granted');
}

function detectBannerFromHtml(html) {
  const text = htmlToText(html).slice(0, 6000);
  const mentionsCookies = /essential cookies|this website uses cookies|we use cookies|cookie (consent|policy|use)/i.test(text);

  // Static-HTML best effort: we can't compute real layout
  // (getBoundingClientRect) outside a browser, so "visible" here means "not
  // marked display:none/visibility:hidden/hidden inline" -- good enough for
  // a presence signal, which is all this check needs.
  const btnRe = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const buttons = [];
  let m;
  while ((m = btnRe.exec(html))) {
    const attrs = m[2] || '';
    const label = htmlToText(m[3]).trim();
    if (!/^(accept( all)?|decline( all)?|reject( all)?|preferences)$/i.test(label)) continue;
    const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|\bhidden\b/i.test(attrs);
    buttons.push({ text: label, visible: !hidden });
  }

  const visibleButtons = buttons.filter((b) => b.visible);
  const hasAcceptDecline =
    visibleButtons.some((b) => /^accept/i.test(b.text)) &&
    (visibleButtons.some((b) => /^decline/i.test(b.text)) || visibleButtons.some((b) => /^reject/i.test(b.text)));

  return {
    status: mentionsCookies && hasAcceptDecline ? 'good' : 'gap',
    finding:
      mentionsCookies && hasAcceptDecline
        ? `Visible cookie-consent banner renders on first load with working Accept/Decline/Preferences controls (${visibleButtons.length} buttons found).`
        : 'No visible, properly-labeled cookie-consent banner was detected on first load.',
    evidence: { mentionsCookies, buttons },
  };
}

function detectTrackersFromHtml(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  return TRACKER_DOMAINS.filter((d) => scripts.some((s) => s.includes(d)));
}

function buildConsentModeResult(dataLayerBefore, dataLayerAfter, clickedButtonText) {
  if (!dataLayerBefore) {
    return {
      status: 'review',
      finding: 'window.dataLayer was not found on this page -- either Google Tag Manager is not installed, or it had not initialized yet.',
      evidence: null,
    };
  }

  const consentEntriesBefore = readConsentEntries(dataLayerBefore);
  const defaultEntry = consentEntriesBefore.find((e) => e.command === 'default');

  let consentMode;
  if (!defaultEntry) {
    consentMode = {
      status: 'review',
      finding: 'No gtag consent "default" command was found in dataLayer -- Consent Mode may not be configured at all.',
      evidence: { consentEntriesBefore },
    };
  } else if (isAnyTrackingGranted(defaultEntry.params)) {
    consentMode = {
      status: 'gap',
      critical: true,
      finding:
        `Consent Mode default is GRANTED for tracking storage before any visitor interaction ` +
        `(ad_storage=${defaultEntry.params.ad_storage}, analytics_storage=${defaultEntry.params.analytics_storage}). ` +
        `Google Ads, GA4, Meta Pixel, and Bing UET can all fire on the very first pageview regardless of the banner choice.`,
      evidence: { default: defaultEntry.params },
    };
  } else if (isFullyDenied(defaultEntry.params)) {
    consentMode = {
      status: 'good',
      finding: 'Consent Mode default correctly DENIES ad/analytics storage before any visitor interaction; tracking only begins after Accept.',
      evidence: { default: defaultEntry.params },
    };
  } else {
    consentMode = {
      status: 'review',
      finding: 'Consent Mode default is a mixed state (some categories granted, some denied) -- worth a manual look.',
      evidence: { default: defaultEntry.params },
    };
  }

  if (!clickedButtonText) {
    consentMode.postClick = { mechanismResponded: null, note: 'No clickable Accept/Decline control found.' };
  } else {
    const consentEntriesAfter = readConsentEntries(dataLayerAfter || []);
    const updateEntry = consentEntriesAfter.find((e) => e.command === 'update');
    consentMode.postClick = updateEntry
      ? { mechanismResponded: true, update: updateEntry.params }
      : { mechanismResponded: false };
    if (consentMode.status === 'gap' && consentMode.critical) {
      consentMode.finding += updateEntry
        ? ' Clicking the banner does push a consent "update" event, but tracking was already live before that click happened.'
        : ' No consent "update" event was observed after clicking, either -- the banner may not be wired to Consent Mode at all.';
    }
  }

  return consentMode;
}

async function runConsentCheckFirecrawl(site) {
  const fc = await checkConsentModeViaFirecrawl(site.url);
  if (!fc.ok) return fc;

  const preHtml = fc.preInteractionHtml || '';
  const bannerPresence = detectBannerFromHtml(preHtml);
  const trackers = detectTrackersFromHtml(preHtml);
  const consentMode = buildConsentModeResult(fc.dataLayerBefore, fc.dataLayerAfter, fc.clickedButtonText);

  // Quality gate, added after live testing 2026-09-24: the Team Velocity
  // sites run a KPA + Termly ("resource-blocker", autoBlock=on)
  // consent-management stack that appears to gate whether it EVER pushes a
  // gtag `consent` `default` command based on the requester's own IP
  // geolocation. A Firecrawl fetch of timmoranford.com saw GTM containers
  // load (tracker script tags present) but zero `consent` commands of any
  // kind in dataLayer; a hardened-Playwright fetch of the identical live
  // URL from a real machine, moments later, reproduced the actual
  // GRANTED-default bug exactly. That means "no consent default found" from
  // Firecrawl here is NOT a trustworthy "Consent Mode isn't configured"
  // signal -- it's Firecrawl's request simply never being treated as the
  // regulated-state visitor this check needs to evaluate. When that
  // specific pattern shows up (no default entry, but trackers clearly
  // loaded), flag the consent signal as untrustworthy so the caller gets a
  // second opinion from hardened Playwright -- WITHOUT discarding this
  // homepage content bundle, which is unaffected by the same issue (plain
  // page content, not gated by IP-based consent-vendor logic).
  const noDefaultFound = consentMode.status === 'review' && /No gtag consent "default" command/.test(consentMode.finding);
  const consentTrustworthy = !(noDefaultFound && trackers.length > 0);

  return {
    ok: true,
    source: 'firecrawl',
    consentTrustworthy,
    bannerPresence,
    consentMode,
    trackers,
    homepage: { html: preHtml, text: htmlToText(preHtml), links: extractLinks(preHtml, site.url) },
  };
}

async function runConsentCheckPlaywright(site, getBrowser) {
  const browser = await getBrowser();
  const ctx = await newHardenedContext(browser);
  const page = await ctx.newPage();

  const nav = await gotoResilient(page, site.url, { maxAttempts: 3 });

  if (!nav.ok) {
    await ctx.close();
    return {
      ok: false,
      source: 'playwright',
      bannerPresence: {
        status: 'error',
        finding: `Could not load ${site.url} after 3 attempts (blocked by bot-detection or network error) -- consent check unverified.`,
        evidence: { status: nav.status, error: nav.error },
      },
      consentMode: {
        status: 'error',
        finding:
          'COULD NOT VERIFY -- bot-detection blocked automated access in this environment (or the homepage failed to load), so the pre-interaction tracking-pixel Consent Mode default could not be read. This is not a "granted" or "denied" finding; it is an unknown that needs a manual check.',
        evidence: { status: nav.status, error: nav.error },
      },
      trackers: [],
      homepage: null,
    };
  }

  const bannerInfo = await page.evaluate(() => {
    const bodyText = document.body.innerText.slice(0, 4000);
    const mentionsCookies = /essential cookies|this website uses cookies|we use cookies|cookie (consent|policy|use)/i.test(
      bodyText
    );
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return /^(accept( all)?|decline( all)?|reject( all)?|preferences)$/i.test(t);
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || '').trim(), visible: r.width > 0 && r.height > 0 };
      });
    return { mentionsCookies, buttons };
  });

  const visibleButtons = bannerInfo.buttons.filter((b) => b.visible);
  const hasAcceptDecline =
    visibleButtons.some((b) => /^accept/i.test(b.text)) &&
    (visibleButtons.some((b) => /^decline/i.test(b.text)) || visibleButtons.some((b) => /^reject/i.test(b.text)));

  const bannerPresence = {
    status: bannerInfo.mentionsCookies && hasAcceptDecline ? 'good' : 'gap',
    finding:
      bannerInfo.mentionsCookies && hasAcceptDecline
        ? `Visible cookie-consent banner renders on first load with working Accept/Decline/Preferences controls (${visibleButtons.length} buttons found).`
        : 'No visible, properly-labeled cookie-consent banner was detected on first load.',
    evidence: { mentionsCookies: bannerInfo.mentionsCookies, buttons: bannerInfo.buttons },
  };

  const trackers = await page.evaluate((domains) => {
    const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
    return domains.filter((d) => scripts.some((s) => s.includes(d)));
  }, TRACKER_DOMAINS);

  const dlBefore = await page.evaluate(() => window.dataLayer || null);

  let consentMode;
  if (!dlBefore) {
    consentMode = {
      status: 'review',
      finding: 'window.dataLayer was not found on this page -- either Google Tag Manager is not installed, or it had not initialized yet.',
      evidence: null,
    };
  } else {
    const consentEntriesBefore = readConsentEntries(dlBefore);
    const defaultEntry = consentEntriesBefore.find((e) => e.command === 'default');
    if (!defaultEntry) {
      consentMode = {
        status: 'review',
        finding: 'No gtag consent "default" command was found in dataLayer -- Consent Mode may not be configured at all.',
        evidence: { consentEntriesBefore },
      };
    } else if (isAnyTrackingGranted(defaultEntry.params)) {
      consentMode = {
        status: 'gap',
        critical: true,
        finding:
          `Consent Mode default is GRANTED for tracking storage before any visitor interaction ` +
          `(ad_storage=${defaultEntry.params.ad_storage}, analytics_storage=${defaultEntry.params.analytics_storage}). ` +
          `Google Ads, GA4, Meta Pixel, and Bing UET can all fire on the very first pageview regardless of the banner choice.`,
        evidence: { default: defaultEntry.params },
      };
    } else if (isFullyDenied(defaultEntry.params)) {
      consentMode = {
        status: 'good',
        finding: 'Consent Mode default correctly DENIES ad/analytics storage before any visitor interaction; tracking only begins after Accept.',
        evidence: { default: defaultEntry.params },
      };
    } else {
      consentMode = {
        status: 'review',
        finding: 'Consent Mode default is a mixed state (some categories granted, some denied) -- worth a manual look.',
        evidence: { default: defaultEntry.params },
      };
    }
  }

  try {
    const acceptBtn = page.locator('button, a, [role="button"]').filter({ hasText: /^accept( all)?$/i }).first();
    const declineBtn = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /^decline( all)?$|^reject( all)?$/i })
      .first();
    const target = (await acceptBtn.count()) > 0 ? acceptBtn : declineBtn;
    if ((await target.count()) > 0) {
      await target.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      const dlAfter = await page.evaluate(() => window.dataLayer || []);
      const consentEntriesAfter = readConsentEntries(dlAfter);
      const updateEntry = consentEntriesAfter.find((e) => e.command === 'update');
      consentMode.postClick = updateEntry
        ? { mechanismResponded: true, update: updateEntry.params }
        : { mechanismResponded: false };
      if (consentMode.status === 'gap' && consentMode.critical) {
        consentMode.finding += updateEntry
          ? ' Clicking the banner does push a consent "update" event, but tracking was already live before that click happened.'
          : ' No consent "update" event was observed after clicking, either -- the banner may not be wired to Consent Mode at all.';
      }
    } else {
      consentMode.postClick = { mechanismResponded: null, note: 'No clickable Accept/Decline control found.' };
    }
  } catch (err) {
    consentMode.postClick = { mechanismResponded: null, note: `Click failed: ${err.message}` };
  }

  const html = await page.content();
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map((a) => ({
      text: (a.textContent || '').trim(),
      href: a.href,
      rawHref: a.getAttribute('href'),
    }))
  );
  const text = await page.evaluate(() => document.body.innerText);

  await ctx.close();

  return { ok: true, source: 'playwright', bannerPresence, consentMode, trackers, homepage: { html, text, links } };
}

/**
 * Runs the consent-mode + banner-presence check AND returns a homepage
 * content bundle (html/text/links) that every other check for this site
 * reuses -- one successful fetch (Firecrawl or Playwright) serves the
 * whole site's audit rather than each check re-fetching the homepage.
 */
async function runConsentCheck(site, getBrowser) {
  const fc = await runConsentCheckFirecrawl(site);

  if (!fc.ok) {
    console.log(`  [consent] Firecrawl unavailable/failed for ${site.url} (${fc.reason}); falling back to hardened Playwright.`);
    return runConsentCheckPlaywright(site, getBrowser);
  }

  if (fc.consentTrustworthy) return fc;

  // Firecrawl's homepage content is fine -- only its consent-mode SIGNAL
  // looks unreliable (see the quality-gate comment in
  // runConsentCheckFirecrawl above). Get a second opinion from hardened
  // Playwright for banner/consent/trackers specifically, but keep
  // Firecrawl's homepage bundle either way rather than re-fetching it --
  // this is exactly what keeps every OTHER check (privacy policy, terms,
  // CCPA, pricing, accessibility) working via Firecrawl even when this one
  // check needs Playwright, instead of one shaky signal blanking out the
  // whole site's results.
  console.log(`  [consent] Firecrawl's consent-mode signal for ${site.url} looks unreliable; confirming with hardened Playwright.`);
  const pw = await runConsentCheckPlaywright(site, getBrowser);
  return {
    ok: true,
    source: pw.ok ? 'playwright(consent)+firecrawl(homepage)' : 'firecrawl(homepage only, consent unverified)',
    bannerPresence: pw.bannerPresence,
    consentMode: pw.consentMode,
    trackers: pw.ok ? pw.trackers : fc.trackers,
    homepage: fc.homepage,
  };
}

module.exports = { runConsentCheck, readConsentEntries, isFullyDenied, isAnyTrackingGranted };
