// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { isBareUrl, hostOf, pageEmbed } from './pageMeta';

// isBareUrl decides whether a paste is silently rewritten into a link, so its
// job is as much about what it *refuses* as what it accepts: anything that is
// really prose has to paste as prose.

describe('isBareUrl', () => {
  it('accepts a URL standing on its own', () => {
    expect(isBareUrl('https://example.com')).toBe(true);
    expect(isBareUrl('http://example.com/a/b?c=d#e')).toBe(true);
    expect(isBareUrl('https://sub.example.co.uk/path')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isBareUrl('  https://example.com \n')).toBe(true);
  });

  it('refuses text that merely contains a URL', () => {
    expect(isBareUrl('see https://example.com for more')).toBe(false);
    expect(isBareUrl('https://example.com is good')).toBe(false);
    expect(isBareUrl('https://a.com https://b.com')).toBe(false);
  });

  it('refuses a bare host - a pasted word must not become a link', () => {
    expect(isBareUrl('example.com')).toBe(false);
    expect(isBareUrl('www.example.com')).toBe(false);
  });

  it('refuses schemes that are not the web', () => {
    expect(isBareUrl('mailto:a@example.com')).toBe(false);
    expect(isBareUrl('ftp://example.com')).toBe(false);
    // The ones that can carry script are refused here as well as downstream
    expect(isBareUrl('javascript:alert(1)')).toBe(false);
    expect(isBareUrl('data:text/html,<script>')).toBe(false);
  });

  it('refuses a host with no dot in it', () => {
    expect(isBareUrl('https://localhost')).toBe(false);
    expect(isBareUrl('https://intranet/page')).toBe(false);
  });

  it('refuses empty and malformed input', () => {
    expect(isBareUrl('')).toBe(false);
    expect(isBareUrl('   ')).toBe(false);
    expect(isBareUrl('https://')).toBe(false);
    expect(isBareUrl('not a url at all')).toBe(false);
  });

  it('is not fooled by a scheme appearing later in the string', () => {
    expect(isBareUrl('xhttps://example.com')).toBe(false);
  });
});

describe('hostOf', () => {
  it('drops the www nobody reads', () => {
    expect(hostOf('https://www.example.com/a')).toBe('example.com');
    expect(hostOf('https://WWW.Example.com')).toBe('example.com');
  });

  it('keeps other subdomains, which are part of the identity', () => {
    expect(hostOf('https://blog.example.com/a')).toBe('blog.example.com');
  });

  it('falls back to the raw string rather than throwing', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('pageEmbed', () => {
  it('points href and url at the same address', () => {
    const d = pageEmbed('https://example.com/a', { title: 'T', image: null, description: null });
    expect(d.href).toBe('https://example.com/a');
    expect(d.url).toBe('https://example.com/a');
    expect(d.kind).toBe('page');
  });
});
