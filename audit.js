#!/usr/bin/env node
// Runs every compliance check against all four Tim Moran dealership sites
// and writes findings.json. Each site gets its own fresh browser context
// (no shared cookies/localStorage) so consent state is genuinely
// first-visit every time, matching how a real new visitor would see it.

const fs = require('fs');
const path = require('path');
const { launchBrowser, newHardenedContext, gotoResilient } = require('./src/browser');
const sites = require('./src/sites');
const { runConsentCheck } = require('./src/checks/consent');
const { runPrivacyPolicyCheck } = require('./src/checks/privacyPolicy');
const { runTermsOfUseCheck } = require('./src/checks/termsOfUse');
const { runCcpaCheck } = require('./src/checks/ccpa');
const { runPricingCheck } = require('./src/checks/pricing');
const { runAccessibilityCheck } = require('./src/checks/accessibility');

const FINDINGS_PATH = path.join(__dirname, 'findings.json');

function computeOverallStatus(checks) {
  const statuses = Object.values(checks).map((c) => c.status);
  if (checks.consentMode && checks.consentMode.critical) return 'gap';
  if (statuses.includes('gap')) return 'gap';
  if (statuses.includes('error')) return 'review';
  if (statuses.includes('review')) return 'review';
  return 'good';
}

async function auditSite(browser, site) {
  console.log(`\n=== ${site.name} (${site.url}) ===`);
  const ctx = await newHardenedContext(browser);
  const page = await ctx.newPage();

  const checks = {};

  try {
    const consentResult = await runConsentCheck(page, site);
    checks.consentBanner = consentResult.bannerPresence;
    checks.consentMode = consentResult.consentMode;
    checks.trackers = { status: 'info', finding: `Trackers detected before interaction: ${consentResult.trackers.join(', ') || 'none'}.`, evidence: consentResult.trackers };
    console.log(`  consent banner: ${checks.consentBanner.status} | consent mode default: ${checks.consentMode.status}${checks.consentMode.critical ? ' (CRITICAL)' : ''}`);
  } catch (err) {
    console.log(`  consent check crashed: ${err.message}`);
    checks.consentBanner = { status: 'error', finding: `Consent check failed to run: ${err.message}`, evidence: null };
    checks.consentMode = { status: 'error', finding: `Consent check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.accessibilityTooling = await runAccessibilityCheck(page);
    console.log(`  accessibility tooling: ${checks.accessibilityTooling.status}`);
  } catch (err) {
    checks.accessibilityTooling = { status: 'error', finding: `Accessibility check failed: ${err.message}`, evidence: null };
  }

  try {
    checks.privacyPolicy = await runPrivacyPolicyCheck(page, site);
    console.log(`  privacy policy: ${checks.privacyPolicy.status}`);
  } catch (err) {
    console.log(`  privacy policy check crashed: ${err.message}`);
    checks.privacyPolicy = { status: 'error', finding: `Privacy policy check failed to run: ${err.message}`, evidence: null };
  }

  // Privacy Policy, Terms of Use (real-page sites), and CCPA checks each
  // open their own tab in this context rather than navigating the shared
  // homepage `page` away -- this keeps the homepage session alive, which
  // matters on sites with aggressive bot-detection that re-challenges on
  // every fresh top-level navigation (seen on timmoranhyundai.com).

  try {
    checks.termsOfUse = await runTermsOfUseCheck(page, site);
    console.log(`  terms of use: ${checks.termsOfUse.status}`);
  } catch (err) {
    console.log(`  terms of use check crashed: ${err.message}`);
    checks.termsOfUse = { status: 'error', finding: `Terms of Use check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.ccpaMechanism = await runCcpaCheck(page, site);
    console.log(`  ccpa mechanism: ${checks.ccpaMechanism.status}`);
  } catch (err) {
    console.log(`  ccpa check crashed: ${err.message}`);
    checks.ccpaMechanism = { status: 'error', finding: `CCPA check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.pricingDisclosure = await runPricingCheck(page, site);
    console.log(`  pricing disclosure: ${checks.pricingDisclosure.status}`);
  } catch (err) {
    console.log(`  pricing check crashed: ${err.message}`);
    checks.pricingDisclosure = { status: 'error', finding: `Pricing check failed to run: ${err.message}`, evidence: null };
  }

  await ctx.close();

  return {
    id: site.id,
    name: site.name,
    url: site.url,
    platform: site.platform,
    checks,
    overallStatus: computeOverallStatus(checks),
  };
}

function buildActionItems(siteResults) {
  const items = [];

  for (const site of siteResults) {
    if (site.checks.consentMode && site.checks.consentMode.critical) {
      items.push({
        priority: 0,
        site: site.name,
        text: `${site.name}: fix Consent Mode default -- it currently grants ad/analytics tracking before visitor interaction, undermining the cookie banner entirely.`,
      });
    }
  }

  for (const site of siteResults) {
    for (const [key, check] of Object.entries(site.checks)) {
      if (key === 'consentMode' && check.critical) continue; // already added above at top priority
      if (check.status === 'gap') {
        items.push({ priority: 1, site: site.name, text: `${site.name}: ${check.finding}` });
      }
    }
  }

  for (const site of siteResults) {
    for (const check of Object.values(site.checks)) {
      if (check.status === 'error') {
        items.push({ priority: 2, site: site.name, text: `${site.name}: ${check.finding}` });
      }
    }
  }

  items.sort((a, b) => a.priority - b.priority);
  return items.map(({ site, text }) => ({ site, text }));
}

async function runAudit() {
  const { browser, launchMode } = await launchBrowser();
  console.log(`[audit] browser launch mode: ${launchMode}`);

  const siteResults = [];
  try {
    for (const site of sites) {
      const result = await auditSite(browser, site);
      siteResults.push(result);
    }
  } finally {
    await browser.close();
  }

  const findings = {
    generatedAt: new Date().toISOString(),
    launchMode,
    sites: siteResults,
    actionItems: buildActionItems(siteResults),
  };

  fs.writeFileSync(FINDINGS_PATH, JSON.stringify(findings, null, 2));
  console.log(`\n[audit] wrote ${FINDINGS_PATH}`);
  return findings;
}

if (require.main === module) {
  runAudit().catch((err) => {
    console.error('[audit] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runAudit, FINDINGS_PATH };
