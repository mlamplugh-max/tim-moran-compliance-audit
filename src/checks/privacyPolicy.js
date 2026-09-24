// Privacy Policy presence + content check. Firecrawl-primary: the homepage
// bundle passed in already has links discovered via Firecrawl or Playwright
// (whichever fetched the homepage in src/checks/consent.js), so this check
// just needs to fetch the target page itself, Firecrawl-primary /
// Playwright-fallback, via src/contentFetch.js.

const { fetchUrlPrimary } = require('../contentFetch');

function findPrivacyPolicyLink(links) {
  return (links || []).find((l) => /^\s*privacy policy\s*$/i.test(l.text || ''));
}

async function runPrivacyPolicyCheck(homepage, site, getBrowser) {
  const link = findPrivacyPolicyLink(homepage.links);
  if (!link) {
    return { status: 'gap', finding: 'No "Privacy Policy" link was found in the page.', evidence: null };
  }

  const target =
    link.href && link.href.startsWith('http') ? link.href : new URL(link.rawHref || '/privacy-policy', site.url).toString();

  const fetched = await fetchUrlPrimary(target, { getBrowser });
  if (!fetched.ok) {
    return {
      status: 'error',
      finding: `Privacy Policy link found (${target}) but the page could not be loaded to verify content.`,
      evidence: { href: target, reason: fetched.reason },
    };
  }

  let policyText = fetched.text;
  let iframeSrc = null;
  let iframeFetchOk = null;

  const iframeMatch = fetched.html && fetched.html.match(/<iframe[^>]*src=["']([^"']*termly\.io[^"']*)["']/i);
  if (iframeMatch) {
    iframeSrc = iframeMatch[1];
    // Termly's policy-viewer is a client-rendered SPA shell -- fetching the
    // iframe URL directly (Firecrawl-primary, same as the parent page)
    // renders the actual policy text rather than the ~1.5KB empty shell a
    // plain fetch() would return.
    const iframeFetched = await fetchUrlPrimary(iframeSrc, { getBrowser });
    iframeFetchOk = iframeFetched.ok;
    if (iframeFetched.ok) {
      policyText = iframeFetched.text;
    }
  }

  const substantial = policyText.replace(/\s+/g, ' ').trim().length > 1000;
  const mentionsCalifornia = /california/i.test(policyText);
  const mentionsCcpaMechanism = /(do not sell|do not share|global privacy control|\bgpc\b|opt[- ]out of the sale)/i.test(policyText);

  let status;
  if (!substantial) status = 'gap';
  else if (mentionsCalifornia && mentionsCcpaMechanism) status = 'good';
  else status = 'review';

  const findingParts = [];
  findingParts.push(
    substantial
      ? `Privacy Policy link resolves to real policy content${
          iframeSrc ? ' (served via a Termly iframe, fetched directly to confirm it renders real content, not an empty shell)' : ''
        }.`
      : `Privacy Policy link resolves, but the page content looks thin (${policyText.length} chars) -- may be an empty shell or failed to load.`
  );
  findingParts.push(
    mentionsCalifornia && mentionsCcpaMechanism
      ? 'Policy text is CCPA/CPRA-shaped: mentions California and a Do Not Sell/Share or GPC mechanism.'
      : 'Policy text does not clearly mention both California residents and a Do Not Sell/Share/GPC mechanism -- worth a manual read.'
  );

  return {
    status,
    finding: findingParts.join(' '),
    evidence: {
      href: target,
      source: fetched.source,
      iframeSrc,
      iframeFetchOk,
      textLength: policyText.length,
      mentionsCalifornia,
      mentionsCcpaMechanism,
    },
  };
}

module.exports = { runPrivacyPolicyCheck };
