// Terms of Use check.
//
// On the Team Velocity sites (timmorancan/ford/hyundai) the "Terms Of Use"
// link has an empty href and opens a JS modal. A plain Playwright
// `.click()` sometimes doesn't trigger the framework's click handler
// reliably on these -- dispatching a real bubbling MouseEvent does. On
// timmoranchevy.com (Dealer Inspire) it's a normal link to a real page.

const { gotoResilient } = require('../browser');

async function findVisibleModalWithHeading(page, headingRe) {
  return page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const t = el.textContent || '';
        return re.test(t) && t.length > 300 && t.length < 200000;
      })
      // largest matching element = the actual modal body, not a tiny header fragment
      .sort((a, b) => b.textContent.length - a.textContent.length);
    if (!candidates.length) return null;
    const el = candidates[0];
    return { textLength: el.textContent.length, sample: el.textContent.trim().slice(0, 160) };
  }, headingRe);
}

async function runTermsOfUseCheck(page, site) {
  const link = await page
    .locator('a')
    .filter({ hasText: /^\s*terms\s*(of\s*use|&\s*conditions)\s*$/i })
    .first();

  if ((await link.count()) === 0) {
    return { status: 'gap', finding: 'No "Terms of Use" link was found in the page.', evidence: null };
  }

  const href = await link.getAttribute('href');
  const isRealPage = href && href.trim() !== '' && href.trim() !== '#' && !href.trim().startsWith('javascript:');

  if (isRealPage) {
    const target = href.startsWith('http') ? href : new URL(href, site.url).toString();
    // Separate tab so we don't navigate the caller's homepage session away.
    const termsPage = await page.context().newPage();
    const nav = await gotoResilient(termsPage, target, { maxAttempts: 2 });
    if (!nav.ok) {
      await termsPage.close();
      return {
        status: 'error',
        finding: `Terms of Use link found (${target}) but the page could not be loaded to verify content.`,
        evidence: { href: target, navError: nav.error },
      };
    }
    const text = await termsPage.evaluate(() => document.body.innerText);
    await termsPage.close();
    const substantial = text.replace(/\s+/g, ' ').trim().length > 500;
    return {
      status: substantial ? 'good' : 'gap',
      finding: substantial
        ? `Terms of Use is a real page (${target}) with substantive content (${text.length} chars).`
        : `Terms of Use link resolves to ${target} but the page content looks thin (${text.length} chars).`,
      evidence: { href: target, mode: 'page', textLength: text.length },
    };
  }

  // JS-modal pattern: dispatch a real bubbling click event, not `.click()`.
  await link.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })));
  await page.waitForTimeout(1500);

  const modal = await findVisibleModalWithHeading(page, 'TERMS OF USE');

  return {
    status: modal && modal.textLength > 500 ? 'good' : 'gap',
    finding: modal
      ? `Terms of Use link opens a modal with substantive content (${modal.textLength} chars) after a dispatched click event.`
      : 'Terms of Use link did not open a visible modal with substantive content (a plain .click() would likely have missed this -- confirmed using a dispatched MouseEvent).',
    evidence: { href, mode: 'modal', modal },
  };
}

module.exports = { runTermsOfUseCheck };
