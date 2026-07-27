// Assembling a flat list of comment rows into a reply forest.
//
// Pulled out of the comments route so the moderator's thread view can share it.
// The two callers select different columns and apply different visibility rules,
// but the shape of a conversation is the same either way — and the orphan rule
// below is subtle enough to be worth stating in exactly one place.

export interface Threadable {
  id: string;
  parentId: string | null;
  createdAt: Date;
  replies: unknown[];
}

export type ThreadSort = 'newest' | 'oldest';

// Builds the forest. Nodes whose parent isn't in `nodes` are surfaced at root
// level rather than dropped — the reader's list is already filtered by
// visibility and by the block wall, so a parent can easily be missing while its
// reply is perfectly readable. Dropping those would silently delete comments
// from a thread the viewer is entitled to see.
//
// Roots read newest- or oldest-first as the viewer prefers; replies are always
// oldest-first, because a conversation only makes sense in the order it happened.
export function assembleThread<T extends Threadable>(nodes: T[], sort: ThreadSort = 'newest'): T[] {
  const byId = new Map<string, T>();
  for (const n of nodes) byId.set(n.id, n);

  const roots: T[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A row naming itself as its own parent would otherwise vanish from the
    // forest entirely — it is neither a root nor reachable from one.
    if (parent && parent !== node) (parent.replies as T[]).push(node);
    else roots.push(node);
  }

  const dir = sort === 'oldest' ? 1 : -1;
  roots.sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));

  const sortReplies = (n: T) => {
    const kids = n.replies as T[];
    kids.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    kids.forEach(sortReplies);
  };
  roots.forEach(sortReplies);

  return roots;
}
