import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPatch } from '../services/api';

export interface ClockZone {
  city: string;
  zone: string;
}

export interface NoteDoc {
  id: string;
  title: string;
  body: string;      // HTML from the rich editor
  updatedAt?: number;
  deletedAt?: number;  // in Recently Deleted since this time; purged after 15 days
  folderId?: string;   // which note folder it lives in; undefined = ungrouped
}

// One flat level of folders in the notes tree — named, colored, no nesting.
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
  weatherLocation: string;
  weatherUnit: 'celsius' | 'fahrenheit';
  notes: string;
  noteDocs?: NoteDoc[];
  noteFolders?: NoteFolder[];
  // Top-level tree order: tokens are `folder:<id>` for folders and a note id for
  // each ungrouped note, so folders and loose notes can be interleaved freely.
  noteTreeOrder?: string[];
  noteSidebarWidth?: number;   // width (px) of the notes console tree column
  clockFormat: '12h' | '24h';
  articleOpenMode: 'new-tab' | 'same-tab' | 'iframe';
  readingListOpenMode?: 'new-tab' | 'same-tab' | 'reader';
  bookmarkOpenMode?: 'same-tab' | 'new-tab';
  bookmarkLayout?: 'panel' | 'inline';
  backgroundGradient?: 'none' | 'default';
  rssLayout?: 'list' | 'cards' | 'magazine';
  readingListLayout?: 'list' | 'cards' | 'magazine';
  readingListCollapsed?: boolean;
  rssEnabled?: boolean;
  saveArticleMode?: 'dialog' | 'instant';
  markReadOnScroll?: boolean;
  commentsShowPublic?: boolean;
  commentsDefaultPublic?: boolean; // legacy, superseded by commentsDefaultVisibility
  commentsDefaultVisibility?: 'public' | 'friends' | 'private';
  commentsSort?: 'newest' | 'oldest';
  commentsAutoExpand?: boolean;
  activeWidgets: string[];
  worldClockZones: ClockZone[];
  rssFeedUrls: string[];
  rssFeedPageSize?: 5 | 10 | 20 | 50;
}

const DEFAULTS: UserSettings = {
  searchEngine: 'google',
  searchNewTab: false,
  theme: 'dark',
  consoleEnabled: true,
  weatherLocation: '',
  weatherUnit: 'celsius',
  notes: '',
  noteDocs: [],
  noteFolders: [],
  noteTreeOrder: [],
  noteSidebarWidth: 210,
  clockFormat: '12h',
  articleOpenMode: 'new-tab',
  readingListOpenMode: 'new-tab',
  bookmarkOpenMode: 'same-tab',
  bookmarkLayout: 'panel',
  backgroundGradient: 'default',
  rssLayout: 'cards',
  readingListLayout: 'cards',
  readingListCollapsed: false,
  rssEnabled: true,
  saveArticleMode: 'dialog',
  markReadOnScroll: true,
  commentsShowPublic: true,
  commentsDefaultPublic: false,
  commentsDefaultVisibility: 'private',
  commentsSort: 'newest',
  commentsAutoExpand: false,
  activeWidgets: ['weather', 'notes'],
  worldClockZones: [],
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

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    const updated = await apiPatch<UserSettings>('/api/v1/settings', patch);
    setSettings(updated);
    return updated;
  }, []);

  return { settings, update, loaded };
}
