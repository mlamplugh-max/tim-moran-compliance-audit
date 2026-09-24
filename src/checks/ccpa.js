// CCPA / Do-Not-Sell mechanism check. Firecrawl-primary: the link itself
// comes from the shared homepage bundle (src/checks/consent.js); fetching
// its target page goes through src/contentFetch.js (Firecrawl-primary,
// hardened-Playwright fallback).

const { fetchUrlPrimary, findLink } = require('../contentFetch');

const CCPA_LINK_RE = /ccpa|do not sell|do not share|privacy request/i;

async function runCcpaCheck(homepage, site, getBrowser) {
  const link = findLink(homepage.links, CCPA_LINK_RE);
  if (!link) {
    return { status: 'gap', finding: 'No CCPA/Do-Not-Sell/Privacy-Requests link was found in the footer.', evidence: null };
  }

  const rawHref = (link.rawHref || '').trim();
  if (!rawHref || rawHref === '#') {
    return {
      status: 'gap',
      finding: `A link labeled "${link.text}" exists but has no real destination (empty/# href).`,
      evidence: { linkText: link.text, href: rawHref },
    };
  }

  const target = link.href && link.href.startsWith('http') ? link.href : new URL(rawHref, site.url).toString();
  const fetched = await fetchUrlPrimary(target, { getBrowser });
  if (!fetched.ok) {
    return {
      status: 'error',
      finding: `"${link.text}" link points to ${target} but the page could not be loaded to verify it resolves.`,
      evidence: { linkText: link.text, href: target, reason: fetched.reason },
    };
  }

  const substantial = fetched.text.replace(/\s+/g, ' ').trim().length > 200;

  return {
    status: substantial ? 'good' : 'review',
    finding: substantial
      ? `"${link.text}" resolves to a working page (${target}) with a request form or privacy content, not a dead link.`
      : `"${link.text}" resolves to ${target} but the page content looks thin -- confirm it's a real form/policy, not a stub.`,
    evidence: { linkText: link.text, href: target, source: fetched.source, textLength: fetched.text.length },
  };
}

module.exports = { runCcpaCheck };
