import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

export interface UserSettings {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave';
  searchNewTab: boolean;
  theme: 'dark' | 'light' | 'auto';
  consoleEnabled: boolean;
  notes: string;
  noteDocs: Array<{ id: string; title: string; body: string; updatedAt?: number; deletedAt?: number; folderId?: string }>;
  noteFolders: Array<{ id: string; name: string; color: string; collapsed?: boolean }>;
  noteTreeOrder: string[];
  noteSidebarWidth: number;
  articleOpenMode: 'new-tab' | 'same-tab' | 'iframe';
  readingListOpenMode?: 'new-tab' | 'same-tab' | 'reader';
  bookmarkOpenMode?: 'same-tab' | 'new-tab';
  bookmarkLayout?: 'panel' | 'inline';
  backgroundGradient?: 'none' | 'aurora' | 'dusk' | 'ocean' | 'midnight' | 'rose';
  rssLayout?: 'list' | 'cards' | 'magazine';
  readingListLayout?: 'list' | 'cards' | 'magazine';
  readingListCollapsed?: boolean;
  rssEnabled?: boolean;
  saveArticleMode?: 'dialog' | 'instant';
  markReadOnScroll?: boolean;
  // Comments — shared threads hanging off an article's canonical URL
  commentsShowPublic?: boolean;      // see other people's public comments
  commentsDefaultPublic?: boolean;   // legacy: new comments start public (superseded)
  commentsDefaultVisibility?: 'public' | 'friends' | 'private'; // new comments' starting visibility
  commentsSort?: 'newest' | 'oldest';
  commentsAutoExpand?: boolean;      // open the thread without clicking
  // Tags the user wants flagged when they turn up. Matched client-side by
  // token (see client utils/favoriteTags) — the server only stores the list.
  favoriteTags?: string[];
  // Set once the first-run feed picker has been shown - by following something
  // or by skipping it. Its absence is what triggers the picker.
  feedOnboarded?: boolean;
  rssFeedUrls: string[];
}

const DEFAULTS: UserSettings = {
  searchEngine: 'google',
  searchNewTab: false,
  theme: 'dark',
  consoleEnabled: true,
  notes: '',
  noteDocs: [],
  noteFolders: [],
  noteTreeOrder: [],
  noteSidebarWidth: 210,
  articleOpenMode: 'new-tab',
  readingListOpenMode: 'new-tab',
  bookmarkOpenMode: 'same-tab',
  bookmarkLayout: 'panel',
  backgroundGradient: 'none',
  rssLayout: 'magazine',
  readingListLayout: 'magazine',
  readingListCollapsed: false,
  rssEnabled: true,
  saveArticleMode: 'dialog',
  markReadOnScroll: true,
  // Public by default would publish existing private thoughts the moment
  // someone starts commenting — opt in instead.
  commentsShowPublic: true,
  commentsDefaultPublic: false,
  commentsDefaultVisibility: 'private',
  commentsSort: 'newest',
  commentsAutoExpand: false,
  favoriteTags: [],
  rssFeedUrls: [],
};

function mergeWithDefaults(stored: unknown): UserSettings {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as any;
  const result = { ...DEFAULTS, ...s } as UserSettings;
  // Migrate from old single-URL field
  if (typeof s.rssFeedUrl === 'string' && s.rssFeedUrl && !Array.isArray(s.rssFeedUrls)) {
    result.rssFeedUrls = [s.rssFeedUrl];
  }
  return result;
}

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { settings: true },
  });
  res.json(mergeWithDefaults(user?.settings));
});

router.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const allowed = new Set(['searchEngine', 'searchNewTab', 'theme', 'consoleEnabled', 'notes', 'noteDocs', 'noteFolders', 'noteTreeOrder', 'noteSidebarWidth', 'articleOpenMode', 'readingListOpenMode', 'bookmarkOpenMode', 'bookmarkLayout', 'backgroundGradient', 'rssFeedUrls', 'rssFeedPageSize', 'rssLayout', 'readingListLayout', 'readingListCollapsed', 'rssEnabled', 'saveArticleMode', 'markReadOnScroll', 'commentsShowPublic', 'commentsDefaultPublic', 'commentsDefaultVisibility', 'commentsSort', 'commentsAutoExpand', 'favoriteTags', 'feedOnboarded']);
  const incoming = req.body as Record<string, unknown>;

  // Validate keys
  const invalid = Object.keys(incoming).filter(k => !allowed.has(k));
  if (invalid.length > 0) {
    res.status(400).json({ error: `Unknown settings key(s): ${invalid.join(', ')}` });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { settings: true } });
  const current = mergeWithDefaults(user?.settings);
  const updated = { ...current, ...incoming } as UserSettings;

  await prisma.user.update({ where: { id: req.userId! }, data: { settings: updated as object } });
  res.json(updated);
});

export default router;
