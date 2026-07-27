// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { EMBED_CLASS } from './noteEmbed';
import { repostBody, takeRepost, clearRepost, RepostDraft } from './repost';

const KEY = 'newt:repost';

const draft: RepostDraft = {
  title: 'On looms',
  embed: {
    kind: 'post',
    href: '/u/ada/on-looms',
    url: 'https://newt.test/u/ada/on-looms',
    title: 'On looms',
    source: 'Ada Lovelace',
  },
};

const stash = (value: unknown) =>
  sessionStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));

// takeRepost holds its answer for the life of the page, so each test needs both
// halves of that reset - the stash and the copy already read out of it.
beforeEach(() => { sessionStorage.clear(); clearRepost(); });

describe('takeRepost', () => {
  it('hands the composer what the reader stashed', () => {
    stash(draft);
    expect(takeRepost()).toEqual(draft);
  });

  it('empties the stash as it reads it', () => {
    stash(draft);
    expect(takeRepost()).not.toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  // The composer reads this while rendering, and StrictMode renders twice and
  // keeps one of the two passes. A read that consumed the draft would hand it
  // to the pass React discards, and the repost would open empty.
  it('answers the same both times a single render asks', () => {
    stash(draft);
    expect(takeRepost()).toEqual(draft);
    expect(takeRepost()).toEqual(draft);
  });

  it('has nothing left once the composer that opened on it lets go', () => {
    stash(draft);
    expect(takeRepost()).not.toBeNull();
    clearRepost();
    expect(takeRepost()).toBeNull();
  });

  it('is null when nothing was stashed', () => {
    expect(takeRepost()).toBeNull();
  });

  it('refuses a draft it does not recognise rather than seeding half of one', () => {
    for (const bad of ['not json', {}, { embed: null }, { embed: { kind: 'post' } }]) {
      stash(bad);
      expect(takeRepost()).toBeNull();
    }
  });

  it('survives a stash written without a title', () => {
    stash({ embed: draft.embed });
    expect(takeRepost()?.title).toBe('');
  });
});

describe('repostBody', () => {
  const body = repostBody(draft.embed);
  const root = () => {
    const d = document.createElement('div');
    d.innerHTML = body;
    return d;
  };

  it('opens on the reference, at the size that makes it the subject', () => {
    const embed = root().querySelector(`.${EMBED_CLASS}`)!;
    expect(embed.getAttribute('data-variant')).toBe('large');
    expect(embed.getAttribute('data-url')).toBe(draft.embed.url);
  });

  it('leaves an empty line under it to write in', () => {
    const ps = root().querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[1].textContent).toBe('');
  });

  it('survives the <p> round-trip the parser puts a body through', () => {
    // A block element inside <p> would be hoisted out, orphaning the wrapper
    expect(root().querySelectorAll(`.${EMBED_CLASS}`)).toHaveLength(1);
  });
});
