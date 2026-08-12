import { Router, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { mergeNoteDocs, mergeNoteFolders, mergeNoteOrder } from '../lib/noteMerge';

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
  /**
   * Bumped by the server on every write that touches the notes tree. A client
   * sends back the one it last read; if it doesn't match, that client is
   * working from an older copy and its write is merged rather than taken
   * wholesale. See lib/noteMerge for why, and for what that costs.
   */
  notesRev: number;
  articleOpenMode: 'new-tab' | 'same-tab' | 'iframe';
  readingListOpenMode?: 'new-tab' | 'same-tab' | 'reader';
  bookmarkOpenMode?: 'same-tab' | 'new-tab';
  bookmarkLayout?: 'panel' | 'inline';
  backgroundGradient?: 'none' | 'aurora' | 'dusk' | 'ocean' | 'midnight' | 'rose';
  rssLayout?: 'list' | 'cards' | 'magazine';
  readingListLayout?: 'list' | 'cards' | 'magazine';
  siteLayout?: 'list' | 'cards' | 'magazine';
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
  // ── AI ──
  // How much answer to ask for, which is also the main control on what it
  // costs: see lib/llm/depth.ts for what each level actually changes.
  aiDepth?: 'brief' | 'balanced' | 'thorough';
  // Whether research may search this user's own feed for relevant articles
  // before answering. Costs one cheap extra call per question.
  aiFeedSearch?: boolean;
  // Show the estimated price of each answer underneath it.
  aiShowCost?: boolean;
  rssFeedUrls: string[];
}

const DEFAULTS: UserSettings = {
  searchEngine: 'google',
  searchNewTab: true,
  theme: 'dark',
  consoleEnabled: true,
  notes: '',
  noteDocs: [],
  noteFolders: [],
  noteTreeOrder: [],
  noteSidebarWidth: 210,
  notesRev: 0,
  articleOpenMode: 'new-tab',
  readingListOpenMode: 'new-tab',
  bookmarkOpenMode: 'same-tab',
  bookmarkLayout: 'panel',
  backgroundGradient: 'none',
  rssLayout: 'magazine',
  readingListLayout: 'magazine',
  siteLayout: 'list',
  rssEnabled: true,
  // Saving is one click by default: the dialog is there for the reader who
  // wants to tag and retitle on the way in, not for the common case.
  saveArticleMode: 'instant',
  markReadOnScroll: true,
  // Public by default would publish existing private thoughts the moment
  // someone starts commenting — opt in instead.
  commentsShowPublic: true,
  commentsDefaultPublic: false,
  commentsDefaultVisibility: 'private',
  commentsSort: 'newest',
  commentsAutoExpand: false,
  favoriteTags: [],
  // 'balanced' rather than 'thorough': the first release shipped with the
  // equivalent of thorough as the only option, which was startlingly
  // expensive on a reasoning model. Depth is a choice now, and the default
  // is the one that suits most questions.
  aiDepth: 'balanced',
  aiFeedSearch: true,
  aiShowCost: true,
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

// The three keys that make up the notes tree. They are written together and
// versioned together - an order that mentions a note the doc list doesn't have
// is not a state worth being able to reach.
const NOTE_KEYS = ['noteDocs', 'noteFolders', 'noteTreeOrder'] as const;

router.patch('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const allowed = new Set(['searchEngine', 'searchNewTab', 'theme', 'consoleEnabled', 'notes', 'noteDocs', 'noteFolders', 'noteTreeOrder', 'noteSidebarWidth', 'notesRev', 'articleOpenMode', 'readingListOpenMode', 'bookmarkOpenMode', 'bookmarkLayout', 'backgroundGradient', 'rssFeedUrls', 'rssFeedPageSize', 'rssLayout', 'readingListLayout', 'siteLayout', 'rssEnabled', 'saveArticleMode', 'markReadOnScroll', 'commentsShowPublic', 'commentsDefaultPublic', 'commentsDefaultVisibility', 'commentsSort', 'commentsAutoExpand', 'favoriteTags', 'feedOnboarded', 'aiDepth', 'aiFeedSearch', 'aiShowCost']);
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

  // ── Notes: never a blind replace by a client that hasn't caught up ──
  const touchesNotes = NOTE_KEYS.some(k => k in incoming);
  let notesMerged = false;
  if (touchesNotes) {
    const storedRev = current.notesRev ?? 0;
    const base = incoming.notesRev;
    // A write with no revision on it comes from a page loaded before this
    // existed, which is precisely the tab most likely to be out of date. Treat
    // the unknown base as a stale one.
    const upToDate = typeof base === 'number' && base === storedRev;
    if (!upToDate) {
      notesMerged = true;
      if ('noteDocs' in incoming) {
        updated.noteDocs = mergeNoteDocs(current.noteDocs ?? [], updated.noteDocs ?? []);
      }
      if ('noteFolders' in incoming) {
        updated.noteFolders = mergeNoteFolders(current.noteFolders ?? [], updated.noteFolders ?? []);
      }
      if ('noteTreeOrder' in incoming) {
        updated.noteTreeOrder = mergeNoteOrder(current.noteTreeOrder ?? [], updated.noteTreeOrder ?? []);
      }
    }
    // The revision is the server's to hand out - a client echoing one back is
    // saying which copy it edited, not choosing the next number.
    updated.notesRev = storedRev + 1;
  } else {
    updated.notesRev = current.notesRev ?? 0;
  }

  await prisma.user.update({ where: { id: req.userId! }, data: { settings: updated as object } });
  // `notesMerged` is about this one request, so it is reported and not stored:
  // it tells the console that what came back is not what it sent, and that it
  // should take the reply on board rather than carry on from its own copy.
  res.json(notesMerged ? { ...updated, notesMerged: true } : updated);
});

export default router;
