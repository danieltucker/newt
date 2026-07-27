import { describe, it, expect } from 'vitest';
import { summarizeMetadata } from './auditMetadata';

describe('summarizeMetadata', () => {
  it('renders a from/to pair as an arrow', () => {
    expect(summarizeMetadata({ visibility: { from: 'public', to: 'private' } }))
      .toBe('visibility public → private');
  });

  it('renders a boolean from/to pair as yes/no rather than true/false', () => {
    expect(summarizeMetadata({ isAdmin: { from: false, to: true } }))
      .toBe('is admin no → yes');
  });

  it('lists only the non-zero parts of a cascade census', () => {
    const line = summarizeMetadata({
      cascaded: { bookmarks: 12, folders: 0, readingItems: 3, comments: 0, blogPosts: 1 },
    });
    expect(line).toBe('12 bookmarks, 3 reading items, 1 blog posts');
  });

  it('drops a cascade census that destroyed nothing', () => {
    expect(summarizeMetadata({ cascaded: { bookmarks: 0, folders: 0 } })).toBe('-');
  });

  it('shows bare strings unlabelled', () => {
    expect(summarizeMetadata({ outcome: 'tombstoned' })).toBe('tombstoned');
  });

  it('joins several fields with a separator', () => {
    expect(summarizeMetadata({ outcome: 'removed', snippet: 'spam text' }))
      .toBe('removed · spam text');
  });

  it('skips fields already shown elsewhere or too long to help', () => {
    expect(summarizeMetadata({
      email: 'x@y.com',
      registeredAt: '2026-01-01T00:00:00.000Z',
      previouslyBannedAt: null,
      wasAdmin: true,
    })).toBe('was admin yes');
  });

  it('drops empty, null and zero values rather than printing noise', () => {
    expect(summarizeMetadata({ snippet: '', sessionsRevoked: 0, thing: null })).toBe('-');
  });

  it('keeps a non-zero count labelled', () => {
    expect(summarizeMetadata({ sessionsRevoked: 3 })).toBe('sessions revoked 3');
  });

  it('returns a dash for null, undefined and empty metadata', () => {
    expect(summarizeMetadata(null)).toBe('-');
    expect(summarizeMetadata(undefined)).toBe('-');
    expect(summarizeMetadata({})).toBe('-');
  });

  it('truncates a long line rather than blowing out the column', () => {
    const line = summarizeMetadata({ snippet: 'x'.repeat(400) });
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith('…')).toBe(true);
  });

  it('renders an unrecognised shape instead of a blank cell', () => {
    // A row written by a newer server must still say something.
    const line = summarizeMetadata({ somethingNew: ['a', 'b'] });
    expect(line).not.toBe('-');
    expect(line).toContain('something new');
  });
});
