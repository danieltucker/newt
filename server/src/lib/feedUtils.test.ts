import { describe, it, expect } from 'vitest';
import {
  canonicalFeedKey,
  decodeXmlEntities,
  cleanContent,
  parseFeed,
  parseFeedTitle,
  sanitizeFeedHtml,
  titleFromContent,
} from './feedUtils';

describe('canonicalFeedKey', () => {
  it('lowercases host, strips www and trailing slash', () => {
    expect(canonicalFeedKey('https://www.Example.com/feed/')).toBe('example.com/feed');
  });

  it('maps http/https permutations to the same key', () => {
    expect(canonicalFeedKey('http://example.com/feed')).toBe(canonicalFeedKey('https://example.com/feed'));
  });

  it('preserves path case and query string', () => {
    expect(canonicalFeedKey('https://example.com/Feed?format=rss')).toBe('example.com/Feed?format=rss');
  });

  it('keeps a bare host as "/"', () => {
    expect(canonicalFeedKey('https://example.com')).toBe('example.com/');
  });

  it('falls back to trimmed lowercase for invalid input', () => {
    expect(canonicalFeedKey('  NOT a url  ')).toBe('not a url');
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the named entities', () => {
    expect(decodeXmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeXmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeXmlEntities('&quot;q&quot; &apos;a&apos;')).toBe('"q" \'a\'');
  });

  it('decodes numeric entities', () => {
    expect(decodeXmlEntities('&#65;&#66;&#67;')).toBe('ABC');
  });

  // Hex was missing, which is how "&#xA;" - a line break, and what Bluesky
  // writes for every one of them - was appearing literally in article titles.
  it('decodes hex entities, in either case', () => {
    expect(decodeXmlEntities('&#x41;&#x42;')).toBe('AB');
    expect(decodeXmlEntities('one&#xA;two')).toBe('one\ntwo');
    expect(decodeXmlEntities('&#Xa;')).toBe('\n');
  });

  it('decodes astral characters as one character, not two halves', () => {
    expect(decodeXmlEntities('&#x1F600;')).toBe('\u{1F600}');
  });

  // An escaped entity is text the feed meant literally. Decoding &amp; before
  // the numeric pass would hand "&#60;" to it and produce a "<" nobody wrote.
  it('does not re-decode an escaped entity', () => {
    expect(decodeXmlEntities('&amp;#60;')).toBe('&#60;');
    expect(decodeXmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('leaves a malformed entity alone rather than eating it', () => {
    expect(decodeXmlEntities('&#xZZ;')).toBe('&#xZZ;');
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });
});

describe('cleanContent', () => {
  it('unwraps CDATA and trims the inner text', () => {
    expect(cleanContent('<![CDATA[hello]]>')).toBe('hello');
    expect(cleanContent('<![CDATA[ padded ]]>')).toBe('padded');
  });

  it('decodes entities after unwrapping', () => {
    expect(cleanContent('<![CDATA[Tom &amp; Jerry]]>')).toBe('Tom & Jerry');
  });
});

describe('parseFeedTitle', () => {
  it('reads the first title', () => {
    expect(parseFeedTitle('<rss><channel><title>My Feed</title><item><title>Post</title></item></channel></rss>'))
      .toBe('My Feed');
  });

  it('decodes CDATA/entities in the title', () => {
    expect(parseFeedTitle('<feed><title><![CDATA[Cool &amp; Fun]]></title></feed>')).toBe('Cool & Fun');
  });

  it('returns empty string when there is no title', () => {
    expect(parseFeedTitle('<rss><channel></channel></rss>')).toBe('');
  });
});

describe('parseFeed (RSS)', () => {
  const rss = `<rss><channel>
    <title>Feed</title>
    <item>
      <title>Hello</title>
      <link>https://example.com/hello</link>
      <pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate>
      <description>Some content here that is easily long enough to make a snippet.</description>
      <category>Tech</category>
      <category>News</category>
    </item>
    <item>
      <title>World</title>
      <link>https://example.com/world?a=1&amp;b=2</link>
    </item>
    <item>
      <description>no title or link, should be skipped</description>
    </item>
  </channel></rss>`;

  it('parses each valid item and skips ones with no link', () => {
    const items = parseFeed(rss);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Hello');
    expect(items[0].link).toBe('https://example.com/hello');
  });

  it('parses the publish date, or null when absent', () => {
    const items = parseFeed(rss);
    expect(items[0].date).toBeInstanceOf(Date);
    expect(items[0].date?.getUTCFullYear()).toBe(2020);
    expect(items[1].date).toBeNull();
  });

  it('entity-decodes the link so query separators survive', () => {
    const items = parseFeed(rss);
    expect(items[1].link).toBe('https://example.com/world?a=1&b=2');
  });

  it('collects categories and a snippet/read time only when there is content', () => {
    const items = parseFeed(rss);
    expect(items[0].categories).toEqual(['Tech', 'News']);
    expect(items[0].snippet).toContain('Some content here');
    expect(items[0].readTime).toBeGreaterThanOrEqual(1);
    expect(items[1].readTime).toBeNull();
  });

  it('honours the item limit', () => {
    expect(parseFeed(rss, 1)).toHaveLength(1);
  });
});

// Microblog feeds publish posts, which have no headline of their own. Bluesky's
// items are a link, a description and a date - nothing else - so requiring a
// <title> ingested exactly none of them while every other signal said the feed
// was healthy.
describe('parseFeed (titleless items)', () => {
  const bluesky = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>@pfrazee.com - Paul Frazee</title>
  <item>
    <link>https://bsky.app/profile/pfrazee.com/post/3mshvvl46ok24</link>
    <description>Depending on how you view the ship of theseus, source-code licensing means Apex Legends is built on the Quake engine.&#xA;&#xA;(No idea how bluesky will handle this image.)</description>
    <pubDate>07 Aug 2026 06:17 +0000</pubDate>
  </item>
  <item>
    <link>https://bsky.app/profile/pfrazee.com/post/nothing</link>
  </item>
</channel></rss>`;

  it('keeps a titleless post, headlined by its first line', () => {
    const items = parseFeed(bluesky);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Depending on how you view the ship of theseus, source-code licensing means Apex Legends is…');
    expect(items[0].link).toBe('https://bsky.app/profile/pfrazee.com/post/3mshvvl46ok24');
  });

  // The weekday-less RFC822 date Bluesky emits still has to land as a date, or
  // every post sorts to one end of the river.
  it('parses the date format these feeds use', () => {
    expect(parseFeed(bluesky)[0].date?.toISOString()).toBe('2026-08-07T06:17:00.000Z');
  });

  it('still drops an item with neither a title nor anything to make one from', () => {
    expect(parseFeed(bluesky).some(i => i.link.endsWith('/nothing'))).toBe(false);
  });
});

describe('titleFromContent', () => {
  it('takes the first line, not the first sentence', () => {
    expect(titleFromContent('Short one\nand a second line')).toBe('Short one');
  });

  it('cuts a long single line at a word boundary', () => {
    const long = `${'word '.repeat(40)}end`;
    const title = titleFromContent(long);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(91);
    expect(title).not.toContain('wor…');
  });

  it('strips markup and decodes entities', () => {
    expect(titleFromContent('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
  });

  it('is empty when there is nothing to work with', () => {
    expect(titleFromContent('   ')).toBe('');
    expect(titleFromContent('<p></p>')).toBe('');
  });
});

describe('parseFeed (Atom)', () => {
  const atom = `<feed>
    <title>Atom Feed</title>
    <entry>
      <title>Atom Post</title>
      <link href="https://example.com/atom-post"/>
      <updated>2021-06-15T10:00:00Z</updated>
      <summary>An atom summary with plenty of words to form a snippet.</summary>
      <category term="Design"/>
    </entry>
  </feed>`;

  it('parses atom entries with href links and term categories', () => {
    const items = parseFeed(atom);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Atom Post');
    expect(items[0].link).toBe('https://example.com/atom-post');
    expect(items[0].date?.getUTCFullYear()).toBe(2021);
    expect(items[0].categories).toEqual(['Design']);
  });
});

describe('parseFeed image extraction', () => {
  const withImage = (media: string) => `<rss><channel><item>
    <title>Img</title><link>https://example.com/img</link>${media}
  </item></channel></rss>`;

  it('takes an https media:thumbnail', () => {
    const items = parseFeed(withImage('<media:thumbnail url="https://cdn.example.com/pic.jpg"/>'));
    expect(items[0].imageUrl).toBe('https://cdn.example.com/pic.jpg');
  });

  it('rejects an insecure http image', () => {
    const items = parseFeed(withImage('<media:thumbnail url="http://cdn.example.com/pic.jpg"/>'));
    expect(items[0].imageUrl).toBeNull();
  });
});

describe('sanitizeFeedHtml', () => {
  it('keeps allowed markup', () => {
    expect(sanitizeFeedHtml('<p>Hello <strong>world</strong></p>')).toContain('<strong>world</strong>');
  });

  it('strips <script> and its contents', () => {
    const out = sanitizeFeedHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('alert');
  });

  it('drops non-https images but keeps https ones', () => {
    // An http-only image sanitizes down to nothing, so the whole body is null.
    expect(sanitizeFeedHtml('<img src="http://insecure/x.jpg">')).toBeNull();
    const ok = sanitizeFeedHtml('<img src="https://ok/x.jpg">');
    expect(ok).toContain('<img');
    expect(ok).toContain('https://ok/x.jpg');
  });

  it('neutralizes javascript: links and hardens external ones', () => {
    expect(sanitizeFeedHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    const link = sanitizeFeedHtml('<a href="https://ok.com">go</a>');
    expect(link).toContain('https://ok.com');
    expect(link).toContain('noopener');
  });

  it('returns null when nothing meaningful remains', () => {
    expect(sanitizeFeedHtml('')).toBeNull();
    expect(sanitizeFeedHtml('<script>evil()</script>')).toBeNull();
  });
});
