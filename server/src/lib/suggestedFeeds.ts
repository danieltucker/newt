// Feeds offered to someone who hasn't got any yet — on the first-run screen and
// from the feed manager's empty state.
//
// The bar for being on this list: a stable, well-formed, full-text-ish feed from
// a publisher that has been around long enough to still be there next year. It
// is deliberately short and deliberately broad — this is a way to make an empty
// reader feel like a reader, not a directory. Nothing here is subscribed without
// the user picking it.
//
// `category` is the FeedFolder these are filed into when chosen, created on
// demand. `color` matches the palette the folder modals offer.

export interface SuggestedFeed {
  name: string;
  url: string;
  site: string;
  blurb: string;
  category: string;
}

export interface SuggestedCategory {
  name: string;
  color: string;
}

export const SUGGESTED_CATEGORIES: SuggestedCategory[] = [
  { name: 'Tech',    color: '#5E6AD2' },
  { name: 'News',    color: '#EA4C89' },
  { name: 'Science', color: '#0FB57B' },
  { name: 'Culture', color: '#F48024' },
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
  },
];
