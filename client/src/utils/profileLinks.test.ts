import { describe, it, expect } from 'vitest';
import {
  LINK_PLATFORMS, WEBSITE_PLATFORM, platformOf,
  normalizeLinkUrl, guessPlatform, linkHost, linkLabel, linkIcon,
} from './profileLinks';

describe('normalizeLinkUrl', () => {
  it('completes a bare host, which is how people type a link', () => {
    expect(normalizeLinkUrl('github.com/sam')).toBe('https://github.com/sam');
    expect(normalizeLinkUrl('  bsky.app/profile/sam  ')).toBe('https://bsky.app/profile/sam');
  });

  it('keeps a scheme that was already there', () => {
    expect(normalizeLinkUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(normalizeLinkUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('refuses a scheme that is not http(s) rather than prefixing it into one', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://e.test']) {
      expect(normalizeLinkUrl(raw)).toBeNull();
    }
  });

  it('refuses a host with no dot', () => {
    expect(normalizeLinkUrl('localhost:3001')).toBeNull();
    expect(normalizeLinkUrl('https://intranet/')).toBeNull();
  });

  it('refuses empty input and an over-long URL', () => {
    expect(normalizeLinkUrl('')).toBeNull();
    expect(normalizeLinkUrl('   ')).toBeNull();
    expect(normalizeLinkUrl(`example.com/${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('guessPlatform', () => {
  it('recognises a known host', () => {
    expect(guessPlatform('https://github.com/sam')).toBe('github');
    expect(guessPlatform('https://www.linkedin.com/in/sam')).toBe('linkedin');
  });

  it('recognises a subdomain of a known host', () => {
    expect(guessPlatform('https://gaming.youtube.com/@sam')).toBe('youtube');
  });

  it('falls back to Website for anything else', () => {
    expect(guessPlatform('https://sam.example.com')).toBe(WEBSITE_PLATFORM);
    expect(guessPlatform('not a url')).toBe(WEBSITE_PLATFORM);
  });
});

describe('labels and icons', () => {
  it('names a known platform by its label', () => {
    expect(linkLabel({ platform: 'bluesky', url: 'https://bsky.app/profile/sam' })).toBe('Bluesky');
  });

  it('names an unknown platform by its host, so a newer build\'s link still reads', () => {
    expect(linkLabel({ platform: 'somethingnew', url: 'https://new.example.com/sam' }))
      .toBe('new.example.com');
  });

  it('takes the icon from the URL host, so a self-hosted instance shows its own mark', () => {
    expect(linkIcon({ platform: 'mastodon', url: 'https://fosstodon.org/@sam' }))
      .toContain('fosstodon.org');
  });

  it('strips www from a displayed host', () => {
    expect(linkHost('https://www.example.com/sam')).toBe('example.com');
  });
});

describe('LINK_PLATFORMS', () => {
  it('has unique ids in the shape the server will accept', () => {
    const ids = LINK_PLATFORMS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,23}$/);
  });

  it('ends with the catch-all, which is the only entry without a host', () => {
    expect(LINK_PLATFORMS[LINK_PLATFORMS.length - 1].id).toBe(WEBSITE_PLATFORM);
    expect(LINK_PLATFORMS.filter(p => !p.host)).toHaveLength(1);
  });

  it('covers the services people asked for', () => {
    for (const id of ['bluesky', 'facebook', 'linkedin', 'github', 'instagram']) {
      expect(platformOf(id)).toBeDefined();
    }
  });
});
