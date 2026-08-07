import { describe, it, expect } from 'vitest';
import { staticPlatformFeed, platformFeed, resolveYouTubeHandle, FetchText } from './feedSources';

const feedFor = (url: string) => staticPlatformFeed(new URL(url))?.candidates ?? null;

describe('staticPlatformFeed', () => {
  it('maps a YouTube channel id straight to its feed', () => {
    expect(feedFor('https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ')).toEqual([
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ',
    ]);
  });

  it('maps a legacy /user/ channel', () => {
    expect(feedFor('https://www.youtube.com/user/Computerphile')).toEqual([
      'https://www.youtube.com/feeds/videos.xml?user=Computerphile',
    ]);
  });

  it('maps a playlist by its list param, wherever the path points', () => {
    expect(feedFor('https://www.youtube.com/playlist?list=PLabc123')).toEqual([
      'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc123',
    ]);
  });

  it('recognises a YouTube feed URL as already being one', () => {
    const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ';
    expect(feedFor(url)).toEqual([url]);
  });

  // The handle form is the one case that has to go and look, so it must not be
  // answered synchronously with a guess.
  it('does not answer a YouTube @handle without a lookup', () => {
    expect(feedFor('https://www.youtube.com/@mkbhd')).toBeNull();
  });

  it('rejects a channel id that is not one', () => {
    expect(feedFor('https://www.youtube.com/channel/not-a-channel')).toBeNull();
  });

  it('maps a Bluesky profile', () => {
    expect(feedFor('https://bsky.app/profile/pfrazee.com')).toEqual([
      'https://bsky.app/profile/pfrazee.com/rss',
    ]);
  });

  it('maps a subreddit and a Reddit user, including the /u/ shorthand', () => {
    expect(feedFor('https://www.reddit.com/r/programming/')).toEqual([
      'https://www.reddit.com/r/programming/.rss',
    ]);
    expect(feedFor('https://reddit.com/u/spez')).toEqual([
      'https://www.reddit.com/user/spez/.rss',
    ]);
  });

  // Releases are what "follow this project" means; commits are the answer for a
  // repo that doesn't cut them, so both have to be offered.
  it('offers releases then commits for a GitHub repo', () => {
    expect(feedFor('https://github.com/facebook/react')).toEqual([
      'https://github.com/facebook/react/releases.atom',
      'https://github.com/facebook/react/commits.atom',
    ]);
  });

  it('leaves non-repo GitHub paths to ordinary discovery', () => {
    expect(feedFor('https://github.com/orgs/nodejs')).toBeNull();
    expect(feedFor('https://github.com/facebook')).toBeNull();
  });

  it('ignores sites it knows nothing about', () => {
    expect(feedFor('https://npr.org')).toBeNull();
    expect(feedFor('https://example.com/youtube.com/@someone')).toBeNull();
  });
});

describe('resolveYouTubeHandle', () => {
  const page = (body: string): FetchText => async () => body;

  it('reads the channel id off the canonical link', async () => {
    const html = '<link rel="canonical" href="https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA">';
    await expect(resolveYouTubeHandle(new URL('https://www.youtube.com/@veritasium'), page(html)))
      .resolves.toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
  });

  it('falls back to the itemprop identifier', async () => {
    const html = '<meta itemprop="identifier" content="UCHnyfMqiRRG1u-2MsSQLbXA">';
    await expect(resolveYouTubeHandle(new URL('https://www.youtube.com/@veritasium'), page(html)))
      .resolves.toBe('UCHnyfMqiRRG1u-2MsSQLbXA');
  });

  // The regression this guards: a channel page inlines the ids of the channels
  // it recommends, and "channelId":"UC…" matches one of those long before it
  // matches the channel you asked for. Scraping it subscribes you to a stranger.
  it('ignores channel ids inlined in the page JSON', async () => {
    const html = '{"channelId":"UCG7J20LhUeLl6y_Emi7OJrA"} <span>UCtQlKVOH4xJCGE24I8XWsFJ</span>';
    await expect(resolveYouTubeHandle(new URL('https://www.youtube.com/@mkbhd'), page(html)))
      .resolves.toBeNull();
  });

  it('gives up quietly when the page cannot be read', async () => {
    const none: FetchText = async () => null;
    await expect(resolveYouTubeHandle(new URL('https://www.youtube.com/@mkbhd'), none))
      .resolves.toBeNull();
  });
});

describe('platformFeed', () => {
  it('resolves a handle through a lookup', async () => {
    const html: FetchText = async () =>
      '<link rel="canonical" href="https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ">';
    const result = await platformFeed(new URL('https://www.youtube.com/@mkbhd'), html);
    expect(result?.candidates).toEqual([
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ',
    ]);
  });

  // Null means "let ordinary discovery try", which is what keeps this a
  // shortcut rather than a gate on the whole domain.
  it('returns null for a YouTube URL it cannot place', async () => {
    const none: FetchText = async () => null;
    await expect(platformFeed(new URL('https://www.youtube.com/watch?v=abc'), none))
      .resolves.toBeNull();
  });

  it('needs no fetch for an address it can map on its own', async () => {
    const explode: FetchText = async () => { throw new Error('should not fetch'); };
    const result = await platformFeed(new URL('https://bsky.app/profile/bsky.app'), explode);
    expect(result?.source).toBe('Bluesky');
  });
});
