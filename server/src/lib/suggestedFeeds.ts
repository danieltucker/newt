// Feeds offered to someone who hasn't got any yet — on the first-run screen and
// from the feed manager's Discover tab.
//
// The bar for being on this list: a stable, well-formed feed from a publisher
// that has been around long enough to still be there next year. Nothing here is
// subscribed without the user picking it.
//
// ── Paywalled publishers are included, and labelled ──
// Excluding them would leave out a good deal of the best writing on the web,
// and their feeds are genuinely useful even unpaid: the headline and summary
// are real, and they are how you decide whether a piece is worth your one free
// article. What is not acceptable is finding out at the wall. Anything behind
// one carries `access` (see FeedAccess), which the picker prints on the card.
//
// **Every entry was fetched and confirmed to return items before being added**
// (last swept 2026-08-07). Feeds that didn't survive that check and should not
// be re-added without re-testing:
//   - Nature — blocks our fetcher outright
//   - AP News — /index.rss answers 401 "Invalid client credentials"; their
//     public RSS is gone
//   - New Scientist — 406 to a non-browser user agent
//   - Sports Illustrated, NIH news releases — 404, feeds retired
//   - Washington Post — resolves, but returns 4 items, too thin to be useful
//
// ── One list ──
// Everything here is offered in both places it can be: the first-run picker and
// the manager's Discover tab. The picker used to draw a short "starter" subset,
// on the theory that a screenful was friendlier than a directory; in practice it
// hid most of the list from the one audience that hasn't seen any of it, and the
// categories on that screen read as though they held two feeds each. It scrolls
// instead, grouped by category, and nothing is subscribed until it's picked.

/**
 * How much of a publisher's writing the feed actually gets you.
 *
 * A paywalled feed is still worth following - the headlines and summaries are
 * real, and they are how you decide whether a piece is worth your one free
 * article - but finding that out by clicking through to a wall is a poor way to
 * learn it. Absent means everything in the feed is free to read.
 */
export type FeedAccess = 'metered' | 'subscriber';

export interface SuggestedFeed {
  name: string;
  url: string;
  site: string;
  blurb: string;
  category: string;
  /** Set when the articles are behind a paywall, whole or partial. */
  access?: FeedAccess;
}

export interface SuggestedCategory {
  name: string;
  color: string;
}

export const SUGGESTED_CATEGORIES: SuggestedCategory[] = [
  { name: 'Tech',        color: '#5E6AD2' },
  { name: 'News',        color: '#EA4C89' },
  { name: 'Science',     color: '#0FB57B' },
  { name: 'Culture',     color: '#F48024' },
  { name: 'Programming', color: '#7C5CFC' },
  { name: 'Design',      color: '#E0479E' },
  { name: 'Business',    color: '#00A8E8' },
  { name: 'Gaming',      color: '#A259FF' },
  { name: 'Sports',      color: '#1DB954' },
  { name: 'Health',      color: '#24A0ED' },
  { name: 'Cars',        color: '#FF6600' },
];

export const SUGGESTED_FEEDS: SuggestedFeed[] = [
  // ── Tech ──
  {
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    site: 'theverge.com',
    blurb: 'Consumer tech, gadgets and the culture around them.',
    category: 'Tech',
  },
  {
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    site: 'arstechnica.com',
    blurb: 'Deep, technical reporting on computing and policy.',
    category: 'Tech',
  },
  {
    name: 'Hacker News',
    url: 'https://hnrss.org/frontpage',
    site: 'news.ycombinator.com',
    blurb: 'The front page — programming, startups, and arguments.',
    category: 'Tech',
  },
  {
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    site: 'techcrunch.com',
    blurb: 'Startups, funding rounds and the industry that follows them.',
    category: 'Tech',
  },
  {
    name: 'Engadget',
    url: 'https://www.engadget.com/rss.xml',
    site: 'engadget.com',
    blurb: 'Hardware reviews and consumer electronics news.',
    category: 'Tech',
  },
  {
    name: '404 Media',
    url: 'https://www.404media.co/rss/',
    site: '404media.co',
    blurb: 'Journalist-owned reporting on the seedier corners of tech.',
    category: 'Tech',
  },
  {
    name: 'WIRED',
    url: 'https://www.wired.com/feed/rss',
    site: 'wired.com',
    blurb: 'Technology, science and the culture they keep reshaping.',
    category: 'Tech',
    access: 'metered',
  },
  {
    name: 'MIT Technology Review',
    url: 'https://www.technologyreview.com/feed/',
    site: 'technologyreview.com',
    blurb: 'What the research actually says, minus the press release.',
    category: 'Tech',
    access: 'metered',
  },
  {
    name: 'Stratechery',
    url: 'https://stratechery.com/feed/',
    site: 'stratechery.com',
    blurb: 'Ben Thompson on the strategy behind the tech industry.',
    category: 'Tech',
    access: 'subscriber',
  },
  {
    name: 'Rest of World',
    url: 'https://restofworld.org/feed/latest',
    site: 'restofworld.org',
    blurb: 'Technology reporting from outside the Western bubble.',
    category: 'Tech',
  },
  {
    name: 'Daring Fireball',
    url: 'https://daringfireball.net/feeds/main',
    site: 'daringfireball.net',
    blurb: 'John Gruber on Apple, and on writing about Apple.',
    category: 'Tech',
  },

  // ── News ──
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    site: 'npr.org',
    blurb: 'US and world headlines, updated through the day.',
    category: 'News',
  },
  {
    name: 'BBC News',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    site: 'bbc.co.uk',
    blurb: 'World news from the BBC.',
    category: 'News',
  },
  {
    name: 'The Guardian',
    url: 'https://www.theguardian.com/world/rss',
    site: 'theguardian.com',
    blurb: 'World news and long-form reporting.',
    category: 'News',
  },
  {
    name: 'Al Jazeera',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    site: 'aljazeera.com',
    blurb: 'World news with a different centre of gravity.',
    category: 'News',
  },
  {
    name: 'PBS NewsHour',
    url: 'https://www.pbs.org/newshour/feeds/rss/headlines',
    site: 'pbs.org',
    blurb: 'US headlines at a slower, longer pace.',
    category: 'News',
  },
  {
    name: 'CBC News',
    url: 'https://www.cbc.ca/webfeed/rss/rss-topstories',
    site: 'cbc.ca',
    blurb: "Canada's public broadcaster, top stories.",
    category: 'News',
  },
  {
    name: 'France 24',
    url: 'https://www.france24.com/en/rss',
    site: 'france24.com',
    blurb: 'French public international news, in English.',
    category: 'News',
  },
  {
    name: 'Deutsche Welle',
    url: 'https://rss.dw.com/rdf/rss-en-all',
    site: 'dw.com',
    blurb: 'German public international news, in English.',
    category: 'News',
  },
  {
    name: 'The Economist',
    url: 'https://www.economist.com/latest/rss.xml',
    site: 'economist.com',
    blurb: 'World affairs and economics, weekly and opinionated.',
    category: 'News',
    access: 'subscriber',
  },
  {
    name: 'The New York Times',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    site: 'nytimes.com',
    blurb: 'The front page, refreshed through the day.',
    category: 'News',
    access: 'metered',
  },

  // ── Science ──
  {
    name: 'Quanta Magazine',
    url: 'https://api.quantamagazine.org/feed/',
    site: 'quantamagazine.org',
    blurb: 'Mathematics and fundamental science, beautifully explained.',
    category: 'Science',
  },
  {
    name: 'NASA',
    url: 'https://www.nasa.gov/news-release/feed/',
    site: 'nasa.gov',
    blurb: 'Missions, discoveries and the occasional stunning photo.',
    category: 'Science',
  },
  {
    name: 'Science Daily',
    url: 'https://www.sciencedaily.com/rss/all.xml',
    site: 'sciencedaily.com',
    blurb: 'Research findings across every field, as they are published.',
    category: 'Science',
  },
  {
    name: 'Phys.org',
    url: 'https://phys.org/rss-feed/',
    site: 'phys.org',
    blurb: 'Physics, space and technology research, in volume.',
    category: 'Science',
  },
  {
    name: 'Scientific American',
    url: 'https://www.scientificamerican.com/platform/syndication/rss/',
    site: 'scientificamerican.com',
    blurb: 'Science journalism with a very long memory.',
    category: 'Science',
  },
  {
    name: 'Space.com',
    url: 'https://www.space.com/feeds/all',
    site: 'space.com',
    blurb: 'Launches, astronomy and the business of getting up there.',
    category: 'Science',
  },
  {
    name: 'ESA Top News',
    url: 'https://www.esa.int/rssfeed/Our_Activities/Space_News',
    site: 'esa.int',
    blurb: 'The European Space Agency, in its own words.',
    category: 'Science',
  },
  {
    name: 'NASA Image of the Day',
    url: 'https://www.nasa.gov/rss/dyn/lg_image_of_the_day.rss',
    site: 'nasa.gov',
    blurb: 'One photograph a day, and it earns the slot.',
    category: 'Science',
  },

  // ── Culture ──
  {
    name: 'Aeon',
    url: 'https://aeon.co/feed.rss',
    site: 'aeon.co',
    blurb: 'Essays on philosophy, science and being a person.',
    category: 'Culture',
  },
  {
    name: 'Kottke',
    url: 'https://feeds.kottke.org/main',
    site: 'kottke.org',
    blurb: 'A long-running blog of interesting things.',
    category: 'Culture',
  },
  {
    name: 'The Atlantic',
    url: 'https://www.theatlantic.com/feed/all/',
    site: 'theatlantic.com',
    blurb: 'Politics, culture and ideas at length.',
    category: 'Culture',
    access: 'metered',
  },
  {
    name: 'The New Yorker',
    url: 'https://www.newyorker.com/feed/everything',
    site: 'newyorker.com',
    blurb: 'Reporting, criticism and fiction. Everything they publish.',
    category: 'Culture',
    access: 'metered',
  },
  {
    name: 'Longreads',
    url: 'https://longreads.com/feed/',
    site: 'longreads.com',
    blurb: 'The best long-form writing on the web, gathered up.',
    category: 'Culture',
  },
  {
    name: 'The Marginalian',
    url: 'https://www.themarginalian.org/feed/',
    site: 'themarginalian.org',
    blurb: 'Maria Popova on books, art and how to live.',
    category: 'Culture',
  },
  {
    name: 'The Public Domain Review',
    url: 'https://publicdomainreview.org/rss.xml',
    site: 'publicdomainreview.org',
    blurb: 'Curiosities from the archives, out of copyright.',
    category: 'Culture',
  },

  // ── Programming ──
  {
    name: 'Lobsters',
    url: 'https://lobste.rs/rss',
    site: 'lobste.rs',
    blurb: 'Computing link aggregator. Quieter and more technical than HN.',
    category: 'Programming',
  },
  {
    name: 'Simon Willison',
    url: 'https://simonwillison.net/atom/everything/',
    site: 'simonwillison.net',
    blurb: 'Working notes on LLMs, Python and building things.',
    category: 'Programming',
  },
  {
    name: 'Julia Evans',
    url: 'https://jvns.ca/atom.xml',
    site: 'jvns.ca',
    blurb: 'Systems, debugging and networking, explained kindly.',
    category: 'Programming',
  },
  {
    name: 'The GitHub Blog',
    url: 'https://github.blog/feed/',
    site: 'github.blog',
    blurb: 'Platform changes, engineering posts and security advisories.',
    category: 'Programming',
  },
  {
    name: 'CSS-Tricks',
    url: 'https://css-tricks.com/feed/',
    site: 'css-tricks.com',
    blurb: 'Front-end techniques, with the code to go with them.',
    category: 'Programming',
  },

  // ── Design ──
  {
    name: 'Smashing Magazine',
    url: 'https://www.smashingmagazine.com/feed/',
    site: 'smashingmagazine.com',
    blurb: 'Long, practical articles on design and front-end craft.',
    category: 'Design',
  },
  {
    name: 'A List Apart',
    url: 'https://alistapart.com/main/feed/',
    site: 'alistapart.com',
    blurb: 'Web standards and design thinking, since forever.',
    category: 'Design',
  },
  {
    name: 'Core77',
    url: 'https://www.core77.com/blog/rss.xml',
    site: 'core77.com',
    blurb: 'Industrial design — objects, tools and how they got made.',
    category: 'Design',
  },
  {
    name: 'Colossal',
    url: 'https://www.thisiscolossal.com/feed/',
    site: 'thisiscolossal.com',
    blurb: 'Art and visual culture. Worth it for the pictures alone.',
    category: 'Design',
  },

  // ── Business ──
  {
    name: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    site: 'cnbc.com',
    blurb: 'Markets and business news through the trading day.',
    category: 'Business',
  },
  {
    name: 'MarketWatch',
    url: 'https://www.marketwatch.com/rss/topstories',
    site: 'marketwatch.com',
    blurb: 'Market moves and what is supposedly behind them.',
    category: 'Business',
  },
  {
    name: 'WSJ Markets',
    url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
    site: 'wsj.com',
    blurb: 'Wall Street Journal markets coverage.',
    category: 'Business',
    access: 'subscriber',
  },
  {
    name: 'Financial Times',
    url: 'https://www.ft.com/rss/home',
    site: 'ft.com',
    blurb: 'Global business and markets from the FT.',
    category: 'Business',
    access: 'subscriber',
  },
  {
    name: 'Bloomberg Markets',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
    site: 'bloomberg.com',
    blurb: 'Markets, deals and the economy.',
    category: 'Business',
    access: 'metered',
  },
  {
    name: 'Fortune',
    url: 'https://fortune.com/feed/',
    site: 'fortune.com',
    blurb: 'Companies, executives and the money around them.',
    category: 'Business',
  },

  // ── Gaming ──
  {
    name: 'Rock Paper Shotgun',
    url: 'https://www.rockpapershotgun.com/feed',
    site: 'rockpapershotgun.com',
    blurb: 'PC games, written by people who clearly enjoy writing.',
    category: 'Gaming',
  },
  {
    name: 'Eurogamer',
    url: 'https://www.eurogamer.net/feed',
    site: 'eurogamer.net',
    blurb: 'Reviews, news and the occasional very good essay.',
    category: 'Gaming',
  },
  {
    name: 'Polygon',
    url: 'https://www.polygon.com/rss/index.xml',
    site: 'polygon.com',
    blurb: 'Games and the wider entertainment they sit in.',
    category: 'Gaming',
  },
  {
    name: 'PC Gamer',
    url: 'https://www.pcgamer.com/rss/',
    site: 'pcgamer.com',
    blurb: 'Hardware, patches and PC gaming news, in quantity.',
    category: 'Gaming',
  },

  // ── Sports ──
  {
    name: 'BBC Sport',
    url: 'https://feeds.bbci.co.uk/sport/rss.xml',
    site: 'bbc.co.uk',
    blurb: 'Everything the BBC covers, which is most of it.',
    category: 'Sports',
  },
  {
    name: 'ESPN',
    url: 'https://www.espn.com/espn/rss/news',
    site: 'espn.com',
    blurb: 'US sport, top stories.',
    category: 'Sports',
  },
  {
    name: 'Guardian Sport',
    url: 'https://www.theguardian.com/sport/rss',
    site: 'theguardian.com',
    blurb: 'Sport with a bit more writing in it.',
    category: 'Sports',
  },
  {
    name: 'Sky Sports',
    url: 'https://www.skysports.com/rss/12040',
    site: 'skysports.com',
    blurb: 'Breaking sport news, heavy on football.',
    category: 'Sports',
  },
  {
    name: 'Defector',
    url: 'https://defector.com/feed',
    site: 'defector.com',
    blurb: 'Worker-owned sport and culture writing, with a sense of humour.',
    category: 'Sports',
    access: 'metered',
  },
  {
    name: 'CBS Sports',
    url: 'https://www.cbssports.com/rss/headlines/',
    site: 'cbssports.com',
    blurb: 'US headlines across the major leagues, all day.',
    category: 'Sports',
  },
  {
    name: 'Yahoo Sports',
    url: 'https://sports.yahoo.com/rss/',
    site: 'sports.yahoo.com',
    blurb: 'High-volume US coverage — scores, trades and transfers.',
    category: 'Sports',
  },

  // ── Health ──
  {
    name: 'STAT',
    url: 'https://www.statnews.com/feed/',
    site: 'statnews.com',
    blurb: 'Health, medicine and the business of both. Properly reported.',
    category: 'Health',
  },
  {
    name: 'KFF Health News',
    url: 'https://kffhealthnews.org/feed/',
    site: 'kffhealthnews.org',
    blurb: 'Non-profit newsroom on health policy and its costs.',
    category: 'Health',
  },
  {
    name: 'WHO News',
    url: 'https://www.who.int/rss-feeds/news-english.xml',
    site: 'who.int',
    blurb: 'World Health Organization releases and outbreak news.',
    category: 'Health',
  },

  // ── Cars ──
  {
    name: 'The Autopian',
    url: 'https://www.theautopian.com/feed/',
    site: 'theautopian.com',
    blurb: 'Cars written about by people who repair them badly and often.',
    category: 'Cars',
  },
  {
    name: 'Car and Driver',
    url: 'https://www.caranddriver.com/rss/all.xml/',
    site: 'caranddriver.com',
    blurb: 'Reviews, road tests and new model news.',
    category: 'Cars',
  },
  {
    name: 'Motor1',
    url: 'https://www.motor1.com/rss/news/all/',
    site: 'motor1.com',
    blurb: 'Industry and new car news, updated constantly.',
    category: 'Cars',
  },
];
