const { gotoResilient } = require('../browser');

async function runCcpaCheck(page, site) {
  const link = await page
    .locator('a')
    .filter({ hasText: /ccpa|do not sell|do not share|privacy request/i })
    .first();

  if ((await link.count()) === 0) {
    return { status: 'gap', finding: 'No CCPA/Do-Not-Sell/Privacy-Requests link was found in the footer.', evidence: null };
  }

  const linkText = (await link.textContent()) || '';
  const href = await link.getAttribute('href');
  if (!href || href.trim() === '' || href.trim() === '#') {
    return {
      status: 'gap',
      finding: `A link labeled "${linkText.trim()}" exists but has no real destination (empty/# href).`,
      evidence: { linkText: linkText.trim(), href },
    };
  }

  const target = href.startsWith('http') ? href : new URL(href, site.url).toString();
  // Separate tab so we don't navigate the caller's homepage session away.
  const ccpaPage = await page.context().newPage();
  const nav = await gotoResilient(ccpaPage, target, { maxAttempts: 2 });
  if (!nav.ok) {
    await ccpaPage.close();
    return {
      status: 'error',
      finding: `"${linkText.trim()}" link points to ${target} but the page could not be loaded to verify it resolves.`,
      evidence: { linkText: linkText.trim(), href: target, navError: nav.error },
    };
  }

  const text = await ccpaPage.evaluate(() => document.body.innerText);
  await ccpaPage.close();
  const substantial = text.replace(/\s+/g, ' ').trim().length > 200;

  return {
    status: substantial ? 'good' : 'review',
    finding: substantial
      ? `"${linkText.trim()}" resolves to a working page (${target}) with a request form or privacy content, not a dead link.`
      : `"${linkText.trim()}" resolves to ${target} but the page content looks thin -- confirm it's a real form/policy, not a stub.`,
    evidence: { linkText: linkText.trim(), href: target, textLength: text.length },
  };
}

module.exports = { runCcpaCheck };
