# tim-moran-compliance-audit

Daily unattended Playwright audit of four Tim Moran dealership websites
(timmorancan.com, timmoranford.com, timmoranchevy.com, timmoranhyundai.com)
for cookie-banner, Google Consent Mode, privacy policy, terms of use, CCPA
opt-out, vehicle pricing disclosure, and accessibility-tooling compliance.
Produces `findings.json` (structured evidence) and `report.pdf` (a compact
one-page executive summary), both ready for a calling agent to read and
email -- this repo never sends email itself.

## Setup

### Cloud run (claude.ai routine) -- the normal way this runs daily

```
npm ci
node run-daily.js
```

That's it. **Do not run `npx playwright install ...` in the cloud routine.**
The cloud sandbox's network egress is policy-restricted and cannot download
a browser binary from Google's or Playwright's CDNs -- that install command
will hard-fail the whole run with a `403` before a single site is visited
(this happened for real on 2026-09-23). It's also unnecessary there: that
sandbox already has a working Chromium pre-installed at
`/opt/pw-browsers/chromium`, and `src/browser.js` looks for it (and a couple
of other known paths) and launches it directly via `executablePath`,
bypassing Playwright's own version-matching entirely. See the comment at the
top of `src/browser.js` for the full story.

### Local dev

```
npm ci
npx playwright install chromium   # optional, only if you don't already have a Chrome/Chromium on this machine
node run-daily.js
```

The install step is optional and best-effort for local dev only -- if it
fails or you skip it, `src/browser.js` will fall back to a real local Chrome
install (via `channel: 'chrome'`) or, failing that, ask Playwright to
resolve/download its own pinned build, same as before. Never make this
install step a hard dependency of the run itself.

`FIRECRAWL_API_KEY` should be set in the environment (used only as a
fallback for inventory pages blocked by bot-detection even after browser
evasion -- currently needed intermittently for timmoranhyundai.com). If it's
unset, that one fallback path is skipped with a logged message; everything
else still runs.

**Bot-detection evasion:** all four sites sit behind bot-detection (Akamai on
the three Team Velocity sites, Cloudflare on the Dealer Inspire Chevy site).
Verified 2026-09-23: bundled Chromium (not a real Chrome channel) gets past
all four when launched with the hardening in `src/browser.js` and
`newHardenedContext()` -- realistic UA, matching sec-ch-ua client hints,
`navigator.webdriver` patched out, `--disable-blink-features=AutomationControlled`,
a plausible viewport/locale/timezone, and a google.com referer. This matters
because the cloud sandbox can only ever offer bundled Chromium (never a real
Chrome channel -- no network download available there), so that's the
config that has to work, and it does. If a site's edge ever blocks it again,
checks degrade to an honest "blocked" / "COULD NOT VERIFY" status (see
`src/checks/consent.js`) rather than crashing or guessing.

## Files

- `audit.js` -- runs every check against all four sites, writes `findings.json`.
- `render-report.js` -- turns `findings.json` into `report.html` and `report.pdf`.
- `run-daily.js` -- runs both of the above and prints a plain-text summary to
  stdout (site-by-site status + top action items) for the calling agent to
  read and turn into an email body.
- `src/sites.js`, `src/browser.js`, `src/firecrawl.js`, `src/checks/*.js` --
  supporting modules.
