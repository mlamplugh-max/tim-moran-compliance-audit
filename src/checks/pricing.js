const { gotoResilient } = require('../browser');
const { fetchMarkdownViaFirecrawl } = require('../firecrawl');

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
// model/category page (e.g. /inventory/new/ford/f-150) instead. If the
// listing page itself doesn't show the pattern, follow the first such link
// once and check there before giving up.
async function tryDrillIntoCategory(page, site, listingUrl) {
  const categoryHref = await page
    .evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
      return links.find((h) => /\/inventory\/(new|used)\/[^/]+\/[^/?#]+/i.test(h)) || null;
    })
    .catch(() => null);

  if (!categoryHref) return null;

  const nav = await gotoResilient(page, categoryHref, { maxAttempts: 2 });
  if (!nav.ok) return null;

  const text = await page.evaluate(() => document.body.innerText);
  const result = findItemizedPricing(text);
  if (!result.found) return null;

  return { target: categoryHref, result, viaDrillDownFrom: listingUrl };
}

async function runPricingCheck(page, site) {
  let lastNav = null;

  for (const path of site.pricingPaths) {
    const target = new URL(path, site.url).toString();
    const nav = await gotoResilient(page, target, { maxAttempts: 2 });
    lastNav = { target, nav };

    if (nav.ok) {
      const text = await page.evaluate(() => document.body.innerText);
      const result = findItemizedPricing(text);
      if (result.found) {
        return {
          status: result.docFee === '85' ? 'good' : 'review',
          finding:
            result.docFee === '85'
              ? `Inventory page (${target}) shows itemized pricing: MSRP $${result.msrp} + $85 documentation fee, separate from the headline price.`
              : `Inventory page (${target}) itemizes MSRP $${result.msrp} and a doc fee of $${result.docFee} (not $85 -- confirm this is expected).`,
          evidence: { source: 'playwright', url: target, ...result },
        };
      }

      // The general listing loaded but didn't show itemized pricing per
      // card -- try drilling into one specific model/category page, which
      // is where Ford's inventory shows the full MSRP -> doc fee -> total
      // breakdown.
      const drilled = await tryDrillIntoCategory(page, site, target);
      if (drilled) {
        return {
          status: drilled.result.docFee === '85' ? 'good' : 'review',
          finding:
            drilled.result.docFee === '85'
              ? `General listing (${target}) only showed a starting price per card; drilling into one model page (${drilled.target}) shows itemized pricing: MSRP $${drilled.result.msrp} + $85 documentation fee.`
              : `Drilled into ${drilled.target}: itemizes MSRP $${drilled.result.msrp} and a doc fee of $${drilled.result.docFee} (not $85 -- confirm this is expected).`,
          evidence: { source: 'playwright-drilldown', url: drilled.target, listingUrl: target, ...drilled.result },
        };
      }
      // Neither the listing nor a drill-down page showed it; try next configured path.
    }
  }

  // Every direct Playwright path either blocked or didn't show pricing text.
  // Try the Firecrawl fallback (primarily for Akamai-blocked Hyundai inventory).
  for (const path of site.pricingPaths) {
    const target = new URL(path, site.url).toString();
    const fc = await fetchMarkdownViaFirecrawl(target);
    if (fc.ok) {
      const result = findItemizedPricing(fc.markdown);
      if (result.found) {
        return {
          status: result.docFee === '85' ? 'good' : 'review',
          finding:
            `Direct browser navigation was blocked by bot-detection on ${target}; the Firecrawl API fallback got through. ` +
            `It shows itemized pricing: MSRP $${result.msrp} + $${result.docFee} documentation fee.`,
          evidence: { source: 'firecrawl', url: target, ...result },
        };
      }
    }
  }

  if (site.isUmbrella) {
    return {
      status: 'review',
      finding:
        'This is the umbrella/landing site; it does not run its own itemized pricing grid the way the individual store sites do. Verify pricing disclosure on the store-specific sites instead.',
      evidence: { lastAttempt: lastNav },
    };
  }

  return {
    status: 'error',
    finding: `Could not confirm itemized pricing (MSRP + doc fee) -- all direct navigation attempts were blocked and the Firecrawl fallback did not return matching content. Manual check recommended.`,
    evidence: { lastAttempt: lastNav },
  };
}

module.exports = { runPricingCheck, findItemizedPricing };
