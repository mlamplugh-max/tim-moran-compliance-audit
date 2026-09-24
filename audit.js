#!/usr/bin/env node
// Runs every compliance check against all four Tim Moran dealership sites
// and writes findings.json.
//
// Firecrawl (src/firecrawl.js, src/contentFetch.js) is now the PRIMARY
// fetch path for every check -- it runs from Firecrawl's own
// infrastructure, not this cloud sandbox, so it doesn't inherit the
// sandbox's own network fingerprint problem that gets three of the four
// sites 403'd by Akamai when reached directly from here. The hardened
// Playwright browser (src/browser.js) is kept ONLY as a fallback, used when
// FIRECRAWL_API_KEY is unset or a specific Firecrawl call fails -- and it's
// launched lazily (only on first actual need), so a fully successful
// Firecrawl-primary run never has to launch a browser at all.
//
// Each check fetches independently (Firecrawl-primary, Playwright-fallback
// per call) rather than sharing one browser page/session, so one check's
// failure (e.g. the consent-mode check degrading to "COULD NOT VERIFY"
// because Akamai blocks the sandbox's own browser) no longer blanks out
// every other check for that site the way a single failed page.goto() used
// to.

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./src/browser');
const { hasFirecrawlKey } = require('./src/firecrawl');
const sites = require('./src/sites');
const { runConsentCheck } = require('./src/checks/consent');
const { runAccessibilityCheck } = require('./src/checks/accessibility');
const { runPrivacyPolicyCheck } = require('./src/checks/privacyPolicy');
const { runTermsOfUseCheck } = require('./src/checks/termsOfUse');
const { runCcpaCheck } = require('./src/checks/ccpa');
const { runPricingCheck } = require('./src/checks/pricing');

const FINDINGS_PATH = path.join(__dirname, 'findings.json');

function computeOverallStatus(checks) {
  const statuses = Object.values(checks).map((c) => c.status);
  if (checks.consentMode && checks.consentMode.critical) return 'gap';
  if (statuses.includes('gap')) return 'gap';
  if (statuses.includes('error')) return 'review';
  if (statuses.includes('review')) return 'review';
  return 'good';
}

// Lazily launches (and reuses) ONE Playwright browser for the whole run,
// only on the first check that actually needs the Playwright fallback. A
// fully successful Firecrawl-primary run never calls this at all, so it
// never has to survive the cloud sandbox's own browser-launch/bot-detection
// problems to produce a report.
function makeLazyBrowser() {
  let promise = null;
  let launchMode = null;
  const get = () => {
    if (!promise) {
      promise = launchBrowser().then(({ browser, launchMode: mode }) => {
        launchMode = mode;
        return browser;
      });
    }
    return promise;
  };
  return { get, wasLaunched: () => promise !== null, launchModeUsed: () => launchMode };
}

async function auditSite(getBrowser, site) {
  console.log(`\n=== ${site.name} (${site.url}) ===`);
  const checks = {};

  const consentResult = await runConsentCheck(site, getBrowser);
  checks.consentBanner = consentResult.bannerPresence;
  checks.consentMode = consentResult.consentMode;
  checks.trackers = {
    status: 'info',
    finding: `Trackers detected before interaction: ${(consentResult.trackers || []).join(', ') || 'none'}.`,
    evidence: consentResult.trackers,
  };
  console.log(
    `  consent banner: ${checks.consentBanner.status} | consent mode default: ${checks.consentMode.status}` +
      `${checks.consentMode.critical ? ' (CRITICAL)' : ''} | source: ${consentResult.source}`
  );

  // homepage.links/html/text feed every other check's link discovery and
  // presence signals. If the consent check itself failed on BOTH Firecrawl
  // and Playwright, homepage is null here and the other checks below will
  // each independently retry Firecrawl for their own target URL (they
  // don't depend on this bundle succeeding) -- they just won't have a
  // homepage link to discover their target from, so they'll report "gap"
  // (no link found) rather than crash.
  const homepage = consentResult.homepage || { html: '', text: '', links: [] };

  try {
    checks.accessibilityTooling = runAccessibilityCheck(homepage);
    console.log(`  accessibility tooling: ${checks.accessibilityTooling.status}`);
  } catch (err) {
    checks.accessibilityTooling = { status: 'error', finding: `Accessibility check failed: ${err.message}`, evidence: null };
  }

  try {
    checks.privacyPolicy = await runPrivacyPolicyCheck(homepage, site, getBrowser);
    console.log(`  privacy policy: ${checks.privacyPolicy.status}`);
  } catch (err) {
    console.log(`  privacy policy check crashed: ${err.message}`);
    checks.privacyPolicy = { status: 'error', finding: `Privacy policy check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.termsOfUse = await runTermsOfUseCheck(homepage, site, getBrowser);
    console.log(`  terms of use: ${checks.termsOfUse.status}`);
  } catch (err) {
    console.log(`  terms of use check crashed: ${err.message}`);
    checks.termsOfUse = { status: 'error', finding: `Terms of Use check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.ccpaMechanism = await runCcpaCheck(homepage, site, getBrowser);
    console.log(`  ccpa mechanism: ${checks.ccpaMechanism.status}`);
  } catch (err) {
    console.log(`  ccpa check crashed: ${err.message}`);
    checks.ccpaMechanism = { status: 'error', finding: `CCPA check failed to run: ${err.message}`, evidence: null };
  }

  try {
    checks.pricingDisclosure = await runPricingCheck(homepage, site, getBrowser);
    console.log(`  pricing disclosure: ${checks.pricingDisclosure.status}`);
  } catch (err) {
    console.log(`  pricing check crashed: ${err.message}`);
    checks.pricingDisclosure = { status: 'error', finding: `Pricing check failed to run: ${err.message}`, evidence: null };
  }

  return {
    id: site.id,
    name: site.name,
    url: site.url,
    platform: site.platform,
    checks,
    overallStatus: computeOverallStatus(checks),
    contentSource: consentResult.source,
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
  const fcAvailable = hasFirecrawlKey();
  console.log(
    `[audit] Firecrawl API key present: ${fcAvailable ? 'yes -- Firecrawl is the primary fetch path for every check' : 'no -- every check will fall back to hardened Playwright'}`
  );

  const lazyBrowser = makeLazyBrowser();
  const siteResults = [];
  for (const site of sites) {
    const result = await auditSite(lazyBrowser.get, site);
    siteResults.push(result);
  }

  // Only close the browser if the fallback path actually launched one.
  if (lazyBrowser.wasLaunched()) {
    const browser = await lazyBrowser.get();
    await browser.close();
  }

  const findings = {
    generatedAt: new Date().toISOString(),
    firecrawlPrimary: fcAvailable,
    browserLaunchMode: lazyBrowser.launchModeUsed(), // null if Firecrawl handled everything
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
