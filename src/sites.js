// Site registry for the Tim Moran compliance audit.
//
// `pricingPaths` are tried in order until one loads successfully; the first
// one that renders MSRP + itemized doc fee text wins. timmorancan.com is the
// umbrella/landing site and does not run its own inventory grid the way the
// three store sites do, so its pricing check is allowed to come back
// "review" (not "gap") when no itemized grid is found there.

module.exports = [
  {
    id: 'timmorancan',
    name: 'Tim Moran Auto Group (umbrella)',
    url: 'https://www.timmorancan.com',
    platform: 'team-velocity',
    isUmbrella: true,
    pricingPaths: ['/inventory/new', '/new-vehicles/'],
  },
  {
    id: 'timmoranford',
    name: 'Tim Moran Ford',
    url: 'https://www.timmoranford.com',
    platform: 'team-velocity',
    isUmbrella: false,
    pricingPaths: ['/new-vehicles/', '/inventory/new'],
  },
  {
    id: 'timmoranchevy',
    name: 'Tim Moran Chevrolet',
    url: 'https://www.timmoranchevy.com',
    platform: 'dealer-inspire',
    isUmbrella: false,
    pricingPaths: ['/new-vehicles/'],
  },
  {
    id: 'timmoranhyundai',
    name: 'Tim Moran Hyundai',
    url: 'https://www.timmoranhyundai.com',
    platform: 'team-velocity',
    isUmbrella: false,
    pricingPaths: ['/inventory/new', '/new-vehicles/'],
  },
];
