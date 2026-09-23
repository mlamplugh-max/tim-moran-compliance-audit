#!/usr/bin/env node
// Renders findings.json into a compact, single-page-ish HTML compliance
// memo, then uses Playwright's page.pdf() on that HTML (loaded as a local
// file:// URL) to produce report.pdf. No bot-detection concerns here (it's
// a local file, not a live site), so this doesn't need the hardened
// context from src/browser.js -- but it DOES still need the same
// pre-installed-browser-first launch logic (launchBrowser()) rather than a
// bare `chromium.launch()`, otherwise this step alone would crash in the
// cloud sandbox the exact same way the original bug did (version-mismatch
// against the pinned Playwright build, no network download available).

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./src/browser');

const FINDINGS_PATH = path.join(__dirname, 'findings.json');
const REPORT_HTML_PATH = path.join(__dirname, 'report.html');
const REPORT_PDF_PATH = path.join(__dirname, 'report.pdf');

const STATUS_LABEL = { good: 'GOOD', review: 'REVIEW', gap: 'GAP', error: 'UNVERIFIED' };

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function worstStatus(...statuses) {
  const order = { gap: 0, error: 1, review: 2, good: 3, info: 3 };
  return statuses.reduce((worst, s) => (order[s] < order[worst] ? s : worst), 'good');
}

function buildRows(site) {
  const c = site.checks;

  const cookieStatus = worstStatus(c.consentBanner.status, c.consentMode.status);
  const cookieFinding = c.consentMode.critical
    ? c.consentMode.finding
    : `${c.consentBanner.finding} ${c.consentMode.finding}`;

  return [
    { label: 'Cookie Consent & Tracking', status: cookieStatus, finding: cookieFinding },
    { label: 'Privacy Policy', status: c.privacyPolicy.status, finding: c.privacyPolicy.finding },
    { label: 'Terms of Use', status: c.termsOfUse.status, finding: c.termsOfUse.finding },
    { label: 'CCPA / Do-Not-Sell Mechanism', status: c.ccpaMechanism.status, finding: c.ccpaMechanism.finding },
    { label: 'Pricing Disclosure', status: c.pricingDisclosure.status, finding: c.pricingDisclosure.finding },
    { label: 'Accessibility Tooling', status: c.accessibilityTooling.status, finding: c.accessibilityTooling.finding },
  ];
}

function renderSiteCard(site) {
  const rows = buildRows(site);
  const critical = site.checks.consentMode && site.checks.consentMode.critical;

  return `
  <section class="card ${critical ? 'card-critical' : ''}">
    <header class="card-head">
      <div>
        <h2>${esc(site.name)}</h2>
        <div class="card-meta">${esc(site.url.replace(/^https?:\/\//, ''))} &middot; ${esc(site.platform)}</div>
      </div>
      <span class="pill pill-${site.overallStatus}">${STATUS_LABEL[site.overallStatus] || site.overallStatus.toUpperCase()}</span>
    </header>
    <div class="rows">
      ${rows
        .map(
          (r) => `
      <div class="row">
        <div class="row-label">
          <span class="dot dot-${r.status}"></span>${esc(r.label)}
        </div>
        <div class="row-finding">${esc(r.finding)}</div>
      </div>`
        )
        .join('')}
    </div>
  </section>`;
}

function renderActionItems(actionItems) {
  const top = actionItems.slice(0, 5);
  if (top.length === 0) {
    return '<p class="no-items">No priority action items -- all checks came back clean.</p>';
  }
  return `<ol class="action-list">${top.map((item) => `<li><span class="emph">${esc(item.site)}:</span> ${esc(item.text.replace(new RegExp('^' + item.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*'), ''))}</li>`).join('')}</ol>`;
}

function buildHtml(findings) {
  const generated = new Date(findings.generatedAt);
  const dateStr = generated.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tim Moran Compliance Audit</title>
<style>
  * { box-sizing: border-box; font-weight: 400; }
  body {
    margin: 0;
    font-family: Helvetica, Arial, sans-serif;
    color: #20262f;
    background: #f6f4ee;
    font-size: 9.5px;
    line-height: 1.35;
  }
  .page { padding: 22px 26px; }
  h1 {
    font-size: 19px;
    margin: 0 0 2px 0;
    color: #12335c;
    letter-spacing: 0.01em;
  }
  .subtitle { color: #5b6270; font-size: 10.5px; margin-bottom: 14px; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 14px;
  }
  .card {
    border: 1px solid #ddd8cb;
    border-radius: 6px;
    background: #ffffff;
    padding: 10px 12px;
  }
  .card-critical { border-color: #d99a94; box-shadow: 0 0 0 1px #d99a94 inset; }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 1px solid #eee9db;
    padding-bottom: 6px;
    margin-bottom: 6px;
  }
  .card-head h2 { font-size: 12px; margin: 0; color: #12335c; }
  .card-meta { font-size: 8px; color: #7b8291; margin-top: 1px; }
  .pill {
    font-size: 7.5px;
    letter-spacing: 0.06em;
    padding: 2px 7px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .pill-good { background: #e3f2e7; color: #1e7e34; border: 1px solid #a8d5b5; }
  .pill-review { background: #fdf3d9; color: #8a5d13; border: 1px solid #e8c977; }
  .pill-gap { background: #fbe4e4; color: #b3261e; border: 1px solid #e8a9a5; }
  .row { display: grid; grid-template-columns: 118px 1fr; gap: 6px; padding: 3px 0; border-top: 1px solid #eee9db; }
  .row:first-child { border-top: none; }
  .row-label { color: #12335c; display: flex; align-items: center; gap: 4px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .dot-good { background: #2f6b46; }
  .dot-review { background: #b5860f; }
  .dot-gap { background: #b3261e; }
  .dot-error { background: #78828e; }
  .row-finding { color: #454c58; }
  .footer-block {
    border: 1px solid #ddd8cb;
    border-radius: 6px;
    background: #fffefb;
    padding: 10px 14px;
  }
  .footer-block h3 { font-size: 12px; margin: 0 0 6px 0; color: #12335c; }
  .action-list { margin: 0; padding-left: 16px; }
  .action-list li { margin-bottom: 3px; }
  .no-items { margin: 0; color: #5b6270; }
  .legend { margin-top: 10px; font-size: 8px; color: #7b8291; }
  .legend span { margin-right: 12px; }
  .emph { color: #12335c; }
</style>
</head>
<body>
  <div class="page">
    <h1>Tim Moran Dealership Group &mdash; Privacy &amp; Cookie Consent Compliance Audit</h1>
    <div class="subtitle">Automated daily audit &middot; generated ${esc(dateStr)} &middot; 4 sites checked</div>

    <div class="grid">
      ${findings.sites.map(renderSiteCard).join('')}
    </div>

    <div class="footer-block">
      <h3>Priority Action Items</h3>
      ${renderActionItems(findings.actionItems)}
    </div>

    <div class="legend">
      <span><span class="emph">GOOD</span> = passes check</span>
      <span><span class="emph">REVIEW</span> = ambiguous, worth a manual look</span>
      <span><span class="emph">GAP</span> = confirmed compliance issue</span>
      <span><span class="emph">UNVERIFIED</span> = check could not complete (site blocked automated access)</span>
    </div>
  </div>
</body>
</html>`;
}

async function renderReport(findingsPath = FINDINGS_PATH) {
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const html = buildHtml(findings);
  fs.writeFileSync(REPORT_HTML_PATH, html);
  console.log(`[render-report] wrote ${REPORT_HTML_PATH}`);

  const { browser } = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${REPORT_HTML_PATH}`, { waitUntil: 'load' });
    await page.pdf({
      path: REPORT_PDF_PATH,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' },
    });
  } finally {
    await browser.close();
  }

  const sizeKb = (fs.statSync(REPORT_PDF_PATH).size / 1024).toFixed(1);
  console.log(`[render-report] wrote ${REPORT_PDF_PATH} (${sizeKb} KB)`);

  return { htmlPath: REPORT_HTML_PATH, pdfPath: REPORT_PDF_PATH };
}

if (require.main === module) {
  renderReport().catch((err) => {
    console.error('[render-report] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { renderReport, REPORT_HTML_PATH, REPORT_PDF_PATH, buildHtml };
