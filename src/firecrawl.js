// Firecrawl API wrapper -- the PRIMARY fetch path for every compliance
// check that only needs rendered page content, and (as of this rewrite)
// also the primary path for the tracking-pixel consent-mode check via
// Firecrawl's `actions` + `executeJavascript`. Firecrawl runs from its own
// infrastructure, not this cloud sandbox, so it does not inherit the
// sandbox's own network fingerprint problem that gets three of the four
// sites 403'd by Akamai when reached directly from here. See
// src/contentFetch.js and src/checks/*.js for the fallback story: hardened
// Playwright (src/browser.js), used only when FIRECRAWL_API_KEY is unset
// or a specific Firecrawl call itself fails.
//
// Confirmed against Firecrawl's live docs 2026-09-24 (docs.firecrawl.dev,
// including the raw OpenAPI schema embedded in the /api-reference/endpoint/
// scrape page): the current stable endpoint is
// POST https://api.firecrawl.dev/v2/scrape. Its `actions` array supports
// (among others) `wait`, `click`, `write`, `press`, `scroll`, `scrape`
// (an explicit intermediate content snapshot), `screenshot`, `pdf`, and
// `executeJavascript` (params: `script: string`). Multiple actions can be
// combined in one request and run in order against a single real rendered
// page on Firecrawl's infrastructure. When one or more `executeJavascript`
// actions are used, their return values come back in
// `data.actions.javascriptReturns`, an array of `{ type, value }` objects,
// in the same order the executeJavascript actions were provided -- exactly
// what's needed to read `window.dataLayer` before and after simulating an
// Accept-button click. An explicit `{ type: 'scrape' }` action similarly
// appends an entry to `data.actions.scrapes` (`{ url, html }`) capturing
// page state at that point in the action sequence, which lets us snapshot
// the PRE-interaction page (for banner-presence / tracker-script detection)
// in the same call that also drives the click.

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape';

function getApiKey() {
  return process.env.FIRECRAWL_API_KEY || null;
}

function hasFirecrawlKey() {
  return !!getApiKey();
}

async function callFirecrawl(body, { label = 'scrape' } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return { ok: false, reason: 'no-api-key' };
  }

  try {
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`[firecrawl] ${label} failed for ${body.url}: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, reason: `http-${res.status}` };
    }

    const json = await res.json();
    if (!json || json.success === false || !json.data) {
      console.log(`[firecrawl] ${label} returned no data for ${body.url}`);
      return { ok: false, reason: 'empty-response' };
    }

    return { ok: true, data: json.data };
  } catch (err) {
    console.log(`[firecrawl] ${label} error for ${body.url}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

// Extracts <a> links (text + absolute href) from raw HTML. Deliberately a
// regex, not a DOM parser -- this repo has no HTML-parsing dependency, and
// the four target sites' nav/footer link markup is plain enough that a
// non-greedy regex over <a ...href="...">text</a> is reliable for the
// links these checks actually look for (Privacy Policy, Terms of Use,
// CCPA/Do-Not-Sell, category links).
function extractLinks(html, baseUrl) {
  if (!html) return [];
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawHref = m[1].trim();
    const text = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    let href = rawHref;
    try {
      href = new URL(rawHref, baseUrl).toString();
    } catch {
      // leave as-is (javascript:, mailto:, empty, "#", etc.)
    }
    links.push({ text, href, rawHref });
  }
  return links;
}

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Primary content fetch for a URL: markdown + raw html + extracted links.
 * This is what every content-based check (privacy policy, terms of use,
 * CCPA link, pricing, accessibility widget) calls FIRST, before falling
 * back to a live hardened-Playwright browser (see src/contentFetch.js).
 */
async function fetchPageViaFirecrawl(url) {
  const result = await callFirecrawl(
    { url, formats: ['markdown', 'html'], onlyMainContent: false, timeout: 30000 },
    { label: 'fetchPage' }
  );
  if (!result.ok) return result;

  const html = result.data.html || '';
  const markdown = result.data.markdown || '';
  return {
    ok: true,
    url,
    markdown,
    html,
    links: extractLinks(html, url),
    statusCode: result.data.metadata && result.data.metadata.statusCode,
  };
}

// Kept for backward-compat callers that only want markdown text back.
async function fetchMarkdownViaFirecrawl(url) {
  const page = await fetchPageViaFirecrawl(url);
  if (!page.ok) return page;
  return { ok: true, markdown: page.markdown };
}

/**
 * Reads window.dataLayer's gtag consent entries BEFORE and AFTER simulating
 * a click on the cookie banner's Accept/Decline control, all on Firecrawl's
 * own infrastructure -- the primary method for the tracking-pixel
 * consent-mode check (see src/checks/consent.js). An explicit `scrape`
 * action right after page load also captures a pre-interaction HTML
 * snapshot, which doubles as this site's homepage content bundle for every
 * other check (link discovery, tracker-script scan, accessibility-widget
 * detection) -- one Firecrawl call covers both jobs.
 */
async function checkConsentModeViaFirecrawl(url) {
  const readDataLayerScript = `
    (function() {
      try {
        var dl = window.dataLayer || null;
        return dl ? JSON.stringify(dl) : null;
      } catch (e) { return null; }
    })();
  `;
  const clickAcceptScript = `
    (function() {
      var re = /^(accept( all)?|decline( all)?|reject( all)?)$/i;
      var els = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'));
      var el = els.find(function(e) {
        var t = (e.textContent || '').trim();
        return re.test(t);
      });
      if (el) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return (el.textContent || '').trim();
      }
      return null;
    })();
  `;

  const result = await callFirecrawl(
    {
      url,
      formats: [],
      timeout: 30000,
      actions: [
        { type: 'scrape' },
        { type: 'executeJavascript', script: readDataLayerScript },
        { type: 'executeJavascript', script: clickAcceptScript },
        { type: 'wait', milliseconds: 2000 },
        { type: 'executeJavascript', script: readDataLayerScript },
      ],
    },
    { label: 'consentMode' }
  );

  if (!result.ok) return result;

  const actions = result.data.actions || {};
  const scrapes = actions.scrapes || [];
  const returns = actions.javascriptReturns || [];

  const parseJson = (entry) => {
    if (!entry || entry.value == null) return null;
    try {
      return JSON.parse(entry.value);
    } catch {
      return null;
    }
  };

  // Order matches the actions array above: 3 executeJavascript actions ->
  // 3 javascriptReturns entries, in the same order (the `scrape` and
  // `wait` actions don't produce javascriptReturns entries of their own).
  const dataLayerBefore = parseJson(returns[0]);
  const clickedButtonText = returns[1] ? returns[1].value : null;
  const dataLayerAfter = parseJson(returns[2]);

  return {
    ok: true,
    url,
    preInteractionHtml: scrapes[0] ? scrapes[0].html : '',
    dataLayerBefore,
    clickedButtonText,
    dataLayerAfter,
  };
}

/**
 * Dispatches a click on a link matched by text (regex source string, case
 * insensitive), waits, then reads back whichever modal/dialog-shaped
 * element with matching heading text is now visible -- the Firecrawl
 * equivalent of the Playwright dispatched-MouseEvent + DOM-scan pattern
 * used for the Team Velocity sites' JS-modal "Terms of Use" link (see
 * src/checks/termsOfUse.js).
 */
async function clickLinkAndReadModalViaFirecrawl(url, linkTextPattern, modalHeadingPattern) {
  const clickScript = `
    (function() {
      var re = new RegExp(${JSON.stringify(linkTextPattern)}, 'i');
      var els = Array.prototype.slice.call(document.querySelectorAll('a'));
      var el = els.find(function(e) { return re.test((e.textContent || '').trim()); });
      if (el) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    })();
  `;
  const readModalScript = `
    (function() {
      var re = new RegExp(${JSON.stringify(modalHeadingPattern)}, 'i');
      var candidates = Array.prototype.slice
        .call(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]'))
        .filter(function(el) {
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          var t = el.textContent || '';
          return re.test(t) && t.length > 300 && t.length < 200000;
        })
        .sort(function(a, b) { return b.textContent.length - a.textContent.length; });
      if (!candidates.length) return null;
      var el = candidates[0];
      return JSON.stringify({ textLength: el.textContent.length, sample: el.textContent.trim().slice(0, 160) });
    })();
  `;

  const result = await callFirecrawl(
    {
      url,
      formats: [],
      timeout: 30000,
      actions: [
        { type: 'executeJavascript', script: clickScript },
        { type: 'wait', milliseconds: 1500 },
        { type: 'executeJavascript', script: readModalScript },
      ],
    },
    { label: 'clickLinkAndReadModal' }
  );

  if (!result.ok) return result;

  const returns = (result.data.actions && result.data.actions.javascriptReturns) || [];
  const clicked = returns[0] ? returns[0].value : null;
  const modalRaw = returns[1] ? returns[1].value : null;
  let modal = null;
  try {
    modal = modalRaw ? JSON.parse(modalRaw) : null;
  } catch {
    modal = null;
  }

  return { ok: true, clicked, modal };
}

module.exports = {
  hasFirecrawlKey,
  fetchPageViaFirecrawl,
  fetchMarkdownViaFirecrawl,
  checkConsentModeViaFirecrawl,
  clickLinkAndReadModalViaFirecrawl,
  extractLinks,
  htmlToText,
};
