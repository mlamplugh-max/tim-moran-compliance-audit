# tim-moran-compliance-audit

Daily unattended Playwright audit of four Tim Moran dealership websites
(timmorancan.com, timmoranford.com, timmoranchevy.com, timmoranhyundai.com)
for cookie-banner, Google Consent Mode, privacy policy, terms of use, CCPA
opt-out, vehicle pricing disclosure, and accessibility-tooling compliance.
Produces `findings.json` (structured evidence) and `report.pdf` (a compact
one-page executive summary), both ready for a calling agent to read and
email -- this repo never sends email itself.

## Setup

```
npm ci
npx playwright install --with-deps chrome chromium
node run-daily.js
```

`FIRECRAWL_API_KEY` should be set in the environment (used only as a
fallback for inventory pages blocked by bot-detection even after browser
evasion -- currently needed intermittently for timmoranhyundai.com). If it's
unset, that one fallback path is skipped with a logged message; everything
else still runs.

**Why `chrome`, not just `chromium`:** all four sites sit behind bot-detection
(Akamai on the three Team Velocity sites, Cloudflare on the Dealer Inspire
Chevy site) that blocks Playwright's bundled headless Chromium outright, even
with a spoofed UA and patched `navigator.webdriver`. Launching via
`channel: 'chrome'` (a real Chrome binary, still headless, still
Playwright-driven) is what gets through -- see the comment at the top of
`src/browser.js` for detail. If a real Chrome install isn't available in a
given sandbox, the code falls back to bundled Chromium automatically and
degrades gracefully (checks report "blocked"/"error" rather than a false
result) on sites that reject it.

## Files

- `audit.js` -- runs every check against all four sites, writes `findings.json`.
- `render-report.js` -- turns `findings.json` into `report.html` and `report.pdf`.
- `run-daily.js` -- runs both of the above and prints a plain-text summary to
  stdout (site-by-site status + top action items) for the calling agent to
  read and turn into an email body.
- `src/sites.js`, `src/browser.js`, `src/firecrawl.js`, `src/checks/*.js` --
  supporting modules.
