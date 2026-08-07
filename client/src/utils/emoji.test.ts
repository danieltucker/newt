import { describe, it, expect } from 'vitest';
import { EMOJI_GROUPS, searchEmoji } from './emoji';

// searchEmoji returns entries; the character is what a test cares about.
const chars = (q: string) => (searchEmoji(q) ?? []).map(e => e.ch);

describe('searchEmoji', () => {
  it('returns null for a blank query, so the picker can show its groups', () => {
    expect(searchEmoji('')).toBeNull();
    expect(searchEmoji('   ')).toBeNull();
  });

  it('finds by name', () => {
    expect(chars('heart')).toContain('❤️');
    expect(chars('rocket')).toEqual(['🚀']);
  });

  it('finds by typed emoticon', () => {
    expect(chars('<3')).toContain('❤️');
    expect(chars('</3')).toEqual(['💔']);
    expect(chars(':)')).toContain('🙂');
    expect(chars(':(')).toContain('😢');
    expect(chars(';)')).toEqual(['😉']);
    expect(chars(':d')).toContain('😄');
    expect(chars('+1')).toEqual(['👍']);
    expect(chars('-1')).toEqual(['👎']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(chars('  FIRE ')).toEqual(chars('fire'));
    expect(chars(':P')).toEqual(chars(':p'));
  });

  it('matches on a prefix of a term', () => {
    expect(chars('thumb')).toEqual(['👍', '👎']);
    expect(chars('cele')).toContain('🥳');   // "celebrate"
  });

  it('does not match mid-term, so one word does not drag in every relative', () => {
    // "art" is inside "heart" but is not how anyone looks for one.
    expect(chars('art')).toEqual([]);
  });

  it('narrows on each extra word rather than widening', () => {
    const open = chars('open');
    const book = chars('book');
    const both = chars('open book');
    expect(both).toEqual(['📖']);
    expect(open.length).toBeGreaterThan(both.length);
    expect(book.length).toBeGreaterThan(both.length);
  });

  it('reports nothing for a query that matches nothing', () => {
    expect(searchEmoji('qqqq')).toEqual([]);
  });

  it('keeps table order, so the first hit is the most likely one', () => {
    // Smileys come before Hearts in the table, and 😍 lists "love" ahead of
    // ❤️ doing the same - Enter on a search should land on the face.
    expect(chars('love')[0]).toBe('😍');
  });
});

describe('the emoji table', () => {
  const all = EMOJI_GROUPS.flatMap(g => g.items);

  it('has no duplicate characters - they are used as React keys', () => {
    expect(new Set(all.map(e => e.ch)).size).toBe(all.length);
  });

  it('gives every entry at least one search term', () => {
    const bare = all.filter(e => e.keys.length === 0 || e.keys.some(k => !k));
    expect(bare).toEqual([]);
  });

  it('keeps every term lowercase, since queries are lowercased before matching', () => {
    const shouty = all.flatMap(e => e.keys).filter(k => k !== k.toLowerCase());
    expect(shouty).toEqual([]);
  });

  it('finds every entry by its own first term', () => {
    const unreachable = all.filter(e => !chars(e.keys[0]).includes(e.ch));
    expect(unreachable).toEqual([]);
  });
});
