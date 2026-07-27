import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { flushSync } from 'react-dom';
import styles from './ReadingList.module.css';
import { ReadingListItem, CommentPrefs } from '../types';
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

// Animate layout reflow (deletes/archives) so cards visibly slide to their
// new spots. View transitions are GPU-composited; falls back to an instant
// update where unsupported.
function withViewTransition(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition) doc.startViewTransition(() => { flushSync(fn); });
  else fn();
}

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

interface Props {
  items: ReadingListItem[];
  onSave: (item: Omit<ReadingListItem, 'id' | 'savedAt' | 'inLibrary' | 'folderId' | 'notes'>) => Promise<unknown>;
  onUpdate: (id: string, patch: Partial<Pick<ReadingListItem, 'title' | 'tag' | 'notes'>>) => Promise<void>;
  onDelete: (id: string) => void;
  onAddToLibrary: (id: string, inLibrary: boolean) => Promise<void>;
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

function LibraryIcon() {
  // Books on a shelf - a place things live, not a box they get buried in
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 1.75h1.75v8.5H2z"/>
      <path d="M5 1.75h1.75v8.5H5z"/>
      <path d="M8.15 2.1l1.7.45-2.1 7.9-1.7-.45z"/>
    </svg>
  );
}

function RestoreIcon() {
  // Arrow lifting out of an open tray - clearly "move back", not "shelve again"
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 7.5v2.75c0 .41.34.75.75.75h6.5c.41 0 .75-.34.75-.75V7.5"/>
      <path d="M6 7.75V1.5"/>
      <path d="M3.5 3.75L6 1.25 8.5 3.75"/>
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 1.5l2 2L3 10H1v-2L7.5 1.5z"/>
    </svg>
  );
}

interface CardProps {
  item: ReadingListItem;
  variant?: MagVariant;
  isPendingDelete?: boolean;
  isPostRead?: boolean;
  onPostReadAction?: (action: 'library' | 'delete') => void;
  onPostReadDismiss?: () => void;
  onOpened?: (id: string) => void;
  onDelete: (id: string) => void;
  onUndo: (id: string) => void;
  onAddToLibrary: (id: string, inLibrary: boolean) => void;
  onEdit: (item: ReadingListItem) => void;
  articleOpenMode?: 'new-tab' | 'same-tab' | 'iframe';
  onOpenArticle?: (url: string) => void;
  commentCount: number;
  onOpenReader: () => void;
  /** Favorites this item matched - the list did the matching. */
  favHits?: string[];
  favorites?: PreparedFavorite[];
}

function ReadingCard({ item, variant, isPendingDelete, isPostRead, onPostReadAction, onPostReadDismiss, onOpened, onDelete, onUndo, onAddToLibrary, onEdit, articleOpenMode = 'new-tab', onOpenArticle, commentCount, onOpenReader, favHits, favorites = [] }: CardProps) {
  const tags = parseTags(item.tag);

  // Magazine text/brief variants stay type-only; everything else shows art when it exists
  const showImage = !!item.imageUrl &&
    (variant === undefined || variant === 'feature' || variant === 'standard');

  const wrapClass = [
    styles.cardWrap,
    variant === 'feature' ? styles.featureWrap : '',
    variant === 'brief' ? styles.briefWrap : '',
    item.inLibrary ? styles.libraryCard : '',
    isPendingDelete ? styles.pendingDelete : '',
    isPostRead ? styles.postReadCard : '',
    // No cover art → reserve top space so the floating controls push text down
    // instead of overlapping it
    !showImage ? styles.noHero : '',
    favHits && favHits.length > 0 ? styles.favCard : '',
  ].filter(Boolean).join(' ');

  // Unique name lets view transitions track this card across reflows
  const vtStyle = { viewTransitionName: `rl-${item.id.replace(/[^a-zA-Z0-9_-]/g, '')}` } as React.CSSProperties;

  function handleCardClick(e: React.MouseEvent) {
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
      {isPendingDelete && (
        <div className={styles.ghostOverlay}>
          <div className={styles.ghostCenter}>
            <span className={styles.ghostLabel}>Deleted</span>
            <button className={styles.undoBtn} onClick={() => onUndo(item.id)}>Undo</button>
          </div>
          <div className={styles.countdownBar} />
        </div>
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

      {/* Outside the card's <a> - a button must not nest inside a link */}
      {!isPendingDelete && (
        <div className={styles.commentRow}>
          <CommentBar count={commentCount} onClick={onOpenReader} />
        </div>
      )}

      {/* Floating window-style controls - top-right, over the cover art */}
      {!isPendingDelete && (
        <div className={styles.cardActions}>
          <button
            className={styles.actionBtn}
            aria-label={item.inLibrary ? 'Restore to reading list' : 'Add to Library'}
            title={item.inLibrary ? 'Restore to reading list' : 'Add to Library'}
            onClick={() => onAddToLibrary(item.id, !item.inLibrary)}
          >
            {item.inLibrary ? <RestoreIcon /> : <LibraryIcon />}
          </button>
          <button
            className={styles.actionBtn}
            aria-label="Edit article"
            title="Edit"
            onClick={() => onEdit(item)}
          >
            <PencilIcon />
          </button>
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

      {isPostRead && !isPendingDelete && (
        <div className={styles.postReadOverlay}>
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
          <div className={styles.postReadTitle}>
            Are you done with <span className={styles.postReadItemTitle}>{item.title}</span>?
          </div>
          <div className={styles.postReadBtns}>
            <button className={styles.postReadArchiveBtn} onClick={() => onPostReadAction?.('library')}>
              Add to Library
            </button>
            <button className={styles.postReadRemoveBtn} onClick={() => onPostReadAction?.('delete')}>
              Remove
            </button>
          </div>
          {/* Drains left-to-right; hovering the overlay pauses it (see CSS), and
              the animation ending - not a JS timer - is what dismisses it, so the
              bar can never disagree with the countdown it's drawing. */}
          <div className={styles.postReadCountdown} onAnimationEnd={onPostReadDismiss} />
        </div>
      )}
    </div>
  );
}

const DELETE_DELAY = 3000;

export default function ReadingList({ items, onSave, onUpdate, onDelete, onAddToLibrary, onOpenLibrary, articleOpenMode, onOpenArticle, layout = 'cards', onLayoutChange, collapsed = false, onCollapsedChange, commentPrefs, onViewProfile, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags }: Props) {
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const timerMap = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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

  function requestDelete(id: string) {
    setPendingDeletes(prev => new Set(prev).add(id));
    timerMap.current[id] = setTimeout(() => {
      delete timerMap.current[id];
      // Animate the surviving cards sliding into the freed spot
      withViewTransition(() => {
        onDelete(id);
        setPendingDeletes(prev => { const s = new Set(prev); s.delete(id); return s; });
      });
    }, DELETE_DELAY);
  }

  function handleAddToLibrary(id: string, inLibrary: boolean) {
    withViewTransition(() => { onAddToLibrary(id, inLibrary); });
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
    if (action === 'library') handleAddToLibrary(id, true);
    else requestDelete(id);
  }

  function undoDelete(id: string) {
    clearTimeout(timerMap.current[id]);
    delete timerMap.current[id];
    setPendingDeletes(prev => { const s = new Set(prev); s.delete(id); return s; });
  }

  useEffect(() => () => { Object.values(timerMap.current).forEach(clearTimeout); }, []);

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

  const filtered = active.filter(i =>
    (!activeTag || parseTags(i.tag).includes(activeTag)) &&
    (!favoritesOnly || favHits.has(i.id))
  );

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

  const variants = layout === 'magazine' ? magazineVariants(filtered) : null;

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
        {filtered.length === 0 && !expanded ? (
          <div className={styles.empty}>
            {favoritesOnly ? 'No saved articles match your favorite tags.'
              : activeTag ? `No articles tagged "${activeTag}".`
              : 'No saved articles yet.'}
          </div>
        ) : filtered.map((item, i) => (
          <ReadingCard
            key={item.id}
            item={item}
            variant={variants?.[i]}
            isPendingDelete={pendingDeletes.has(item.id)}
            isPostRead={postRead === item.id}
            onPostReadAction={postReadAction}
            onPostReadDismiss={dismissPostRead}
            onOpened={markOpened}
            onDelete={requestDelete}
            onUndo={undoDelete}
            onAddToLibrary={handleAddToLibrary}
            onEdit={setEditingItem}
            articleOpenMode={articleOpenMode}
            onOpenArticle={onOpenArticle}
            commentCount={commentCounts[item.url] ?? 0}
            onOpenReader={() => setReading(item)}
            favHits={favHits.get(item.id)}
            favorites={favorites}
          />
        ))}
      </div>

      {/* The Library used to expand inline here. It has folders and a page of
          its own now, so this is a doorway rather than a drawer. */}
      {libraryCount > 0 && onOpenLibrary && (
        <button className={styles.libraryLink} onClick={onOpenLibrary}>
          <LibraryIcon />
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
              <button onClick={() => { handleAddToLibrary(reading.id, !reading.inLibrary); setReading(null); }}>
                {reading.inLibrary ? 'Restore' : 'Add to Library'}
              </button>
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
