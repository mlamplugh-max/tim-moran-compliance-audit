const { gotoResilient } = require('../browser');

async function runPrivacyPolicyCheck(page, site) {
  const link = await page
    .locator('a')
    .filter({ hasText: /^\s*privacy policy\s*$/i })
    .first();

  if ((await link.count()) === 0) {
    return {
      status: 'gap',
      finding: 'No "Privacy Policy" link was found in the page.',
      evidence: null,
    };
  }

  const href = await link.getAttribute('href');
  const target = href && href.startsWith('http') ? href : new URL(href || '/privacy-policy', site.url).toString();

  // Use a separate tab in the same context (shares cookies/consent state)
  // rather than navigating the caller's homepage tab away -- keeps the
  // homepage session alive, which matters on sites with aggressive
  // bot-detection that re-challenges on every fresh navigation.
  const policyPage = await page.context().newPage();
  const nav = await gotoResilient(policyPage, target, { maxAttempts: 2 });
  if (!nav.ok) {
    await policyPage.close();
    return {
      status: 'error',
      finding: `Privacy Policy link found (${target}) but the page could not be loaded to verify content.`,
      evidence: { href: target, navError: nav.error },
    };
  }

  const iframeSrc = await policyPage.locator('iframe[src*="termly.io"]').first().getAttribute('src').catch(() => null);
  const pageText = await policyPage.evaluate(() => document.body.innerText);

  let policyText = pageText;
  let iframeFetchOk = null;
  if (iframeSrc) {
    // Termly's policy-viewer is a client-rendered SPA shell -- a plain
    // fetch() only returns ~1.5KB of empty HTML before its JS runs. Load it
    // in a real page instead so the actual policy text renders.
    try {
      const iframePage = await page.context().newPage();
      const iframeNav = await gotoResilient(iframePage, iframeSrc, { maxAttempts: 2, waitAfterMs: 1500 });
      iframeFetchOk = iframeNav.ok;
      if (iframeNav.ok) {
        policyText = await iframePage.evaluate(() => document.body.innerText);
      }
      await iframePage.close();
    } catch (err) {
      iframeFetchOk = false;
    }
  }

  await policyPage.close();

  const substantial = policyText.replace(/\s+/g, ' ').trim().length > 1000;
  const mentionsCalifornia = /california/i.test(policyText);
  const mentionsCcpaMechanism = /(do not sell|do not share|global privacy control|\bgpc\b|opt[- ]out of the sale)/i.test(policyText);

  let status;
  if (!substantial) {
    status = 'gap';
  } else if (mentionsCalifornia && mentionsCcpaMechanism) {
    status = 'good';
  } else {
    status = 'review';
  }

  const findingParts = [];
  findingParts.push(
    substantial
      ? `Privacy Policy link resolves to real policy content${iframeSrc ? ' (served via a Termly iframe, loaded directly to confirm it renders real content, not an empty shell)' : ''}.`
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
      iframeSrc,
      iframeFetchOk,
      textLength: policyText.length,
      mentionsCalifornia,
      mentionsCcpaMechanism,
    },
  };
}

module.exports = { runPrivacyPolicyCheck };
