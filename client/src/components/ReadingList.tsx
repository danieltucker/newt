import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './ReadingList.module.css';
import { ReadingListItem, ReadingFolder, CommentPrefs } from '../types';
import { parseDomain } from '../utils/color';
import { apiFetch } from '../services/api';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { CommentBar } from './CommentsPanel';
import ArticleDetailModal from './ArticleDetailModal';
import TagChipInput from './TagChipInput';
import { StarIcon } from './TagChip';
import FavoritesControl from './FavoritesControl';
import {
  prepareFavorites, favoritesFor, isFavoriteTag, coveringFavorites, PreparedFavorite,
} from '../utils/favoriteTags';
import EditArticleModal from './EditArticleModal';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FilterDropdown from './FilterDropdown';

export type ReadingListLayout = 'list' | 'cards' | 'magazine';

// Above this many tags, the chip row collapses into a searchable dropdown
const MAX_TAG_CHIPS = 12;

const LAYOUT_OPTIONS = [
  { value: 'list' as const,     title: 'List',     icon: <ListIcon /> },
  { value: 'cards' as const,    title: 'Cards',    icon: <CardsIcon /> },
  { value: 'magazine' as const, title: 'Magazine', icon: <MagazineIcon /> },
];

// Deletes and Library moves no longer reflow the grid at all - the card holds
// its place as a greyed-out placeholder until the next load - so there is no
// longer anything for a view transition to animate here.

// ── Magazine layout variants (saved articles have no artwork, so the mix
// comes from big text features and full-note briefs) ──
type MagVariant = 'feature' | 'brief' | 'standard' | 'text';

// Cheap stable hash so a card keeps its look across refreshes
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function magazineVariants(items: ReadingListItem[]): MagVariant[] {
  let sinceFeature = 4; // lets the first feature lead the page
  return items.map(item => {
    const readTime = parseInt(item.readTime, 10) || 0;
    const notesLen = item.notes?.length ?? 0;
    const hasImage = !!item.imageUrl;
    // Short notes on an art-less item run in full as a brief
    if (!hasImage && notesLen > 0 && notesLen <= 200 && readTime <= 2) {
      sinceFeature++;
      return 'brief';
    }
    // Features fill a wide banner, so they need artwork
    const featureWorthy = hasImage && (readTime >= 4 || notesLen >= 240 || hashId(item.id) % 3 === 0);
    if (featureWorthy && sinceFeature >= 4) {
      sinceFeature = 0;
      return 'feature';
    }
    sinceFeature++;
    // Anything with a cover shows it; art-less items become text cards
    return hasImage ? 'standard' : 'text';
  });
}

// ── "You have N minutes saved" nudge ──

// Manually saved articles often have no read time; assume a middling article
// so the total still means something
const DEFAULT_MINUTES = 5;

function totalMinutes(items: ReadingListItem[]): number {
  return items.reduce((sum, i) => sum + (parseInt(i.readTime, 10) || DEFAULT_MINUTES), 0);
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hours} ${m} min` : hours;
}

// Same nudge all day, a different one tomorrow - so it doesn't read like a
// static label but also doesn't reshuffle under you mid-session
const NUDGES: ((d: React.ReactNode, n: number) => React.ReactNode)[] = [
  d => <>You have about {d} of reading saved up - good time to start one.</>,
  (d, n) => <>{d} across {n} saved article{n === 1 ? '' : 's'}. Pick one off the pile?</>,
  d => <>That's roughly {d} of articles waiting on you.</>,
  d => <>About {d} of saved reading. Now's as good a time as any.</>,
  (d, n) => <>{n} article{n === 1 ? '' : 's'} queued up, near enough {d}. Fancy a read?</>,
  d => <>Your reading list is holding about {d}. Maybe clear one out.</>,
];

function nudgeForToday(duration: React.ReactNode, count: number): React.ReactNode {
  const day = Math.floor(Date.now() / 86_400_000);
  return NUDGES[day % NUDGES.length](duration, count);
}

function ClockIcon() {
  return (
    <svg className={styles.timeIcon} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5"/>
      <path d="M7 4v3.2l2 1.3"/>
    </svg>
  );
}

// A card that has left the list - deleted, or filed into the Library - but is
// still drawn in its old spot, greyed out, until the page is reloaded. Both
// actions commit straight away; this is only a placeholder, so that removing one
// article doesn't shuffle every card below it under a cursor that's already
// moving toward the next one. See the ghost handling in ReadingList below.
type GhostKind = 'deleted' | 'shelved';

interface Ghost {
  /** The item as it was when it left the list, for the placeholder and Undo. */
  item: ReadingListItem;
  kind: GhostKind;
  /** Which shelf it was filed onto, for 'shelved'. Null is Unsorted. */
  folderId?: string | null;
}

// Picking a shelf, before anything has been committed. Mounted only while the
// picker is open, so its draft resets every time rather than remembering a
// choice you backed out of.
function ShelfPicker({ folders, initial, onCancel, onSave }: {
  folders: ReadingFolder[];
  initial: string | null;
  onCancel: () => void;
  onSave: (folderId: string | null) => void;
}) {
  const [shelf, setShelf] = useState(initial ?? '');
  return (
    <div className={`${styles.ghostOverlay} ${styles.filingOverlay}`}>
      <div className={styles.ghostPill}>
        <span className={styles.ghostFolderIcon} aria-hidden><FolderIcon size={13} /></span>
        <select
          className={styles.ghostSelect}
          aria-label="Folder to save into"
          value={shelf}
          autoFocus
          onChange={e => setShelf(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
        >
          <option value="">Unsorted</option>
          {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button className={styles.undoBtn} onClick={onCancel}>Cancel</button>
        <button className={styles.confirmBtn} onClick={() => onSave(shelf || null)}>Save</button>
      </div>
    </div>
  );
}

interface Props {
  items: ReadingListItem[];
  onSave: (item: Omit<ReadingListItem, 'id' | 'savedAt' | 'inLibrary' | 'folderId' | 'notes'>) => Promise<unknown>;
  onUpdate: (id: string, patch: Partial<Pick<ReadingListItem, 'title' | 'tag' | 'notes'>>) => Promise<void>;
  onDelete: (id: string) => void;
  /** Undo of onDelete. The row is already gone, so this re-creates it. */
  onRestore?: (item: ReadingListItem) => Promise<unknown>;
  onAddToLibrary: (id: string, inLibrary: boolean) => Promise<void>;
  /** Library shelves, for filing a just-shelved article without leaving here. */
  readingFolders?: ReadingFolder[];
  onMoveToFolder?: (id: string, folderId: string | null) => void;
  /** Open the Library (the profile tab). Without it the count renders inert. */
  onOpenLibrary?: () => void;
  articleOpenMode?: 'new-tab' | 'same-tab' | 'iframe';
  onOpenArticle?: (url: string) => void;
  layout?: ReadingListLayout;
  onLayoutChange?: (layout: ReadingListLayout) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  commentPrefs: CommentPrefs;
  onViewProfile?: (username: string) => void;
  /** Tags worth flagging, as the user typed them. See utils/favoriteTags. */
  favoriteTags?: string[];
  /** Star/unstar one tag, from a tag chip. */
  onToggleFavoriteTag?: (tag: string) => void;
  /** Replace the whole list, from the manager behind the Favorites chip. */
  onSetFavoriteTags?: (tags: string[]) => void;
}

function parseTags(tag: string): string[] {
  return tag.split(',').map(t => t.trim()).filter(Boolean);
}

// A folder, because that is what the Library is made of - shelves you file into.
// It was a books-on-a-shelf glyph, which said "library" but not "and then you
// choose where it goes", which is the part of the action people missed.
function FolderIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.25 3.1c0-.47.38-.85.85-.85h2.06c.28 0 .54.13.7.36l.53.73h4.56c.47 0 .85.38.85.85v4.7c0 .47-.38.85-.85.85H2.1a.85.85 0 0 1-.85-.85V3.1z"/>
    </svg>
  );
}

// The shelved counterpart: filled, so a card already in the Library reads as
// done at a glance rather than as another button to press.
function FolderFilledIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <path d="M1.25 3.1c0-.47.38-.85.85-.85h2.06c.28 0 .54.13.7.36l.53.73h4.56c.47 0 .85.38.85.85v4.7c0 .47-.38.85-.85.85H2.1a.85.85 0 0 1-.85-.85V3.1z"/>
    </svg>
  );
}

interface CardProps {
  item: ReadingListItem;
  variant?: MagVariant;
  /** Set when this card is a placeholder for something already gone. */
  ghost?: Ghost;
  /** True while this card's shelf picker is open. Nothing is committed yet. */
  filing?: boolean;
  onStartFiling: (id: string) => void;
  onCancelFiling: () => void;
  onConfirmFiling: (id: string, folderId: string | null) => void;
  isPostRead?: boolean;
  onPostReadAction?: (action: 'library' | 'delete') => void;
  onPostReadDismiss?: () => void;
  onOpened?: (id: string) => void;
  onDelete: (id: string) => void;
  onUndo: (id: string) => void;
  articleOpenMode?: 'new-tab' | 'same-tab' | 'iframe';
  onOpenArticle?: (url: string) => void;
  commentCount: number;
  onOpenReader: () => void;
  /** Favorites this item matched - the list did the matching. */
  favHits?: string[];
  favorites?: PreparedFavorite[];
  readingFolders?: ReadingFolder[];
}

function ReadingCard({ item, variant, ghost, filing, onStartFiling, onCancelFiling, onConfirmFiling, isPostRead, onPostReadAction, onPostReadDismiss, onOpened, onDelete, onUndo, articleOpenMode = 'new-tab', onOpenArticle, commentCount, onOpenReader, favHits, favorites = [], readingFolders = [] }: CardProps) {
  const tags = parseTags(item.tag);
  const isGhost = !!ghost;
  // Where a shelved placeholder says it went. Null (and an id whose folder has
  // since been deleted) is Unsorted, which is a real shelf, not a failure.
  const shelfName = ghost?.folderId
    ? readingFolders.find(f => f.id === ghost.folderId)?.name ?? 'Unsorted'
    : 'Unsorted';

  // Magazine text/brief variants stay type-only; everything else shows art when it exists
  const showImage = !!item.imageUrl &&
    (variant === undefined || variant === 'feature' || variant === 'standard');

  const wrapClass = [
    styles.cardWrap,
    variant === 'feature' ? styles.featureWrap : '',
    variant === 'brief' ? styles.briefWrap : '',
    item.inLibrary ? styles.libraryCard : '',
    isGhost ? styles.ghost : '',
    isPostRead && !isGhost ? styles.postReadCard : '',
    // No cover art → reserve top space so the floating controls push text down
    // instead of overlapping it
    !showImage ? styles.noHero : '',
    favHits && favHits.length > 0 ? styles.favCard : '',
  ].filter(Boolean).join(' ');

  // Unique name lets view transitions track this card across reflows
  const vtStyle = { viewTransitionName: `rl-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}` } as React.CSSProperties;

  function handleCardClick(e: React.MouseEvent) {
    if (isGhost) { e.preventDefault(); return; }
    onOpened?.(item.id);
    if (articleOpenMode === 'iframe') {
      e.preventDefault();
      onOpenArticle?.(item.url);
    }
  }

  const linkProps = articleOpenMode === 'new-tab'
    ? { target: '_blank', rel: 'noopener noreferrer' }
    : articleOpenMode === 'iframe'
      ? {}
      : {};

  return (
    <div className={wrapClass} style={vtStyle}>
      {/* Sits over the whole card but lets clicks through except on its own
          controls, so the card underneath stays legible - you can still see
          which article you just got rid of. */}
      {ghost && (
        <div className={styles.ghostOverlay}>
          <div className={styles.ghostPill}>
            {ghost.kind === 'deleted' ? (
              <span className={styles.ghostLabel}>Deleted</span>
            ) : (
              <>
                <span className={styles.ghostFolderIcon} aria-hidden><FolderFilledIcon size={13} /></span>
                {/* Naming the shelf is the confirmation - "Saved" alone leaves
                    you wondering where it went. */}
                <span className={styles.ghostLabel}>Saved to {shelfName}</span>
              </>
            )}
            <button className={styles.undoBtn} onClick={() => onUndo(item.id)}>Undo</button>
          </div>
        </div>
      )}

      {/* Nothing has been committed at this point - the card is still in the
          reading list until Save is pressed. */}
      {filing && !isGhost && (
        <ShelfPicker
          folders={readingFolders}
          initial={item.folderId}
          onCancel={onCancelFiling}
          onSave={folderId => onConfirmFiling(item.id, folderId)}
        />
      )}
      <a href={item.url} className={styles.card} onClick={handleCardClick} {...linkProps}>
        {showImage && (
          <img
            src={item.imageUrl}
            alt=""
            className={styles.hero}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        {tags.length > 0 && (
          <div className={styles.tagRow}>
            {/* Display only. The whole card is one <a>, so a button in here
                would be interactive content nested in a link - favoriting from
                the reading list lives on the filter chips above instead. */}
            {tags.map(t => {
              const starred = isFavoriteTag(t, favorites);
              return (
                <span key={t} className={`${styles.tag} ${starred ? styles.tagFav : ''}`}>
                  {starred && <StarIcon filled className={styles.tagStar} />}
                  {t}
                </span>
              );
            })}
          </div>
        )}
        <div className={styles.title}>{item.title}</div>
      </a>

      <div className={styles.cardFooter}>
        <div className={styles.meta}>
          <img
            className={styles.sourceFavicon}
            src={`https://www.google.com/s2/favicons?domain=${item.source}&sz=32`}
            alt=""
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          {item.source}{item.readTime ? ` · ${item.readTime}` : ''}
        </div>
      </div>

      {/* Outside the card's <a> - a button must not nest inside a link.
          Filing is offered here as well as up in the corner cluster: this row is
          where the hand already is once you've read the thing.
          Kept mounted on a ghost, greyed and inert via CSS: dropping it would
          shorten the card, and a placeholder that changes height defeats the
          point of leaving one behind. */}
      <div className={styles.commentRow}>
        <CommentBar count={commentCount} onClick={onOpenReader} />
        <button
          className={styles.rowFolderBtn}
          aria-label="Save to a Library folder"
          title="Save to a Library folder"
          onClick={() => onStartFiling(item.id)}
        >
          <FolderIcon size={13} />
          {/* The ellipsis is doing real work: this opens a shelf picker rather
              than filing on the spot, and it has to read differently from the
              header's "+ Save article", which adds a new URL. */}
          <span>Save to…</span>
        </button>
      </div>

      {/* Floating window-style controls - top-right, over the cover art */}
      {!isGhost && (
        <div className={styles.cardActions}>
          <button
            className={styles.actionBtn}
            aria-label="Save to a Library folder"
            title="Save to a Library folder"
            onClick={() => onStartFiling(item.id)}
          >
            <FolderIcon />
          </button>
          {/* Editing lives in the article reader now - a pencil on every card
              was a third control competing for a corner that only ever gets
              used for filing and deleting. */}
          <button
            className={`${styles.actionBtn} ${styles.deleteBtn}`}
            aria-label="Remove article"
            title="Delete"
            onClick={() => onDelete(item.id)}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11"/>
            </svg>
          </button>
        </div>
      )}

      {/* A strip across the head of the card, not a cover over it. It used to
          fill the card, which meant returning from an article blocked the very
          things you'd want next - commenting, the title link, the tags. The
          prompt drops the article's own title for the same reason: the card
          right below it is already showing that. */}
      {isPostRead && !isGhost && (
        <div className={styles.postReadOverlay}>
          <span className={styles.postReadTitle}>Done with this?</span>
          <div className={styles.postReadBtns}>
            <button className={styles.postReadArchiveBtn} onClick={() => onPostReadAction?.('library')}>
              Library
            </button>
            <button className={styles.postReadRemoveBtn} onClick={() => onPostReadAction?.('delete')}>
              Remove
            </button>
          </div>
          <button
            className={styles.postReadCloseBtn}
            aria-label="Dismiss"
            title="Dismiss"
            onClick={onPostReadDismiss}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M1 1l10 10M11 1L1 11"/>
            </svg>
          </button>
          {/* Drains left-to-right; hovering the overlay pauses it (see CSS), and
              the animation ending - not a JS timer - is what dismisses it, so the
              bar can never disagree with the countdown it's drawing. */}
          <div className={styles.postReadCountdown} onAnimationEnd={onPostReadDismiss} />
        </div>
      )}
    </div>
  );
}

export default function ReadingList({ items, onSave, onUpdate, onDelete, onRestore, onAddToLibrary, readingFolders = [], onMoveToFolder, onOpenLibrary, articleOpenMode, onOpenArticle, layout = 'cards', onLayoutChange, collapsed = false, onCollapsedChange, commentPrefs, onViewProfile, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags }: Props) {
  // Cards that have left the list but are still drawn where they were. Local
  // and deliberately not persisted: a reload is what clears them, which is also
  // the moment the list re-lays out. Keyed by the id the item had at the time.
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(new Map());

  const { counts: commentCounts, setCount: setCommentCount } = useCommentCounts(
    useMemo(() => items.map(i => i.url), [items])
  );

  // A pre-comments note has been folded into the thread - drop it from the item
  // so it can't be migrated twice
  const handleNoteMigrated = useCallback((id: string) => {
    onUpdate(id, { notes: '' }).catch(() => {});
  }, [onUpdate]);

  // The item open in the reader modal
  const [reading, setReading] = useState<ReadingListItem | null>(null);

  // Both of these commit immediately and leave a placeholder behind. Nothing
  // below the card moves, so the next click lands on what it was aimed at -
  // which is the whole reason the row is held open rather than closed up.
  function addGhost(id: string, kind: GhostKind, folderId?: string | null) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    setGhosts(prev => new Map(prev).set(id, { item, kind, folderId }));
  }

  function dropGhost(id: string) {
    setGhosts(prev => { const m = new Map(prev); m.delete(id); return m; });
  }

  function requestDelete(id: string) {
    addGhost(id, 'deleted');
    onDelete(id);
  }

  // Which card has its shelf picker open. Nothing about it is committed - the
  // article is still in the reading list until Save is pressed, which is the
  // point: filing used to happen the instant the folder icon was clicked, so
  // there was no moment that read as "saved".
  const [filingId, setFilingId] = useState<string | null>(null);

  function confirmFiling(id: string, folderId: string | null) {
    setFilingId(null);
    addGhost(id, 'shelved', folderId);
    // A folderId implies inLibrary server-side, so one call does both; without
    // one there's no shelf to move to and it just goes to the Library.
    if (folderId && onMoveToFolder) onMoveToFolder(id, folderId);
    else onAddToLibrary(id, true);
  }

  function undoGhost(id: string) {
    const ghost = ghosts.get(id);
    if (!ghost) return;
    if (ghost.kind === 'shelved') {
      // Still the same row - pulling it back out of the Library is enough, and
      // that update is optimistic, so the real card is there in the same commit.
      // The server clears folderId alongside inLibrary, so this also takes it
      // back off the shelf it was just filed onto.
      dropGhost(id);
      onAddToLibrary(id, false);
      return;
    }
    // Deleted for real, so Undo has to re-create it. The placeholder stays up
    // until that lands - dropping it first would collapse the row and then
    // reopen it, which is the shuffling this whole thing exists to avoid - and
    // stays up if it fails, so a failed Undo can be tried again rather than
    // silently losing the article.
    if (!onRestore) { dropGhost(id); return; }
    onRestore(ghost.item).then(() => dropGhost(id), () => {});
  }

  // ── Post-read overlay: when you come back from an article you opened,
  // that card offers big Library/Remove actions, then drains away ──
  const [postRead, setPostRead] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  function markOpened(id: string) {
    try { sessionStorage.setItem('rl-post-read', JSON.stringify({ id, ts: Date.now() })); } catch {}
  }

  useEffect(() => {
    function check() {
      if (document.visibilityState === 'hidden') return;
      let raw: string | null = null;
      try { raw = sessionStorage.getItem('rl-post-read'); } catch {}
      if (!raw) return;
      try { sessionStorage.removeItem('rl-post-read'); } catch {}
      try {
        const { id, ts } = JSON.parse(raw) as { id: string; ts: number };
        // Only for recent reads on articles that still exist and aren't shelved
        if (Date.now() - ts < 60 * 60 * 1000 && itemsRef.current.some(i => i.id === id && !i.inLibrary)) {
          setPostRead(id);
        }
      } catch {}
    }
    check(); // same-tab navigation returns to a fresh mount
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('article-reader-closed', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('article-reader-closed', check);
    };
  }, []);

  // Dismissal is driven by the countdown bar in the overlay itself - it runs
  // down while the overlay is ignored and pauses under the pointer, so leaving
  // the cursor on the prompt keeps it around for as long as you're reading it.
  // It goes the moment it's dismissed; no exit animation to sit through.
  const dismissPostRead = useCallback(() => setPostRead(null), []);

  function postReadAction(action: 'library' | 'delete') {
    const id = postRead;
    if (!id) return;
    setPostRead(null);
    // Opens the shelf picker rather than filing outright, so this route to the
    // Library confirms itself the same way the card's own button does.
    if (action === 'library') setFilingId(id);
    else requestDelete(id);
  }

  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [fetchedImage, setFetchedImage] = useState('');
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [editingItem, setEditingItem] = useState<ReadingListItem | null>(null);

  const active = items.filter(i => !i.inLibrary);
  // Not rendered here any more - the Library has its own home on the profile.
  // Only the count is needed, to label the link.
  const libraryCount = items.length - active.length;

  // All unique tags from active items
  const allTags = Array.from(new Set(active.flatMap(i => parseTags(i.tag))));

  // Tokenize the favorites once per change, not once per card.
  const favorites = useMemo(() => prepareFavorites(favoriteTags), [favoriteTags]);

  // Which favorites each item hits, keyed by id. Unlike the feed, the whole
  // reading list is in memory, so this covers everything - but it is still only
  // used to decorate and filter, never to reorder.
  const favHits = useMemo(() => {
    const m = new Map<string, string[]>();
    if (favorites.length === 0) return m;
    for (const i of items) {
      const hits = favoritesFor(parseTags(i.tag), favorites);
      if (hits.length > 0) m.set(i.id, hits);
    }
    return m;
  }, [items, favorites]);

  const activeFavCount = active.filter(i => favHits.has(i.id)).length;

  const matchesFilters = useCallback((i: ReadingListItem) =>
    (!activeTag || parseTags(i.tag).includes(activeTag)) &&
    (!favoritesOnly || favHits.has(i.id)),
  [activeTag, favoritesOnly, favHits]);

  const filtered = active.filter(matchesFilters);

  // What actually gets drawn: the live list with the placeholders slotted back
  // into the spots they held. Both lists are savedAt-descending already (the
  // server orders that way and a restored item keeps its original savedAt), so
  // one merge sort puts every ghost back exactly where its card used to be.
  // Ghosts are deliberately kept out of `filtered` above - a deleted article
  // shouldn't still be counted in the tag chips or the minutes-saved nudge.
  const rows = useMemo(() => {
    const live = filtered.map(item => ({ item, ghost: undefined as Ghost | undefined }));
    if (ghosts.size === 0) return live;
    // A restore re-creates the row under a new id, so a placeholder is retired
    // by its article turning up again rather than by the id coming back. Doing
    // it here rather than in the Undo handler makes the swap one render: the
    // placeholder is never on screen alongside the card that replaced it.
    const liveUrls = new Set(filtered.map(i => i.url));
    const placeheld = [...ghosts.values()]
      .filter(g => matchesFilters(g.item) && !liveUrls.has(g.item.url))
      .map(g => ({ item: g.item, ghost: g as Ghost | undefined }));
    return [...live, ...placeheld].sort(
      (a, b) => new Date(b.item.savedAt).getTime() - new Date(a.item.savedAt).getTime()
    );
  }, [filtered, ghosts, matchesFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTag && !allTags.includes(activeTag)) setActiveTag(null);
  }, [allTags, activeTag]);

  // The filter has to go when its last match does, or you're left staring at an
  // empty list with no obvious way out.
  useEffect(() => {
    if (favoritesOnly && activeFavCount === 0) setFavoritesOnly(false);
  }, [favoritesOnly, activeFavCount]);

  const savedMinutes = totalMinutes(filtered);
  const nudge = useMemo(
    () => nudgeForToday(<span className={styles.timeAmount}>{formatDuration(savedMinutes)}</span>, filtered.length),
    [savedMinutes, filtered.length]
  );

  const gridClass = layout === 'list' ? styles.gridList
    : layout === 'magazine' ? styles.gridMagazine
    : styles.grid;

  // Over `rows`, not `filtered` - a ghost still occupies its slot, so leaving it
  // out here would shift every variant below it and reshuffle the page layout,
  // which is exactly what holding the slot is meant to prevent.
  const variants = layout === 'magazine' ? magazineVariants(rows.map(r => r.item)) : null;

  // Auto-fetch page title when URL settles
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || titleEdited) return;
    const timer = setTimeout(async () => {
      setFetching(true);
      try {
        const res = await apiFetch(`/api/v1/util/page-meta?url=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (data.title && !titleEdited) setTitle(data.title);
        setFetchedImage(data.image || '');
      } catch {}
      finally { setFetching(false); }
    }, 800);
    return () => clearTimeout(timer);
  }, [url, titleEdited]);

  async function handleSave() {
    const trimUrl = url.trim();
    if (!trimUrl) return;
    const domain = parseDomain(trimUrl) || trimUrl;
    // Commit any pending tag input
    const finalTags = tagInput.trim()
      ? [...tags, tagInput.trim().toLowerCase()]
      : tags;
    setSaving(true);
    try {
      await onSave({
        url: trimUrl.startsWith('http') ? trimUrl : `https://${trimUrl}`,
        title: title.trim() || domain,
        source: domain,
        readTime: '',
        tag: finalTags.join(','),
        imageUrl: fetchedImage,
      });
      setUrl(''); setTitle(''); setTags([]); setTagInput('');
      setTitleEdited(false);
      setFetchedImage('');
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  }

  // Collapsing takes the add form down with it - a half-typed article hidden
  // behind a chevron would come back as a surprise on the next expand.
  function toggleCollapsed() {
    if (!collapsed) handleCancel();
    onCollapsedChange?.(!collapsed);
  }

  function handleCancel() {
    setExpanded(false);
    setUrl(''); setTitle(''); setTags([]); setTagInput('');
    setTitleEdited(false);
    setFetchedImage('');
  }

  return (
    <div className={styles.section}>
      <div className={styles.headerRow}>
        {onCollapsedChange ? (
          <button
            className={styles.sectionToggle}
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand reading list' : 'Collapse reading list'}
          >
            <span className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`} aria-hidden>▶</span>
            <span className={styles.sectionLabel}>Reading list</span>
            {collapsed && active.length > 0 && (
              <span className={styles.sectionCount}>{active.length}</span>
            )}
          </button>
        ) : (
          <div className={styles.sectionLabel}>Reading list</div>
        )}
        {!collapsed && (
          <div className={styles.headerActions}>
            {onLayoutChange && (
              <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Reading list layout" />
            )}
            {!expanded ? (
              <button className={styles.addBtn} onClick={() => setExpanded(true)}>+ Save article</button>
            ) : (
              <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
            )}
          </div>
        )}
      </div>

      {/* Collapsed keeps only the heading - chips, form, cards and archive all go */}
      {!collapsed && <>

      {allTags.length > 0 && (
        <div className={styles.chips}>
          <button
            className={`${styles.chip} ${activeTag === null ? styles.chipActive : ''}`}
            onClick={() => setActiveTag(null)}
          >
            All
          </button>
          {onToggleFavoriteTag && (favoriteTags.length > 0 || activeFavCount > 0) && (
            <FavoritesControl
              favorites={favoriteTags}
              onChange={onSetFavoriteTags ?? (() => {})}
              count={activeFavCount}
              filterOn={favoritesOnly}
              onToggleFilter={() => setFavoritesOnly(v => !v)}
              chipClassName={`${styles.chip} ${styles.favChip}`}
              chipActiveClassName={styles.favChipActive}
            />
          )}
          {allTags.length <= MAX_TAG_CHIPS ? (
            // Two buttons in one pill: the star favorites the tag, the label
            // filters by it. This is the reading list's favoriting surface -
            // the tags on a card can't be buttons (see ReadingCard).
            allTags.map(t => {
              const covering = onToggleFavoriteTag ? coveringFavorites(favoriteTags, t) : [];
              const starred = covering.length > 0;
              return (
                <span
                  key={t}
                  className={`${styles.chip} ${styles.tagChip} ${activeTag === t ? styles.chipActive : ''} ${starred ? styles.tagChipFav : ''}`}
                >
                  {onToggleFavoriteTag && (
                    <button
                      className={styles.tagChipStar}
                      onClick={() => onToggleFavoriteTag(t)}
                      aria-pressed={starred}
                      title={starred
                        ? (covering[0].toLowerCase() !== t.toLowerCase()
                            ? `Matched by your favorite “${covering[0]}” - click to remove it`
                            : `Remove “${t}” from favorites`)
                        : `Favorite “${t}” - articles tagged this way get flagged`}
                    >
                      <StarIcon filled={starred} />
                    </button>
                  )}
                  <button
                    className={styles.tagChipLabel}
                    onClick={() => setActiveTag(activeTag === t ? null : t)}
                  >
                    {t}
                  </button>
                </span>
              );
            })
          ) : (
            <FilterDropdown
              label="Topics"
              options={allTags}
              value={activeTag}
              onChange={setActiveTag}
              searchable
            />
          )}
        </div>
      )}

      {expanded && (
        <div className={styles.addForm}>
          <input
            className={styles.formInput}
            type="text"
            placeholder="URL (e.g. verge.com/article)"
            value={url}
            onChange={e => setUrl(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
          />
          <div className={styles.titleRow}>
            <input
              className={styles.formInput}
              type="text"
              placeholder={fetching ? 'Fetching title…' : 'Title (auto-fetched or enter manually)'}
              value={title}
              onChange={e => { setTitle(e.target.value); setTitleEdited(true); }}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
            />
            {fetching && <span className={styles.fetchingDot} />}
          </div>
          <TagChipInput
            tags={tags}
            onChange={setTags}
            inputValue={tagInput}
            onInputChange={setTagInput}
          />
          <button className={styles.saveBtn} onClick={handleSave} disabled={!url.trim() || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {filtered.length > 0 && (
        <div className={styles.timeBanner}>
          <ClockIcon />
          <span>{nudge}</span>
        </div>
      )}

      <div className={gridClass}>
        {rows.length === 0 && !expanded ? (
          <div className={styles.empty}>
            {favoritesOnly ? 'No saved articles match your favorite tags.'
              : activeTag ? `No articles tagged "${activeTag}".`
              : 'No saved articles yet.'}
          </div>
        ) : rows.map(({ item, ghost }, i) => (
          <ReadingCard
            key={item.id}
            item={item}
            variant={variants?.[i]}
            ghost={ghost}
            filing={filingId === item.id}
            onStartFiling={setFilingId}
            onCancelFiling={() => setFilingId(null)}
            onConfirmFiling={confirmFiling}
            isPostRead={postRead === item.id}
            onPostReadAction={postReadAction}
            onPostReadDismiss={dismissPostRead}
            onOpened={markOpened}
            onDelete={requestDelete}
            onUndo={undoGhost}
            articleOpenMode={articleOpenMode}
            onOpenArticle={onOpenArticle}
            commentCount={commentCounts[item.url] ?? 0}
            onOpenReader={() => setReading(item)}
            favHits={favHits.get(item.id)}
            favorites={favorites}
            readingFolders={readingFolders}
          />
        ))}
      </div>

      {/* The Library used to expand inline here. It has folders and a page of
          its own now, so this is a doorway rather than a drawer. */}
      {libraryCount > 0 && onOpenLibrary && (
        <button className={styles.libraryLink} onClick={onOpenLibrary}>
          <FolderIcon />
          <span>Library</span>
          <span className={styles.libraryCount}>{libraryCount}</span>
          <span className={styles.libraryArrow} aria-hidden="true">→</span>
        </button>
      )}

      </>}

      {editingItem && (
        <EditArticleModal
          item={editingItem}
          onSave={onUpdate}
          onClose={() => setEditingItem(null)}
        />
      )}

      {reading && (
        <ArticleDetailModal
          url={reading.url}
          title={reading.title}
          source={reading.source}
          imageUrl={reading.imageUrl}
          categories={parseTags(reading.tag)}
          readTime={reading.readTime || null}
          pubDate={reading.savedAt}
          prefs={commentPrefs}
          onCountChange={setCommentCount}
          legacyNote={reading.notes}
          onLegacyNoteMigrated={() => handleNoteMigrated(reading.id)}
          onClose={() => setReading(null)}
          onViewProfile={onViewProfile}
          actions={
            <>
              {/* Hands off to the card's own shelf picker rather than filing
                  from in here - one Save flow, one place it can be confirmed. */}
              <button onClick={() => { setReading(null); setFilingId(reading.id); }}>
                Save to Library…
              </button>
              {/* The reader is the way in to editing now that the cards have no
                  pencil. */}
              <button onClick={() => { setReading(null); setEditingItem(reading); }}>
                Edit
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
