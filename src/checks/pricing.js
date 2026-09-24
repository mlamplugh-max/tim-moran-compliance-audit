// Vehicle pricing itemization check (MSRP + doc fee shown separately from
// the headline price). Firecrawl-primary for every attempt via
// src/contentFetch.js -- previously Firecrawl was only tried as a
// last-resort fallback specifically for Hyundai; now it's the first thing
// tried for every site's pricing page(s).

const { fetchUrlPrimary } = require('../contentFetch');

// Looks for "MSRP ... Doc Fee ... Total Price" style itemization within a
// bounded window of text so we don't false-match unrelated MSRP mentions
// elsewhere on the page.
function findItemizedPricing(text) {
  const msrpMatches = [...text.matchAll(/MSRP[^\d$]{0,20}\$?([\d,]{4,7})/gi)];
  for (const m of msrpMatches) {
    const windowText = text.slice(m.index, m.index + 400);
    const docFeeMatch = windowText.match(/doc(?:umentation)?\s*fee[^\d$]{0,10}\+?\$?([\d,]{2,5})/i);
    if (docFeeMatch) {
      return {
        found: true,
        msrp: m[1],
        docFee: docFeeMatch[1],
        sample: windowText.replace(/\s+/g, ' ').trim().slice(0, 220),
      };
    }
  }
  return { found: false };
}

// Some general "all inventory" listing pages show only a starting price per
// card and push the itemized MSRP/doc-fee breakdown to a specific
// model/category page (e.g. /inventory/new/ford/f-150) instead. Finds the
// first such link in the listing page's raw HTML.
function findCategoryLink(html, baseUrl) {
  const hrefs = [...(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const h of hrefs) {
    if (/\/inventory\/(new|used)\/[^/]+\/[^/?#]+/i.test(h)) {
      try {
        return new URL(h, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function runPricingCheck(homepage, site, getBrowser) {
  let lastAttempt = null;

  for (const path of site.pricingPaths) {
    const target = new URL(path, site.url).toString();
    const fetched = await fetchUrlPrimary(target, { getBrowser });
    lastAttempt = { target, ok: fetched.ok, reason: fetched.reason };

    if (!fetched.ok) continue;

    const result = findItemizedPricing(fetched.text);
    if (result.found) {
      return {
        status: result.docFee === '85' ? 'good' : 'review',
        finding:
          result.docFee === '85'
            ? `Inventory page (${target}) shows itemized pricing: MSRP $${result.msrp} + $85 documentation fee, separate from the headline price.`
            : `Inventory page (${target}) itemizes MSRP $${result.msrp} and a doc fee of $${result.docFee} (not $85 -- confirm this is expected).`,
        evidence: { source: fetched.source, url: target, ...result },
      };
    }

    // Listing loaded but didn't show itemized pricing per card -- try
    // drilling into one specific model/category page (one extra fetch),
    // which is where Ford's inventory shows the full MSRP -> doc fee ->
    // total breakdown.
    const categoryUrl = findCategoryLink(fetched.html, target);
    if (categoryUrl) {
      const drilled = await fetchUrlPrimary(categoryUrl, { getBrowser });
      if (drilled.ok) {
        const drilledResult = findItemizedPricing(drilled.text);
        if (drilledResult.found) {
          return {
            status: drilledResult.docFee === '85' ? 'good' : 'review',
            finding:
              drilledResult.docFee === '85'
                ? `General listing (${target}) only showed a starting price per card; drilling into one model page (${categoryUrl}) shows itemized pricing: MSRP $${drilledResult.msrp} + $85 documentation fee.`
                : `Drilled into ${categoryUrl}: itemizes MSRP $${drilledResult.msrp} and a doc fee of $${drilledResult.docFee} (not $85 -- confirm this is expected).`,
            evidence: { source: drilled.source, url: categoryUrl, listingUrl: target, ...drilledResult },
          };
        }
      }
    }
    // Neither the listing nor a drill-down page showed it; try next configured path.
  }

  if (site.isUmbrella) {
    return {
      status: 'review',
      finding:
        'This is the umbrella/landing site; it does not run its own itemized pricing grid the way the individual store sites do. Verify pricing disclosure on the store-specific sites instead.',
      evidence: { lastAttempt },
    };
  }

  return {
    status: 'error',
    finding:
      `Could not confirm itemized pricing (MSRP + doc fee) -- all fetch attempts (Firecrawl` +
      `${getBrowser ? ' and Playwright fallback' : ''}) either failed or did not show matching content. Manual check recommended.`,
    evidence: { lastAttempt },
  };
}

module.exports = { runPricingCheck, findItemizedPricing };
