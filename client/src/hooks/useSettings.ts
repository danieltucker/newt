import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPatch } from '../services/api';

export interface NoteDoc {
  id: string;
  title: string;
  body: string;      // HTML from the rich editor
  updatedAt?: number;
  deletedAt?: number;  // in Recently Deleted since this time; purged after 15 days
  folderId?: string;   // which note folder it lives in; undefined = ungrouped
}

// One flat level of folders in the notes tree - named, colored, no nesting.
export interface NoteFolder {
  id: string;
  name: string;
  color: string;
  collapsed?: boolean;   // persisted expand/collapse state
}

export interface UserSettings {
  searchEngine: 'google' | 'duckduckgo' | 'bing' | 'brave';
  searchNewTab: boolean;
  theme: 'dark' | 'light' | 'auto';
  consoleEnabled: boolean;
  notes: string;
  noteDocs?: NoteDoc[];
  noteFolders?: NoteFolder[];
  // Top-level tree order: tokens are `folder:<id>` for folders and a note id for
  // each ungrouped note, so folders and loose notes can be interleaved freely.
  noteTreeOrder?: string[];
  noteSidebarWidth?: number;   // width (px) of the notes console tree column
  /**
   * Which revision of the notes tree this copy is. Handed out by the server and
   * echoed back on every notes write so it can tell an edit made against the
   * current tree from one made against whatever an old tab still has on screen.
   * See utils/noteMerge and the PATCH handler in server routes/settings.
   */
  notesRev?: number;
  /**
   * Set on a PATCH *reply* only, never stored: the write was reconciled against
   * newer notes rather than taken as sent, and the caller should adopt what
   * came back.
   */
  notesMerged?: boolean;
  articleOpenMode: 'new-tab' | 'same-tab' | 'iframe';
  readingListOpenMode?: 'new-tab' | 'same-tab' | 'reader';
  bookmarkOpenMode?: 'same-tab' | 'new-tab';
  bookmarkLayout?: 'panel' | 'inline';
  backgroundGradient?: 'none' | 'default';
  rssLayout?: 'list' | 'cards' | 'magazine';
  readingListLayout?: 'list' | 'cards' | 'magazine';
  /** How a publisher's page (/s/<domain>) draws its articles. Separate from
      the feed's: a site page is one publisher's output, which people read
      differently from the river. */
  siteLayout?: 'list' | 'cards' | 'magazine';
  rssEnabled?: boolean;
  saveArticleMode?: 'dialog' | 'instant';
  markReadOnScroll?: boolean;
  commentsShowPublic?: boolean;
  commentsDefaultPublic?: boolean; // legacy, superseded by commentsDefaultVisibility
  commentsDefaultVisibility?: 'public' | 'friends' | 'private';
  commentsSort?: 'newest' | 'oldest';
  commentsAutoExpand?: boolean;
  // Topics worth noticing. Stored as typed, matched by token - see
  // utils/favoriteTags. Decoration only: it marks what's on screen, it does not
  // reorder or filter the server's pages.
  favoriteTags?: string[];
  /** Set once the first-run feed picker has been shown - by following
      something or by skipping it. Its absence is what triggers the picker, so
      it must be written in both cases. */
  feedOnboarded?: boolean;
  // ── AI ──
  // How much answer to ask for, which is also the main control on what the AI
  // features cost. See server/src/lib/llm/depth.ts.
  aiDepth?: 'brief' | 'balanced' | 'thorough';
  /** Whether research may search this user's own feed before answering. */
  aiFeedSearch?: boolean;
  /** Show the estimated price of each answer under it. */
  aiShowCost?: boolean;
  rssFeedUrls: string[];
  rssFeedPageSize?: 5 | 10 | 20 | 50;
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
  notesRev: 0,
  articleOpenMode: 'new-tab',
  readingListOpenMode: 'new-tab',
  bookmarkOpenMode: 'same-tab',
  bookmarkLayout: 'panel',
  backgroundGradient: 'default',
  rssLayout: 'magazine',
  readingListLayout: 'magazine',
  siteLayout: 'list',
  rssEnabled: true,
  saveArticleMode: 'dialog',
  markReadOnScroll: true,
  commentsShowPublic: true,
  commentsDefaultPublic: false,
  commentsDefaultVisibility: 'private',
  commentsSort: 'newest',
  commentsAutoExpand: false,
  favoriteTags: [],
  rssFeedUrls: [],
  rssFeedPageSize: 10,
};

export function useSettings(accessToken: string | null) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    apiGet<UserSettings>('/api/v1/settings')
      .then(s => { setSettings(s); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [accessToken]);

  /**
   * Read the settings again. Everything here is fetched once, at sign-in, which
   * is right for a preference and wrong for the notes: a tab open since this
   * morning is holding this morning's notes, and opening the console in it is
   * the moment that matters. Callers do this before showing a surface whose
   * content another device may have moved on from.
   */
  const refresh = useCallback(async () => {
    const s = await apiGet<UserSettings>('/api/v1/settings');
    setSettings(s);
    return s;
  }, []);

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    const updated = await apiPatch<UserSettings>('/api/v1/settings', patch);
    // `notesMerged` describes the request, not the account - keeping it in
    // state would leave the flag raised over every later render.
    const { notesMerged: _merged, ...stored } = updated;
    setSettings(stored);
    return updated;
  }, []);

  return { settings, update, refresh, loaded };
}
