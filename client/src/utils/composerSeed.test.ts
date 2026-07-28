// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { EMBED_CLASS } from './noteEmbed';
import {
  repostBody, stashSeed, takeSeed, clearSeed, ComposerSeed, RepostDraft,
} from './composerSeed';

const KEY = 'newt:compose';

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

const seed: ComposerSeed = { title: 'On looms', body: '<p>Punched cards.</p>' };

const stash = (value: unknown) =>
  sessionStorage.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value));

// takeSeed holds its answer for the life of the page, so each test needs both
// halves of that reset - the stash and the copy already read out of it.
beforeEach(() => { sessionStorage.clear(); clearSeed(); });

describe('takeSeed', () => {
  it('hands the composer what was stashed', () => {
    stash(seed);
    expect(takeSeed()).toEqual(seed);
  });

  it('empties the stash as it reads it', () => {
    stash(seed);
    expect(takeSeed()).not.toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  // The composer reads this while rendering, and StrictMode renders twice and
  // keeps one of the two passes. A read that consumed the seed would hand it
  // to the pass React discards, and the composer would open empty.
  it('answers the same both times a single render asks', () => {
    stash(seed);
    expect(takeSeed()).toEqual(seed);
    expect(takeSeed()).toEqual(seed);
  });

  it('has nothing left once the composer that opened on it lets go', () => {
    stash(seed);
    expect(takeSeed()).not.toBeNull();
    clearSeed();
    expect(takeSeed()).toBeNull();
  });

  it('is null when nothing was stashed', () => {
    expect(takeSeed()).toBeNull();
  });

  it('refuses a seed it does not recognise rather than opening half of one', () => {
    for (const bad of ['not json', {}, { title: 'x' }, { body: '<p>x</p>' }, { title: 1, body: 2 }]) {
      stash(bad);
      expect(takeSeed()).toBeNull();
    }
  });
});

describe('stashSeed', () => {
  it('round-trips a note body through the stash untouched', () => {
    // Turning a note into a post carries its markup across verbatim - lists,
    // headings and reference cards all have to survive the crossing.
    const note: ComposerSeed = {
      title: 'Reading queue',
      body: '<h2>Queue</h2><ul><li>Looms</li></ul>',
    };
    stashSeed(note);
    expect(takeSeed()).toEqual(note);
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
