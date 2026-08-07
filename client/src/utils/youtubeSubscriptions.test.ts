import { describe, it, expect } from 'vitest';
import { parseYouTubeSubscriptions, youtubeFeedUrl, isYouTubeAddress } from './youtubeSubscriptions';

const HEADER = 'Channel ID,Channel URL,Channel title';
const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
const VERITASIUM = 'UCHnyfMqiRRG1u-2MsSQLbXA';

describe('parseYouTubeSubscriptions', () => {
  it('reads a Takeout export', () => {
    const csv = [
      HEADER,
      `${MKBHD},http://www.youtube.com/channel/${MKBHD},Marques Brownlee`,
      `${VERITASIUM},http://www.youtube.com/channel/${VERITASIUM},Veritasium`,
    ].join('\n');
    expect(parseYouTubeSubscriptions(csv)).toEqual([
      { channelId: MKBHD, title: 'Marques Brownlee', feedUrl: youtubeFeedUrl(MKBHD) },
      { channelId: VERITASIUM, title: 'Veritasium', feedUrl: youtubeFeedUrl(VERITASIUM) },
    ]);
  });

  // Channel titles are whatever someone typed, so a comma in one is ordinary.
  it('keeps a quoted title containing commas and quotes whole', () => {
    const csv = `${HEADER}\n${MKBHD},url,"Earth, Wind & Fire ""Official"""`;
    expect(parseYouTubeSubscriptions(csv)[0].title).toBe('Earth, Wind & Fire "Official"');
  });

  it('locates columns by name, not by position', () => {
    const csv = `Channel title,Channel URL,Channel ID\nMarques Brownlee,url,${MKBHD}`;
    expect(parseYouTubeSubscriptions(csv)).toEqual([
      { channelId: MKBHD, title: 'Marques Brownlee', feedUrl: youtubeFeedUrl(MKBHD) },
    ]);
  });

  // One bad row out of a file someone picked off their disk should cost that
  // row, not the import.
  it('skips junk rows and duplicates rather than failing', () => {
    const csv = [
      HEADER,
      `${MKBHD},url,Marques Brownlee`,
      'not-a-channel,url,Nonsense',
      '',
      `${MKBHD},url,Marques Brownlee again`,
    ].join('\n');
    const out = parseYouTubeSubscriptions(csv);
    expect(out).toHaveLength(1);
    expect(out[0].channelId).toBe(MKBHD);
  });

  it('handles CRLF line endings', () => {
    const csv = `${HEADER}\r\n${MKBHD},url,Marques Brownlee\r\n`;
    expect(parseYouTubeSubscriptions(csv)).toHaveLength(1);
  });

  // A file with no header still has ids in it, and the id is the part that has
  // to be right.
  it('falls back to finding the id column when there is no header', () => {
    const csv = `${MKBHD},http://youtube.com/channel/${MKBHD},Marques Brownlee`;
    expect(parseYouTubeSubscriptions(csv)).toEqual([
      { channelId: MKBHD, title: 'Marques Brownlee', feedUrl: youtubeFeedUrl(MKBHD) },
    ]);
  });

  it('returns nothing for a file that is not this', () => {
    expect(parseYouTubeSubscriptions('')).toEqual([]);
    expect(parseYouTubeSubscriptions('name,email\nAda,ada@example.com')).toEqual([]);
  });
});

describe('isYouTubeAddress', () => {
  it('recognises the forms people paste, with or without a scheme', () => {
    expect(isYouTubeAddress('https://www.youtube.com/@mkbhd')).toBe(true);
    expect(isYouTubeAddress('youtube.com/@mkbhd')).toBe(true);
    expect(isYouTubeAddress('  http://m.youtube.com/watch?v=abc  ')).toBe(true);
    expect(isYouTubeAddress('youtu.be/abc')).toBe(true);
  });

  // The cost of a false positive is a panel opening while somebody types, so a
  // hostname that merely contains the word is not enough.
  it('is not fooled by a lookalike host or a path', () => {
    expect(isYouTubeAddress('notyoutube.com')).toBe(false);
    expect(isYouTubeAddress('example.com/youtube.com/@mkbhd')).toBe(false);
    expect(isYouTubeAddress('')).toBe(false);
    expect(isYouTubeAddress('   ')).toBe(false);
  });
});
