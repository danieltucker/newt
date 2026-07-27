import { describe, it, expect } from 'vitest';
import { assembleThread } from './commentTree';

interface Node {
  id: string;
  parentId: string | null;
  createdAt: Date;
  replies: Node[];
}

const at = (mins: number) => new Date(2026, 6, 26, 12, mins);

function node(id: string, parentId: string | null, mins: number): Node {
  return { id, parentId, createdAt: at(mins), replies: [] };
}

const ids = (nodes: Node[]): string[] => nodes.map(n => n.id);

describe('assembleThread', () => {
  it('nests replies under their parent', () => {
    const rows = [node('a', null, 0), node('b', 'a', 1), node('c', 'b', 2)];
    const tree = assembleThread(rows);
    expect(ids(tree)).toEqual(['a']);
    expect(ids(tree[0].replies)).toEqual(['b']);
    expect(ids(tree[0].replies[0].replies)).toEqual(['c']);
  });

  it('sorts roots newest-first by default', () => {
    const tree = assembleThread([node('old', null, 0), node('new', null, 5)]);
    expect(ids(tree)).toEqual(['new', 'old']);
  });

  it('sorts roots oldest-first when asked', () => {
    const tree = assembleThread([node('old', null, 0), node('new', null, 5)], 'oldest');
    expect(ids(tree)).toEqual(['old', 'new']);
  });

  it('always reads replies oldest-first, whatever the root order', () => {
    // A conversation only makes sense in the order it happened, so this does
    // not follow the viewer's root preference.
    for (const sort of ['newest', 'oldest'] as const) {
      const tree = assembleThread(
        [node('a', null, 0), node('later', 'a', 9), node('sooner', 'a', 3)],
        sort,
      );
      expect(ids(tree[0].replies)).toEqual(['sooner', 'later']);
    }
  });

  it('lifts a reply whose parent is missing up to root level', () => {
    // The caller's list is filtered by visibility and by the block wall, so a
    // parent can easily be absent while its reply is perfectly readable.
    // Dropping it would silently delete a comment from the thread.
    const tree = assembleThread([node('orphan', 'gone', 1), node('root', null, 0)]);
    expect(ids(tree).sort()).toEqual(['orphan', 'root']);
  });

  it('keeps a self-parented row rather than losing it', () => {
    // Not reachable through the app, but such a row is neither a root nor
    // reachable from one — without the guard it would vanish entirely.
    const tree = assembleThread([node('loop', 'loop', 0)]);
    expect(ids(tree)).toEqual(['loop']);
  });

  it('returns an empty forest for an empty list', () => {
    expect(assembleThread([])).toEqual([]);
  });

  it('places every input node somewhere in the forest exactly once', () => {
    const rows = [
      node('r1', null, 0), node('r2', null, 4),
      node('a', 'r1', 1), node('b', 'r1', 2), node('c', 'a', 3),
      node('orphan', 'missing', 5),
    ];
    const tree = assembleThread(rows);
    const seen: string[] = [];
    const walk = (ns: Node[]) => ns.forEach(n => { seen.push(n.id); walk(n.replies); });
    walk(tree);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'orphan', 'r1', 'r2']);
  });
});
