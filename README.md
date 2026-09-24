# tim-moran-compliance-audit

Daily unattended audit of four Tim Moran dealership websites
(timmorancan.com, timmoranford.com, timmoranchevy.com, timmoranhyundai.com)
for cookie-banner, Google Consent Mode, privacy policy, terms of use, CCPA
opt-out, vehicle pricing disclosure, and accessibility-tooling compliance.
Produces `findings.json` (structured evidence) and `report.pdf` (a compact
plain-memo executive summary, well under 15KB), both ready for a calling
agent to read and email -- this repo never sends email itself.

## Firecrawl-primary architecture

Every check's page-fetching goes through Firecrawl (https://firecrawl.dev)
FIRST, via `src/firecrawl.js` / `src/contentFetch.js`. Firecrawl runs the
fetch from its own infrastructure, not from wherever this script runs, so
it isn't affected by network-level bot-detection (Akamai JA3/JA4-style TLS
fingerprinting, datacenter IP reputation) aimed at the machine actually
running Node. This matters a lot when this repo runs inside a claude.ai
cloud "routine" sandbox: that sandbox's outbound HTTPS is forced through its
own intercepting proxy for policy reasons, which gives every direct
Playwright request from there a distinct network fingerprint that Akamai
(the three Team Velocity sites) can and does flag with real 403s, even
though the exact same hardened Playwright code passes on a normal machine.

`FIRECRAWL_API_KEY` must be set in the environment for this primary path to
run. **Hardened Playwright (`src/browser.js`) is kept only as a fallback**,
used automatically when the key is unset or a specific Firecrawl call
fails -- so local dev without a Firecrawl key still works via a real
browser, just without the Firecrawl advantage above. The Playwright browser
is launched lazily: a fully successful Firecrawl-primary run never launches
a browser at all.

One check -- the tracking-pixel Consent Mode default, which reads
`window.dataLayer` before and after simulating a click on the cookie
banner's Accept/Decline control -- also runs via Firecrawl's `actions` +
`executeJavascript` capability as its primary method (see
`src/checks/consent.js` and `src/firecrawl.js` for the confirmed request/
response shape). If that Firecrawl call fails, this ONE check falls back to
hardened Playwright and may honestly report "COULD NOT VERIFY" if the
sandbox's own browser is blocked too -- but that no longer blanks out every
other check for the site, since each check fetches its own target page(s)
independently.

Firecrawl call volume: roughly one homepage+consent call, then one call per
linked page a check needs to verify (privacy policy, its Termly iframe if
present, terms of use, CCPA page, one or two pricing pages) -- on the order
of 5-7 calls per site, ~20-25/day across all four sites for the one daily
run. No retries or polling beyond what each check already needed.

## Setup

### Cloud run (claude.ai routine) -- the normal way this runs daily

```
npm ci
node run-daily.js
```

Set `FIRECRAWL_API_KEY` in the environment so Firecrawl is used as the
primary fetch path (recommended -- see above for why). If it's unset, every
check falls back to hardened Playwright, which needs a working browser in
the sandbox.

**Do not run `npx playwright install ...` in the cloud routine.** The cloud
sandbox's network egress is policy-restricted and cannot download a browser
binary from Google's or Playwright's CDNs -- that install command will
hard-fail before anything useful happens (this happened for real on
2026-09-23). It's also unnecessary: that sandbox already has a working
Chromium pre-installed at `/opt/pw-browsers/chromium`, and `src/browser.js`
looks for it (and a couple of other known paths) and launches it directly
via `executablePath`, bypassing Playwright's own version-matching entirely.
See the comment at the top of `src/browser.js` for the full story. This
Playwright path is now only the fallback (see above), so a healthy
`FIRECRAWL_API_KEY` means it's rarely exercised at all in the cloud run.

### Local dev

```
npm ci
npx playwright install chromium   # optional, only if you don't already have a Chrome/Chromium on this machine, and only matters if FIRECRAWL_API_KEY is unset
node run-daily.js
```

The install step is optional and best-effort, and only matters for the
Playwright fallback path. If it fails or you skip it, `src/browser.js` will
fall back to a real local Chrome install (via `channel: 'chrome'`) or,
failing that, ask Playwright to resolve/download its own pinned build.

## Files

- `audit.js` -- runs every check against all four sites, writes `findings.json`.
- `render-report.js` -- turns `findings.json` into `report.pdf` directly,
  using `src/pdfWriter.js` (hand-written PDF output, base14 Helvetica fonts
  only, no embedding, no images, no headless-browser dependency).
- `run-daily.js` -- runs both of the above and prints a plain-text summary to
  stdout (site-by-site status + top action items) for the calling agent to
  read and turn into an email body.
- `src/sites.js` -- site registry.
- `src/firecrawl.js` -- Firecrawl API wrapper: page fetch, link extraction,
  and the consent-mode / terms-of-use-modal `executeJavascript` actions.
- `src/contentFetch.js` -- shared Firecrawl-primary/Playwright-fallback URL
  fetcher used by the content-based checks.
- `src/browser.js` -- hardened Playwright launch + navigation helpers
  (fallback path only).
- `src/pdfWriter.js` -- minimal dependency-free PDF writer (base14 fonts).
- `src/checks/*.js` -- the individual compliance checks.
