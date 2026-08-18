import { describe, it, expect } from 'vitest';
import { railPlaces, activeRailPlace } from './railPlaces';

const ids = (list: { id: string }[]) => list.map(p => p.id);

describe('railPlaces', () => {
  it('offers the places that have addresses today', () => {
    expect(ids(railPlaces())).toEqual(['today', 'posts']);
  });

  it('adds Explore only once a model is connected', () => {
    expect(ids(railPlaces({ hasModel: true }))).toEqual(['today', 'posts', 'explore']);
    expect(ids(railPlaces({ hasModel: false }))).not.toContain('explore');
  });

  it('points Posts at the blog manager rather than the public tab', () => {
    // Drafts only exist in the manager, so /blog is the honest destination.
    expect(railPlaces().find(p => p.id === 'posts')?.href).toBe('/blog');
  });
});

describe('activeRailPlace', () => {
  it('lights up Today on the new tab only', () => {
    expect(activeRailPlace('/')).toBe('today');
    expect(activeRailPlace('')).toBe('today');
  });

  it('claims the whole subtree a place owns', () => {
    expect(activeRailPlace('/blog')).toBe('posts');
    expect(activeRailPlace('/blog/new')).toBe('posts');
    expect(activeRailPlace('/blog/abc123')).toBe('posts');
    expect(activeRailPlace('/explore')).toBe('explore');
    expect(activeRailPlace('/explore/thread1')).toBe('explore');
  });

  it('lights up nothing for settings or the admin console', () => {
    // Neither is in the rail - they are the avatar menu's, on the account side
    // of the split. A highlight with no row to land on is worse than none.
    expect(activeRailPlace('/settings')).toBeNull();
    expect(activeRailPlace('/settings/reading')).toBeNull();
    expect(activeRailPlace('/admin')).toBeNull();
    expect(activeRailPlace('/admin/users')).toBeNull();
  });

  it('lights up nothing where the rail names nothing', () => {
    // Arrived from a link. Highlighting Today because nothing else matched
    // would tell the reader they are somewhere they are not.
    expect(activeRailPlace('/u/maren')).toBeNull();
    expect(activeRailPlace('/u/maren/a-post')).toBeNull();
    expect(activeRailPlace('/s/theverge.com')).toBeNull();
    expect(activeRailPlace('/t/design')).toBeNull();
    expect(activeRailPlace('/recent')).toBeNull();
    expect(activeRailPlace('/e/shared1')).toBeNull();
  });

  it('does not let a neighbouring path steal a place', () => {
    expect(activeRailPlace('/blogroll')).toBeNull();
  });

  it('only ever names a row that exists', () => {
    // Every id activeRailPlace can return has to be a row in the rail, or the
    // highlight lands on nothing.
    const known = new Set(ids(railPlaces({ hasModel: true })));
    for (const path of ['/', '/blog', '/blog/new', '/explore', '/explore/x']) {
      expect(known).toContain(activeRailPlace(path));
    }
  });
});
