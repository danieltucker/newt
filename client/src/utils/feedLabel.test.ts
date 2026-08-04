import { describe, it, expect } from 'vitest';
import { feedLabel, feedHost } from './feedLabel';

const bookmarks = [
  { name: 'Ars Technica', feedUrl: 'https://arstechnica.com/feed/' },
  { name: '  ', feedUrl: 'https://blank.example/feed' },
];

describe('feedHost', () => {
  it('strips the scheme, www and path', () => {
    expect(feedHost('https://www.example.com/blog/feed.xml')).toBe('example.com');
  });

  it('falls back to the raw string when the URL will not parse', () => {
    expect(feedHost('not a url')).toBe('not a url');
  });
});

describe('feedLabel', () => {
  it('prefers the name the user set', () => {
    const feed = { name: 'Morning read', url: 'https://arstechnica.com/feed/' };
    expect(feedLabel(feed, bookmarks)).toBe('Morning read');
  });

  it('falls back to the matching bookmark when unnamed', () => {
    const feed = { name: '', url: 'https://arstechnica.com/feed/' };
    expect(feedLabel(feed, bookmarks)).toBe('Ars Technica');
  });

  it('falls back to the hostname with no name and no bookmark', () => {
    expect(feedLabel({ name: '', url: 'https://www.example.com/feed' })).toBe('example.com');
  });

  it('treats a whitespace-only name as unset, on the feed and the bookmark', () => {
    expect(feedLabel({ name: '   ', url: 'https://arstechnica.com/feed/' }, bookmarks))
      .toBe('Ars Technica');
    expect(feedLabel({ name: '', url: 'https://blank.example/feed' }, bookmarks))
      .toBe('blank.example');
  });

  it('handles a missing name field', () => {
    expect(feedLabel({ url: 'https://arstechnica.com/feed/' }, bookmarks)).toBe('Ars Technica');
  });

  it("falls back to the publisher's own title before the hostname", () => {
    expect(feedLabel({ name: '', url: 'https://www.example.com/feed', title: 'Example Daily' }))
      .toBe('Example Daily');
  });

  it('still prefers a matching bookmark over the publisher title', () => {
    const feed = { name: '', url: 'https://arstechnica.com/feed/', title: 'Ars Technica - All content' };
    expect(feedLabel(feed, bookmarks)).toBe('Ars Technica');
  });

  it('ignores a whitespace-only title', () => {
    expect(feedLabel({ name: '', url: 'https://www.example.com/feed', title: '  ' }))
      .toBe('example.com');
  });
});
