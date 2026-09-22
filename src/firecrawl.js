// Firecrawl fallback for pages that block real headless browsers outright
// (seen intermittently on timmoranhyundai.com inventory pages, even with the
// Chrome-channel evasion in src/browser.js). Reads FIRECRAWL_API_KEY from
// the environment only -- never hardcode a key here.

async function fetchMarkdownViaFirecrawl(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.log(
      `[firecrawl] TODO: FIRECRAWL_API_KEY not set in environment -- skipping Firecrawl fallback for ${url}. ` +
        'Set FIRECRAWL_API_KEY to enable this fallback for pages blocked by bot-detection.'
    );
    return { ok: false, reason: 'no-api-key' };
  }

  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`[firecrawl] request failed for ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, reason: `http-${res.status}` };
    }

    const json = await res.json();
    const markdown = json && json.data && json.data.markdown;
    if (!markdown) {
      console.log(`[firecrawl] no markdown returned for ${url}`);
      return { ok: false, reason: 'empty-response' };
    }

    return { ok: true, markdown };
  } catch (err) {
    console.log(`[firecrawl] error fetching ${url}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { fetchMarkdownViaFirecrawl };
