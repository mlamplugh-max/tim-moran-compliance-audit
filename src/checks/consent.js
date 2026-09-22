// Cookie banner presence + the critical Google Consent Mode default check.
//
// IMPORTANT: gtag.js pushes to window.dataLayer using the raw `arguments`
// object of each gtag() call, e.g. dataLayer.push(arguments). That object is
// array-LIKE (has numeric keys and .length) but Array.isArray() on it is
// FALSE. Checking `Array.isArray(entry) && entry[0] === 'consent'` silently
// finds nothing on every one of these sites. Index into entries directly
// (`entry && entry[0] === 'consent'`) instead -- this is the exact mistake
// that would make this script fail to reproduce the Ford bug.

const { gotoResilient } = require('../browser');

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

async function runConsentCheck(page, site) {
  const nav = await gotoResilient(page, site.url, { maxAttempts: 3 });

  if (!nav.ok) {
    return {
      bannerPresence: {
        status: 'error',
        finding: `Could not load ${site.url} after ${3} attempts (blocked by bot-detection or network error) -- consent check unverified.`,
        evidence: { status: nav.status, error: nav.error },
      },
      consentMode: {
        status: 'error',
        finding: 'Homepage did not load, so the pre-interaction Consent Mode default could not be read.',
        evidence: null,
      },
      trackers: [],
    };
  }

  // Banner presence + visibility
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

  // Tracker scripts present on first paint (before any consent interaction)
  const trackers = await page.evaluate((domains) => {
    const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
    return domains.filter((d) => scripts.some((s) => s.includes(d)));
  }, TRACKER_DOMAINS);

  // Consent Mode default, read BEFORE clicking anything
  const dlBefore = await page.evaluate(() => window.dataLayer || null);
  if (!dlBefore) {
    return {
      bannerPresence,
      consentMode: {
        status: 'review',
        finding: 'window.dataLayer was not found on this page -- either Google Tag Manager is not installed, or it had not initialized yet.',
        evidence: null,
      },
      trackers,
    };
  }

  const consentEntriesBefore = readConsentEntries(dlBefore);
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

  // Click Accept (or Decline) if findable, then confirm the mechanism responds
  try {
    const acceptBtn = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /^accept( all)?$/i })
      .first();
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

  return { bannerPresence, consentMode, trackers };
}

module.exports = { runConsentCheck, readConsentEntries };
