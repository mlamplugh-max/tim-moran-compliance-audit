#!/usr/bin/env node
// Single entry point for the daily cloud run: audit all four sites, render
// the PDF report, then print a short human-readable summary to stdout that
// a Claude Code agent can read from its terminal output and use to compose
// an email body. This script does NOT send any email itself -- that's the
// calling agent's job, using its own Gmail connector.

const { runAudit } = require('./audit');
const { renderReport } = require('./render-report');

const STATUS_ICON = { good: 'OK', review: '?', gap: '!!', error: 'X' };

function printSummary(findings) {
  console.log('\n================ DAILY COMPLIANCE AUDIT SUMMARY ================');
  console.log(`Generated: ${findings.generatedAt}`);
  console.log(`Browser launch mode: ${findings.launchMode}\n`);

  for (const site of findings.sites) {
    console.log(`[${STATUS_ICON[site.overallStatus] || site.overallStatus}] ${site.name} (${site.url}) -- overall: ${site.overallStatus.toUpperCase()}`);
    if (site.checks.consentMode && site.checks.consentMode.critical) {
      console.log(`     CRITICAL: ${site.checks.consentMode.finding}`);
    }
  }

  console.log('\nTop action items:');
  if (findings.actionItems.length === 0) {
    console.log('  - None. All checks came back clean.');
  } else {
    findings.actionItems.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.site}: ${item.text.replace(new RegExp('^' + item.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*'), '')}`);
    });
  }

  console.log('\nOutputs:');
  console.log('  - findings.json (full structured results, all evidence)');
  console.log('  - report.pdf (compact executive-summary PDF, ready to attach to an email)');
  console.log('==================================================================\n');
}

async function main() {
  console.log('[run-daily] starting audit...');
  const findings = await runAudit();

  console.log('[run-daily] rendering report...');
  await renderReport();

  printSummary(findings);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[run-daily] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
