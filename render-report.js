#!/usr/bin/env node
// Renders findings.json into report.pdf -- a compact, plain-memo-style
// compliance report built directly with src/pdfWriter.js (base14 Helvetica
// fonts only, no embedding, no images, no headless-browser dependency).
//
// This deliberately does NOT use Chromium/Playwright's page.pdf() the way
// it used to. That approach always embeds a subsetted copy of whatever font
// it actually rendered with (Chromium maps CSS "Helvetica"/sans-serif to a
// local system font and bakes a glyph subset into the PDF -- it does not
// use the PDF spec's built-in, non-embedded base14 fonts just because the
// CSS says "Helvetica"), which is what pushed the old report to ~78KB and
// made it too large for the cloud agent to hand-transcribe as base64
// reliably (no other attachment mechanism is available to it there -- see
// README.md). Writing the PDF directly with the actual base14 font
// references avoids embedding anything, so the whole report -- plain text
// and simple label:value rows, colored status words instead of filled
// pills/backgrounds, condensed finding phrases instead of full sentences --
// comes out well under 15KB. It also means this script no longer needs
// src/browser.js at all, removing one more thing that could crash the
// pipeline in the cloud sandbox.

const fs = require('fs');
const path = require('path');
const { PdfDoc, condense } = require('./src/pdfWriter');

const FINDINGS_PATH = path.join(__dirname, 'findings.json');
const REPORT_PDF_PATH = path.join(__dirname, 'report.pdf');

const STATUS_LABEL = { good: 'GOOD', review: 'REVIEW', gap: 'GAP', error: 'UNVERIFIED' };
const STATUS_COLOR = {
  good: [0.12, 0.42, 0.2],
  review: [0.55, 0.38, 0.02],
  gap: [0.68, 0.1, 0.09],
  error: [0.4, 0.44, 0.5],
};

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
    { label: 'Cookie Consent', status: cookieStatus, finding: cookieFinding },
    { label: 'Privacy Policy', status: c.privacyPolicy.status, finding: c.privacyPolicy.finding },
    { label: 'Terms of Use', status: c.termsOfUse.status, finding: c.termsOfUse.finding },
    { label: 'CCPA / Do-Not-Sell', status: c.ccpaMechanism.status, finding: c.ccpaMechanism.finding },
    { label: 'Pricing Disclosure', status: c.pricingDisclosure.status, finding: c.pricingDisclosure.finding },
    { label: 'Accessibility Tool', status: c.accessibilityTooling.status, finding: c.accessibilityTooling.finding },
  ];
}

function renderSiteCard(doc, site) {
  const rows = buildRows(site);
  const critical = site.checks.consentMode && site.checks.consentMode.critical;

  doc.hr();
  doc.text(
    `${site.name}${critical ? '  [CRITICAL]' : ''}   -   ${(STATUS_LABEL[site.overallStatus] || site.overallStatus).toUpperCase()}`,
    { size: 11.5, bold: true, color: critical ? STATUS_COLOR.gap : [0.07, 0.2, 0.36], gap: 1 }
  );
  doc.text(`${site.url.replace(/^https?:\/\//, '')}  -  ${site.platform}  -  checked via ${site.contentSource || 'unknown'}`, {
    size: 7.6,
    color: [0.48, 0.51, 0.57],
    gap: 5,
  });

  for (const r of rows) {
    const label = `${STATUS_LABEL[r.status] || r.status.toUpperCase()}  ${r.label}`;
    doc.row(label, condense(r.finding), { statusColor: STATUS_COLOR[r.status] || [0.07, 0.2, 0.36] });
  }
}

function renderActionItems(doc, actionItems) {
  doc.hr();
  doc.text('PRIORITY ACTION ITEMS', { size: 10.5, bold: true, color: [0.07, 0.2, 0.36], gap: 4 });

  const top = actionItems.slice(0, 5);
  if (top.length === 0) {
    doc.text('None. All checks came back clean.', { size: 8.5, color: [0.3, 0.33, 0.38] });
    return;
  }
  top.forEach((item, i) => {
    doc.row(`${i + 1}.`, `${item.site}: ${condense(item.text.replace(new RegExp(`^${item.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), ''), 160)}`, {
      labelWidth: 16,
      size: 8.3,
      statusColor: [0.3, 0.33, 0.38],
    });
  });
}

function buildPdf(findings) {
  const generated = new Date(findings.generatedAt);
  const dateStr = generated.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const doc = new PdfDoc();
  doc.text('Tim Moran Dealership Group - Privacy & Cookie Consent Compliance Audit', {
    size: 13.5,
    bold: true,
    color: [0.07, 0.2, 0.36],
    gap: 1,
  });
  doc.text(
    `Automated daily audit - ${dateStr} - 4 sites checked - ${findings.firecrawlPrimary ? 'Firecrawl primary' : 'Playwright only (no Firecrawl key)'}`,
    { size: 8.5, color: [0.36, 0.39, 0.44], gap: 5 }
  );

  for (const site of findings.sites) {
    renderSiteCard(doc, site);
  }

  renderActionItems(doc, findings.actionItems);

  doc.hr();
  doc.text('GOOD = passes check   REVIEW = worth a manual look   GAP = confirmed issue   UNVERIFIED = check could not complete', {
    size: 7,
    color: [0.48, 0.51, 0.57],
  });

  return doc;
}

async function renderReport(findingsPath = FINDINGS_PATH) {
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  const doc = buildPdf(findings);
  doc.save(REPORT_PDF_PATH);

  const sizeKb = (fs.statSync(REPORT_PDF_PATH).size / 1024).toFixed(1);
  console.log(`[render-report] wrote ${REPORT_PDF_PATH} (${sizeKb} KB)`);

  return { pdfPath: REPORT_PDF_PATH };
}

if (require.main === module) {
  renderReport().catch((err) => {
    console.error('[render-report] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { renderReport, REPORT_PDF_PATH, buildPdf };
