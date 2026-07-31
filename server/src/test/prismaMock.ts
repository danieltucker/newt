import { vi } from 'vitest';

// A stand-in for the Prisma client, so route tests can mount the real app and
// assert on the queries a route builds.
//
// Why a mock rather than a test database: the gap these tests close is "does this
// route actually apply the filter it imports?" — user scoping on every where
// clause, the block wall on search, the status transitions on a friend request.
// That is a question about the arguments the route passes to Prisma, and a mock
// answers it exactly, with no container to start and no risk of pointing at the
// dev database. It deliberately does not check that the SQL means what we think
// it means; a real-Postgres suite is the complement to this, not a thing this
// replaces.

const MODELS = [
  'user', 'friendship', 'notification', 'block', 'report', 'bookmark', 'folder',
  'readingListItem', 'readingFolder', 'comment', 'blogPost', 'image', 'feed',
  'feedItem', 'folderFeed', 'readFeedItem', 'dismissedFeedItem', 'refreshToken',
  'adminAction', 'commentRevision',
] as const;

const METHODS = [
  'findUnique', 'findFirst', 'findMany', 'create', 'createMany', 'update',
  'updateMany', 'delete', 'deleteMany', 'count', 'upsert', 'groupBy', 'aggregate',
] as const;

type Model = Record<(typeof METHODS)[number], ReturnType<typeof vi.fn>>;
export type PrismaMock = Record<(typeof MODELS)[number], Model> & {
  $transaction: ReturnType<typeof vi.fn>;
};

function makeModel(): Model {
  const model = {} as Model;
  for (const method of METHODS) model[method] = vi.fn();
  return model;
}

export const prismaMock = {
  $transaction: vi.fn(),
} as PrismaMock;

for (const name of MODELS) prismaMock[name] = makeModel();

// Defaults chosen so an unstubbed call returns "nothing found" rather than
// undefined. A route that forgets to stub something then 404s, which shows up as
// a clear test failure instead of a confusing TypeError deep inside a handler.
export function resetPrismaMock(): void {
  for (const name of MODELS) {
    const model = prismaMock[name];
    for (const method of METHODS) {
      model[method].mockReset();
      switch (method) {
        case 'findMany': model[method].mockResolvedValue([]); break;
        case 'count':    model[method].mockResolvedValue(0); break;
        case 'createMany':
        case 'updateMany':
        case 'deleteMany': model[method].mockResolvedValue({ count: 0 }); break;
        case 'findUnique':
        case 'findFirst': model[method].mockResolvedValue(null); break;
        default: model[method].mockResolvedValue({});
      }
    }
  }
  prismaMock.$transaction.mockReset();
  prismaMock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: PrismaMock) => unknown)(prismaMock)
      : Promise.all(arg as Promise<unknown>[]),
  );
}

// A Prisma unique-constraint violation, for exercising the paths that catch it.
export function uniqueViolation(target: string[] = ['pairKey']): Error & { code: string } {
  const err = new Error('Unique constraint failed') as Error & { code: string; meta?: unknown };
  err.code = 'P2002';
  err.meta = { target };
  return err;
}
