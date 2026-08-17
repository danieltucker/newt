// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { shareLinkFor } from './shareLink';

// Where Share sends people.
//
// The rule this pins down is the one the first version of Share got wrong: an
// article published elsewhere has no page here except the reader, but a post
// written *here* already has one, and wrapping that in /a/ handed readers a
// generic reader whose only route to the post was "Open original".
//
// noteEmbed makes the same distinction when it decides where a reference card
// points, so the two must not drift apart.

const ORIGIN = 'https://newt.page';

beforeEach(() => {
  // blogRefOfUrl is origin-checked, so these tests only mean anything with a
  // known origin to check against.
  Object.defineProperty(window, 'location', {
    value: new URL(ORIGIN) as unknown as Location,
    writable: true,
  });
});

describe('shareLinkFor', () => {
  it('sends a post to its own page, not to the article reader', () => {
    expect(shareLinkFor(`${ORIGIN}/u/dan/my-post`)).toBe(`${ORIGIN}/u/dan/my-post`);
  });

  it('sends an article published elsewhere to the reader', () => {
    const link = shareLinkFor('https://techcrunch.com/2026/08/16/a-story/');
    expect(link.startsWith(`${ORIGIN}/a/`)).toBe(true);
  });

  // The origin check is the security-relevant half: a feed can carry any link,
  // and a lookalike /u/<name>/<slug> on somebody else's host must not be
  // rewritten into a path on this instance.
  it('does not treat a lookalike post path on another host as one of ours', () => {
    const link = shareLinkFor('https://evil.example/u/dan/my-post');
    expect(link.startsWith(`${ORIGIN}/a/`)).toBe(true);
    expect(link).not.toContain('/u/dan/my-post');
  });

  // Usernames are not charset-restricted server-side, so the segment is
  // encoded - the same thing blogPathFor does, and the same bug the explored
  // paths list had.
  it('encodes a username that needs it', () => {
    expect(shareLinkFor(`${ORIGIN}/u/a%20b/my-post`)).toBe(`${ORIGIN}/u/a%20b/my-post`);
  });

  it('always returns an absolute link on this instance', () => {
    for (const url of [`${ORIGIN}/u/dan/p`, 'https://example.com/x']) {
      expect(shareLinkFor(url).startsWith(`${ORIGIN}/`)).toBe(true);
    }
  });

  // A profile is one segment, not two, so it is not a post - it must fall
  // through to the reader rather than being mistaken for one.
  it('does not mistake a bare profile for a post', () => {
    expect(shareLinkFor(`${ORIGIN}/u/dan`).startsWith(`${ORIGIN}/a/`)).toBe(true);
  });
});
