// Lightweight ADA/Unruh Act exposure signal -- presence/absence only, not a
// full WCAG audit. Operates on the homepage HTML bundle (Firecrawl-primary
// or Playwright-fallback -- see audit.js / src/checks/consent.js) rather
// than a live page: this check needs no interaction, just a presence
// signal in the rendered DOM, so it's synchronous and needs no extra fetch.

function runAccessibilityCheck(homepage) {
  const html = (homepage && homepage.html) || '';
  const acsbWidget = /class\s*=\s*["'][^"']*\bacsb\b[^"']*["']/i.test(html) || /accessibe\.com/i.test(html);
  const audioEyeLink = /audioeye\.com/i.test(html) && /audioeye/i.test(html);

  const present = acsbWidget || audioEyeLink;
  const tool = acsbWidget ? 'accessiBe' : audioEyeLink ? 'AudioEye' : null;

  return {
    status: present ? 'good' : 'review',
    finding: present
      ? `${tool} accessibility tooling is present on the page (not a full WCAG audit, just a presence signal).`
      : 'No accessiBe widget or AudioEye statement link detected -- no lightweight ADA/Unruh Act mitigation signal found.',
    evidence: { acsbWidget, audioEyeLink },
  };
}

module.exports = { runAccessibilityCheck };
