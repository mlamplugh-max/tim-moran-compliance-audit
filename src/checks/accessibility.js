// Lightweight ADA/Unruh Act exposure signal -- presence/absence only, not a
// full WCAG audit.

async function runAccessibilityCheck(page) {
  const signals = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const acsbWidget = !!document.querySelector('[class*="acsb" i]') || /accessibe\.com/i.test(html);
    const audioEyeLink = Array.from(document.querySelectorAll('a')).some(
      (a) => /audioeye/i.test(a.textContent || '') && /audioeye\.com/i.test(a.getAttribute('href') || '')
    );
    return { acsbWidget, audioEyeLink };
  });

  const present = signals.acsbWidget || signals.audioEyeLink;
  const tool = signals.acsbWidget ? 'accessiBe' : signals.audioEyeLink ? 'AudioEye' : null;

  return {
    status: present ? 'good' : 'review',
    finding: present
      ? `${tool} accessibility tooling is present on the page (not a full WCAG audit, just a presence signal).`
      : 'No accessiBe widget or AudioEye statement link detected -- no lightweight ADA/Unruh Act mitigation signal found.',
    evidence: signals,
  };
}

module.exports = { runAccessibilityCheck };
