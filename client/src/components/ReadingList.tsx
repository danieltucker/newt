import { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import styles from './ReadingList.module.css';
import { ReadingListItem, ReadingFolder, CommentPrefs } from '../types';
import { parseDomain } from '../utils/color';
import { sitePathFor, siteDomainOf } from '../utils/siteUrl';
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
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FeedFilterBar from './FeedFilterBar';
import SaveButton, { SaveDestination } from './SaveButton';
import CloseButton from './CloseButton';
import ReadingListLauncher from './ReadingListLauncher';
import { totalMinutes, formatDuration } from '../utils/readingTime';
import { loadVisited, markVisited } from '../utils/visitedArticles';

export type ReadingListLayout = 'list' | 'cards' | 'magazine';

// Past this many options a filter list grows a search box.
const SEARCHABLE_AT = 8;

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

// ── Shelves ──
// What the list is showing. The pile is the reading list proper - saved and not
// yet dealt with, and the only thing the launcher outside counts. Everything
// else is a Library shelf: `lib:` on its own is Unsorted, `lib:<id>` a folder.
//
// Encoded as one string so it can be a single piece of state and compared with
// `===`; a tagged object would have needed an equality helper everywhere the
// rail draws a selected chip.
type ShelfKey = string;

const PILE: ShelfKey = 'pile';

function libKey(folderId: string | null): ShelfKey {
  return `lib:${folderId ?? ''}`;
}

function itemsOn(items: ReadingListItem[], key: ShelfKey): ReadingListItem[] {
  if (key === PILE) return items.filter(i => !i.inLibrary);
  const folderId = key.slice(4) || null;
  return items.filter(i => i.inLibrary && (i.folderId ?? null) === folderId);
}

// ── "You have N minutes saved" nudge ──

// Same nudge all day, a different one tomorrow - so it doesn't read like a
// static label but also doesn't reshuffle under you mid-session.
//
// Every one of these names the count as well as the time. Half of them used to
// quote minutes alone, which is the harder of the two numbers to act on: "about
// 40 minutes" doesn't tell you whether that's one long read or eight short ones,
// and the pile is what you're deciding about.
const NUDGES: ((d: React.ReactNode, n: number) => React.ReactNode)[] = [
  (d, n) => <>Your reading list has {n} article{n === 1 ? '' : 's'} in it, which should be about {d}. Good time to start one.</>,
  (d, n) => <>{n} article{n === 1 ? '' : 's'} saved, roughly {d} of reading. Pick one off the pile?</>,
  (d, n) => <>That's {n} article{n === 1 ? '' : 's'} waiting on you - somewhere around {d}.</>,
  (d, n) => <>{n} article{n === 1 ? '' : 's'} on the list, near enough {d}. Now's as good a time as any.</>,
  (d, n) => <>{n} article{n === 1 ? '' : 's'} queued up, about {d} all told. Fancy a read?</>,
  (d, n) => <>Your reading list is holding {n} article{n === 1 ? '' : 's'}, near enough {d}. Maybe clear one out.</>,
];

function nudgeForToday(duration: React.ReactNode, count: number): React.ReactNode {
  const day = Math.floor(Date.now() / 86_400_000);
  return NUDGES[day % NUDGES.length](duration, count);
}

// Sits in the meta line of a card you've opened. A tick rather than an eye or a
// dot: the question a reading list answers is "have I got to this one", and a
// tick is the one glyph that says yes without also implying it's finished with.
function VisitedIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 7.4l3 3 6-6.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
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
  /** Open the Library page, where folders are made, renamed and coloured. The
   *  shelves themselves are browsable in here; managing them is not. */
  onOpenLibrary?: () => void;
  articleOpenMode?: 'new-tab' | 'same-tab' | 'iframe';
  onOpenArticle?: (url: string) => void;
  layout?: ReadingListLayout;
  onLayoutChange?: (layout: ReadingListLayout) => void;
  commentPrefs: CommentPrefs;
  onViewProfile?: (username: string) => void;
  /** Tags worth flagging, as the user typed them. See utils/favoriteTags. */
  favoriteTags?: string[];
  /** Star/unstar one tag, from a tag chip. */
  onToggleFavoriteTag?: (tag: string) => void;
  /** Replace the whole list, from the manager behind the Favorites chip. */
  onSetFavoriteTags?: (tags: string[]) => void;
  /** Make a new Library shelf and resolve to its id, from the Save menu. */
  onCreateFolder?: (name: string) => Promise<string>;
  /** Open a publisher's page (/s/<domain>) from a card's source line. Absent
   *  leaves the source as plain text, which is what it was. */
  onOpenSite?: (domain: string) => void;
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

// Where the Save button can put an article. Unsorted leads, because it is what
// pressing the label alone does - a shelf is a refinement, not a requirement,
// and demanding one was what made filing feel like paperwork.
//
// Shared by the card and the reader, which offer the same choice and must not
// drift apart about what "Save" defaults to.
function shelvesFor(folderId: string | null, folders: ReadingFolder[]): SaveDestination[] {
  return [
    { id: '', label: 'Unsorted', group: 'Saved articles', hint: folderId ? undefined : 'Default' },
    ...folders.map(f => ({
      id: f.id,
      label: f.name,
      group: 'Saved articles',
      hint: folderId === f.id ? 'Default' : undefined,
    })),
  ];
}

interface CardProps {
  item: ReadingListItem;
  variant?: MagVariant;
  /** Set when this card is a placeholder for something already gone. */
  ghost?: Ghost;
  /** True while this card's shelf picker is open. Nothing is committed yet. */
  filing?: boolean;
  onCancelFiling: () => void;
  onConfirmFiling: (id: string, folderId: string | null) => void;
  /** You've opened this one. Dims the card and prints a tick in its meta line. */
  visited?: boolean;
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
  onCreateFolder?: (name: string) => Promise<string>;
  onOpenSite?: (domain: string) => void;
}

function ReadingCard({ item, variant, ghost, filing, onCancelFiling, onConfirmFiling, visited, onOpened, onDelete, onUndo, articleOpenMode = 'new-tab', onOpenArticle, commentCount, onOpenReader, favHits, favorites = [], readingFolders = [], onCreateFolder, onOpenSite }: CardProps) {
  const tags = parseTags(item.tag);
  const isGhost = !!ghost;

  const shelves = shelvesFor(item.folderId, readingFolders);
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
    visited && !isGhost ? styles.visitedCard : '',
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
          {/* The domain comes from the URL, not from `source`: an article saved
              off a feed card carries that feed's display name ("Ars Technica")
              rather than a hostname, and the site page is keyed on the host.
              The label stays whatever the item says - the name is the useful
              part to read, the host is only how the link is built.
              Sits outside the card's <a> (see .cardFooter), so this is a link
              beside a link rather than one nested in another. */}
          {onOpenSite && siteDomainOf(item.url) ? (
            <a
              className={styles.sourceLink}
              href={sitePathFor(item.url)}
              title={`Everything from ${siteDomainOf(item.url)}`}
              onClick={e => { e.preventDefault(); onOpenSite(siteDomainOf(item.url)); }}
            >
              {item.source}
            </a>
          ) : <span>{item.source}</span>}
          {item.readTime ? <span className={styles.readTime}>· {item.readTime}</span> : null}
          {/* Last in the line, so it reads as a note about the article rather
              than part of its byline. The card is dimmed too (see .visitedCard);
              this is the part that survives being colour-blind or looking at one
              card on its own with nothing to compare it against. */}
          {visited && !isGhost && (
            <span className={styles.visitedTag} title="You've opened this one">
              <VisitedIcon />
              Visited
            </span>
          )}
        </div>
      </div>

      {/* Outside the card's <a> - a button must not nest inside a link.
          Saving lives here rather than in the corner cluster: this row is where
          the hand already is once you've read the thing, and a labelled pill is
          both easier to understand and easier to hit than a 26px icon.
          Kept mounted on a ghost, greyed and inert via CSS: dropping it would
          shorten the card, and a placeholder that changes height defeats the
          point of leaving one behind. */}
      <div className={styles.commentRow}>
        <CommentBar count={commentCount} onClick={onOpenReader} />
        {/* Pressing the label files it under Unsorted straight away; the caret
            is there for the times you know which shelf. Either way the card
            leaves a "Saved to <shelf>" placeholder with an Undo, which is what
            makes committing on one press safe. */}
        <SaveButton
          className={styles.rowSave}
          label="Save"
          icon={<FolderIcon size={13} />}
          menuLabel="Save to…"
          defaultId={item.folderId ?? ''}
          destinations={shelves}
          onSelect={id => onConfirmFiling(item.id, id || null)}
          onCreateDestination={onCreateFolder && (async name => {
            onConfirmFiling(item.id, await onCreateFolder(name));
          })}
        />
      </div>

      {/* Floating window-style controls - top-right, over the cover art.
          Only the destructive one is up here now: two icon buttons in a corner
          meant the save was both the easiest thing to miss and the easiest
          thing to hit by accident on the way to the delete. */}
      {!isGhost && (
        <div className={styles.cardActions}>
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

    </div>
  );
}

export default function ReadingList({ items, onSave, onUpdate, onDelete, onRestore, onAddToLibrary, readingFolders = [], onMoveToFolder, onOpenLibrary, articleOpenMode, onOpenArticle, layout = 'magazine', onLayoutChange, commentPrefs, onViewProfile, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags, onCreateFolder, onOpenSite }: Props) {
  // The list is a room you go into now, not a drawer under the feed. See
  // ReadingListLauncher for why.
  const [open, setOpen] = useState(false);
  const [shelfKey, setShelfKey] = useState<ShelfKey>(PILE);
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

  // ── Visited ──
  // Which of these you've actually opened. This replaced a prompt that appeared
  // over the card when you came back from an article, asking whether you were
  // done with it: it arrived at the worst moment, covered the head of the card
  // with two buttons and a countdown, and to deliver it the list had to force
  // itself open on your return. What it was reaching for - "you've been to this
  // one" - is better said quietly and permanently, which is what a browser has
  // always done with a followed link.
  //
  // Read once on mount rather than on every render: the store is synchronous
  // localStorage, and the set only changes when this component is the thing
  // that changed it. See utils/visitedArticles.
  const [visited, setVisited] = useState<Set<string>>(loadVisited);

  function markOpened(id: string) {
    const next = markVisited(id);
    // Null means it was already in the set, so there is nothing to redraw.
    if (next) setVisited(next);
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
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // The pile: what the launcher counts, and what the list opens onto. Kept
  // separate from `shelfItems` below because the launcher's numbers must not
  // move when you wander off into a folder.
  const pile = useMemo(() => items.filter(i => !i.inLibrary), [items]);
  const filedCount = items.length - pile.length;

  // How many articles sit on each shelf, for the rail. Derived from the loaded
  // items rather than a server count, so an optimistic move retunes the rail in
  // the same commit that moves the card.
  const shelfCounts = useMemo(() => {
    const m = new Map<ShelfKey, number>();
    for (const i of items) {
      const key = i.inLibrary ? libKey(i.folderId ?? null) : PILE;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // The rail, as one flat list: the pile, then the Library's shelves. Flat
  // because the rail has to decide how many of these fit on a line, and that is
  // a question about a sequence rather than about two nested groups.
  const railShelves = useMemo<Shelf[]>(() => {
    const list: Shelf[] = [{
      key: PILE,
      label: 'Reading list',
      count: shelfCounts.get(PILE) ?? 0,
      color: 'var(--accent)',
    }];
    if (filedCount === 0 && readingFolders.length === 0) return list;
    list.push({
      key: libKey(null),
      label: 'Unsorted',
      count: shelfCounts.get(libKey(null)) ?? 0,
      color: 'var(--muted)',
      hollow: true,
    });
    for (const f of readingFolders) {
      list.push({
        key: libKey(f.id),
        label: f.name,
        count: shelfCounts.get(libKey(f.id)) ?? 0,
        color: f.color,
      });
    }
    return list;
  }, [shelfCounts, filedCount, readingFolders]);

  // A folder can be deleted from the Library page while its shelf is the one on
  // screen, which would leave the rail with nothing selected and the grid empty
  // for no stated reason. Fall back to the pile.
  useEffect(() => {
    if (shelfKey === PILE || shelfKey === libKey(null)) return;
    const id = shelfKey.slice(4);
    if (!readingFolders.some(f => f.id === id)) setShelfKey(PILE);
  }, [shelfKey, readingFolders]);

  const shelfItems = useMemo(() => itemsOn(items, shelfKey), [items, shelfKey]);

  // All unique tags on the shelf being shown
  const allTags = useMemo(
    () => Array.from(new Set(shelfItems.flatMap(i => parseTags(i.tag)))).sort(),
    [shelfItems],
  );

  // Where the saved articles came from. Same filter the feed offers, over the
  // same kind of value - a reading list of forty things is as worth narrowing
  // by publication as the feed is.
  const allSources = useMemo(
    () => Array.from(new Set(shelfItems.map(i => i.source.trim()).filter(Boolean))).sort(),
    [shelfItems],
  );

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

  const activeFavCount = shelfItems.filter(i => favHits.has(i.id)).length;

  const matchesFilters = useCallback((i: ReadingListItem) =>
    (!activeTag || parseTags(i.tag).includes(activeTag)) &&
    (!activeSource || i.source.trim() === activeSource) &&
    (!favoritesOnly || favHits.has(i.id)),
  [activeTag, activeSource, favoritesOnly, favHits]);

  const filtered = shelfItems.filter(matchesFilters);

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
      // The snapshot is the item as it was when it left, so it holds a slot on
      // the shelf it left from - not on the one it was filed onto, where it is
      // about to turn up as a real card.
      .filter(g => itemsOn([g.item], shelfKey).length > 0
        && matchesFilters(g.item) && !liveUrls.has(g.item.url))
      .map(g => ({ item: g.item, ghost: g as Ghost | undefined }));
    return [...live, ...placeheld].sort(
      (a, b) => new Date(b.item.savedAt).getTime() - new Date(a.item.savedAt).getTime()
    );
  }, [filtered, ghosts, matchesFilters, shelfKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A filter has to go when its last match does, or you're left staring at an
  // empty list with no obvious way out.
  useEffect(() => {
    if (activeTag && !allTags.includes(activeTag)) setActiveTag(null);
  }, [allTags, activeTag]);

  useEffect(() => {
    if (activeSource && !allSources.includes(activeSource)) setActiveSource(null);
  }, [allSources, activeSource]);

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

  // The launcher's numbers. Unfiltered and pile-only on purpose: it stands
  // outside the list and has to say the same thing whatever you last narrowed
  // the view to, or the count on the door disagrees with the room.
  const pileMinutes = useMemo(() => totalMinutes(pile), [pile]);

  // The newest few, for the launcher's cover stack. `pile` is already
  // savedAt-descending (the server orders that way), so the top of it is the
  // top of the stack.
  const pilePreview = useMemo(
    () => pile.slice(0, 4).map(i => ({ id: i.id, title: i.title, url: i.url, imageUrl: i.imageUrl })),
    [pile],
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

  // Closing takes the add form down with it - a half-typed article hidden
  // behind a shut modal would come back as a surprise on the next open.
  const close = useCallback(() => {
    setOpen(false);
    setExpanded(false);
    setUrl(''); setTitle(''); setTags([]); setTagInput('');
    setTitleEdited(false);
    setFetchedImage('');
  }, []);

  // Escape closes, and the page behind must not scroll while the list is up -
  // the same bargain every other full overlay in the app makes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  function handleCancel() {
    setExpanded(false);
    setUrl(''); setTitle(''); setTags([]); setTagInput('');
    setTitleEdited(false);
    setFetchedImage('');
  }

  const shelfLabel = shelfKey === PILE
    ? 'Reading list'
    : shelfKey === libKey(null)
      ? 'Unsorted'
      : readingFolders.find(f => f.id === shelfKey.slice(4))?.name ?? 'Unsorted';

  return (
    <>
      <ReadingListLauncher
        count={pile.length}
        minutes={pileMinutes}
        filedCount={filedCount}
        preview={pilePreview}
        onOpen={() => setOpen(true)}
      />

      {!open ? null : (
      /* mousedown, not click: a drag that starts on a card and ends on the
         backdrop is not a request to close. */
      <div
        className={styles.backdrop}
        onMouseDown={e => { if (e.target === e.currentTarget) close(); }}
      >
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Reading list">
      <div className={styles.modalHead}>
        <div className={styles.modalHeadText}>
          <h2 className={styles.modalTitle}>{shelfLabel}</h2>
          {/* The nudge belongs to the pile. A folder is a place you put things
              on purpose, and counting it back at you as unfinished business
              would punish the tidying. */}
          {/* The nudge is wrapped rather than dropped straight in: this row is a
              flex container with a gap, and a bare fragment would make every
              text run and every <span> in it a flex item with 8px between them,
              which spaces the sentence out mid-word. */}
          {shelfKey === PILE && filtered.length > 0 && (
            <p className={styles.modalNudge}><ClockIcon /><span>{nudge}</span></p>
          )}
        </div>
        <CloseButton onClick={close} label="Close reading list" />
      </div>

      {/* ── The shelves ──
          The pile first, then everything filed. This is the half of the ask a
          collapsible section could never carry: what you kept and where you put
          it, in one place, rather than a list here and folders on the profile.
          Browsing them happens here; making, renaming and colouring them stays
          on the Library page, which is already built for it. */}
      <ShelfRail
        shelves={railShelves}
        active={shelfKey}
        onSelect={setShelfKey}
        onManage={onOpenLibrary && (() => { close(); onOpenLibrary(); })}
      />

      {/* One control strip: what you're narrowing to on the left, how it's drawn
          and how to add to it on the right. The filters used to sit inside the
          scrolling body, which meant they left the screen as soon as you started
          reading and there was no way back to them but scrolling up. */}
      <div className={styles.modalToolbar}>
        {/* Same control the feed uses, for the same reason: a row of every tag in
            the list was the loudest thing on screen and put the filters in a
            different shape on each surface. Topics keep their stars here - the
            tags printed on a card aren't buttons (see ReadingCard), so this is
            still the reading list's favoriting surface. */}
        <div className={styles.toolbarFilters}>
          {(allTags.length > 0 || allSources.length > 1) && (
            <FeedFilterBar
          className={styles.toolbarFilterBar}
          groups={[
            {
              id: 'topic',
              label: 'Topic',
              allLabel: 'All topics',
              value: activeTag,
              onChange: setActiveTag,
              searchable: allTags.length > SEARCHABLE_AT,
              onToggleStar: onToggleFavoriteTag,
              options: allTags.map(t => {
                const covering = onToggleFavoriteTag ? coveringFavorites(favoriteTags, t) : [];
                const starred = covering.length > 0;
                return {
                  value: t,
                  label: t,
                  starred,
                  starTitle: starred
                    ? (covering[0].toLowerCase() !== t.toLowerCase()
                        ? `Matched by your favorite “${covering[0]}” - click to remove it`
                        : `Remove “${t}” from favorites`)
                    : `Favorite “${t}” - articles tagged this way get flagged`,
                };
              }),
            },
            {
              id: 'site',
              label: 'Site',
              allLabel: 'All sites',
              value: activeSource,
              onChange: setActiveSource,
              searchable: allSources.length > SEARCHABLE_AT,
              options: allSources.map(s => ({ value: s, label: s })),
            },
          ]}
          favorites={onToggleFavoriteTag && (favoriteTags.length > 0 || activeFavCount > 0) ? (
            <FavoritesControl
              favorites={favoriteTags}
              onChange={onSetFavoriteTags ?? (() => {})}
              count={activeFavCount}
              filterOn={favoritesOnly}
              onToggleFilter={() => setFavoritesOnly(v => !v)}
              chipClassName={`${styles.chip} ${styles.favChip}`}
              chipActiveClassName={styles.favChipActive}
            />
          ) : undefined}
            />
          )}
        </div>

        {onLayoutChange && (
          <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Reading list layout" />
        )}
        {/* "Add", not "+ Save article": every other Save in here files an
            article you already have onto a shelf, and this one is the only
            control on the surface that brings a new article in. Shaped like the
            chips and the layout switch it shares the row with, because it is
            another control in that row and was reading as a stray link. */}
        {!expanded ? (
          <button className={styles.addBtn} onClick={() => setExpanded(true)} title="Add an article by URL">
            <PlusIcon />
            Add
          </button>
        ) : (
          <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
        )}
      </div>

      <div className={styles.modalBody}>

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
          {/* The button that opens this form says Add, so the one that commits
              it does too - and a Save down here would be the third meaning the
              word carries on this screen. */}
          <button className={styles.saveBtn} onClick={handleSave} disabled={!url.trim() || saving}>
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      <div className={gridClass}>
        {rows.length === 0 && !expanded ? (
          <div className={styles.empty}>
            {favoritesOnly ? 'No saved articles match your favorite tags.'
              : activeTag ? `No articles tagged "${activeTag}".`
              : shelfKey === PILE ? 'Nothing on the pile. Save an article from your feed and it lands here.'
              : shelfKey === libKey(null) ? 'Nothing unsorted. Articles you keep land here until you file them.'
              : `Nothing in ${shelfLabel} yet. File an article here from any Save button.`}
          </div>
        ) : rows.map(({ item, ghost }, i) => (
          <ReadingCard
            key={item.id}
            item={item}
            variant={variants?.[i]}
            ghost={ghost}
            filing={filingId === item.id}
            onCancelFiling={() => setFilingId(null)}
            onConfirmFiling={confirmFiling}
            visited={visited.has(item.id)}
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
            onCreateFolder={onCreateFolder}
            onOpenSite={onOpenSite}
          />
        ))}
      </div>

      {/* closes .modalBody, .modal, .backdrop */}
      </div>
      </div>
      </div>
      )}

      {/* Outside the modal, and last in the tree so it paints over it: the
          reader is opened from a card in there and has to sit on top of the
          thing that raised it. */}
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
            /* The same control the card carries, so filing works identically
               whether you decided before opening the article or after reading
               it. Closing the reader is the point: the list behind it is where
               the "Saved to <shelf>" placeholder and its Undo appear. */
            <SaveButton
              label="Save"
              icon={<FolderIcon size={13} />}
              menuLabel="Save to…"
              defaultId={reading.folderId ?? ''}
              currentId={reading.inLibrary ? (reading.folderId ?? '') : undefined}
              destinations={shelvesFor(reading.folderId, readingFolders)}
              onSelect={id => { setReading(null); confirmFiling(reading.id, id || null); }}
              onCreateDestination={onCreateFolder && (async name => {
                const folderId = await onCreateFolder(name);
                setReading(null);
                confirmFiling(reading.id, folderId);
              })}
            />
          }
        />
      )}
    </>
  );
}

// A dot in the folder's own colour, its name, and how much is on it - the same
// three things the Library page's rail shows, because they are the same shelves
// and recognising them by colour only works if the colour follows them here.
interface Shelf {
  key: ShelfKey;
  label: string;
  count: number;
  color: string;
  /** Unsorted has no colour of its own - an outline says "no folder". */
  hollow?: boolean;
}

const ShelfChevron = () => (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 4.5L6 8l3.5-3.5" />
  </svg>
);

// Shared by the chips, the overflow trigger and the hidden copy the rail
// measures itself against - three things that have to come out exactly the same
// width for the measuring to mean anything.
function ShelfBody({ shelf }: { shelf: Shelf }) {
  return (
    <>
      <span
        className={`${styles.shelfDot} ${shelf.hollow ? styles.shelfDotHollow : ''}`}
        style={shelf.hollow ? undefined : { background: shelf.color }}
      />
      <span className={styles.shelfName}>{shelf.label}</span>
      <span className={styles.shelfCount}>{shelf.count}</span>
    </>
  );
}

// One shelf in the rail.
function ShelfChip({ shelf, active, onClick }: {
  shelf: Shelf;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.shelfChip} ${active ? styles.shelfChipActive : ''}`}
      style={{ '--shelf': shelf.color } as React.CSSProperties}
      aria-pressed={active}
      onClick={onClick}
    >
      <ShelfBody shelf={shelf} />
    </button>
  );
}

/**
 * The row of shelves, and what to do when there are more of them than there is
 * room for.
 *
 * It used to scroll sideways. That is fine under a thumb and close to invisible
 * under a mouse: no scrollbar, no arrows, no shadow at the edge - nothing at all
 * saying the row carried on past the last chip you could see, so a folder off
 * the end of it was a folder you didn't have. Nothing in here scrolls now. The
 * rail measures what it can show and folds the rest into a "N more" menu at the
 * end, which is the shelf you're on when the shelf you're on is one of them.
 */
function ShelfRail({ shelves, active, onSelect, onManage }: {
  shelves: Shelf[];
  active: ShelfKey;
  onSelect: (key: ShelfKey) => void;
  /** Absent leaves the Library link off the rail entirely. */
  onManage?: () => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // How many chips are on the rail. Everything past this is in the menu.
  const [fit, setFit] = useState(shelves.length);
  const [open, setOpen] = useState(false);

  const activeShelf = shelves.find(s => s.key === active) ?? shelves[0];

  // Widths come off a hidden copy of the whole rail rather than the visible one:
  // a chip that has been folded into the menu is no longer in the DOM to be
  // measured, so measuring what's on screen would mean each pass depending on
  // the last one's answer, which is how these things end up oscillating.
  const sig = JSON.stringify(shelves.map(s => [s.key, s.label, s.count]));

  const measure = useCallback(() => {
    const rail = railRef.current;
    const mirror = mirrorRef.current;
    if (!rail || !mirror) return;
    const chips = Array.from(mirror.querySelectorAll<HTMLElement>('[data-chip]'));
    if (chips.length === 0) return;

    const cs = getComputedStyle(rail);
    const gap = parseFloat(cs.columnGap) || 0;
    let avail = rail.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // The Library link is pinned to the far end, so it is width the chips never
    // had in the first place.
    if (manageRef.current) avail -= manageRef.current.offsetWidth + gap;

    // Right edge of every chip in a rail that is showing all of them, dividers
    // and gaps included - so "does this one fit" is one comparison per chip.
    const edges = chips.map(c => c.offsetLeft + c.offsetWidth);
    if (edges[edges.length - 1] <= avail) { setFit(chips.length); return; }

    // Both labels the trigger can carry are in the mirror and the wider one is
    // what gets reserved. Which one it actually shows depends on how many chips
    // fit, and that must not depend back on how much room it was given.
    const triggers = Array.from(mirror.querySelectorAll<HTMLElement>('[data-more]'));
    const budget = avail - Math.max(0, ...triggers.map(t => t.offsetWidth)) - gap;

    let n = 0;
    while (n < edges.length && edges[n] <= budget) n++;
    // The pile stays on the rail whatever happens: it is the shelf the list
    // opens onto, and a rail with nothing on it but a menu says nothing at all.
    setFit(Math.max(1, n));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    measure();
    const rail = railRef.current;
    const mirror = mirrorRef.current;
    if (typeof ResizeObserver === 'undefined' || !rail || !mirror) return;
    // The rail for the room it has; the mirror for what wants to go in it - a
    // renamed folder or a font arriving late changes the second, not the first.
    const ro = new ResizeObserver(() => measure());
    ro.observe(rail);
    ro.observe(mirror);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    // Captured, and the event stops here: the reading list closes on Escape from
    // a listener of its own, and dismissing a menu should not also shut the room
    // it was opened in.
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const shown = shelves.slice(0, fit);
  const hidden = shelves.slice(fit);
  // The menu is where the current shelf went, so the trigger wears its name and
  // its colour rather than a count - the rail still has to say where you are.
  const activeHidden = hidden.find(s => s.key === active) ?? null;

  // The pile and the Library's shelves are different kinds of thing, so there is
  // a hairline between them wherever the second one starts.
  const divider = <span className={styles.railDivider} aria-hidden />;

  return (
    <div className={styles.shelfRail} ref={railRef} role="group" aria-label="Shelves">
      {shown.map((s, i) => (
        <Fragment key={s.key}>
          {i === 1 && divider}
          <ShelfChip shelf={s} active={s.key === active} onClick={() => onSelect(s.key)} />
        </Fragment>
      ))}

      {hidden.length > 0 && (
        <div className={styles.moreWrap} ref={menuRef}>
          <button
            type="button"
            className={`${styles.shelfChip} ${styles.moreChip} ${activeHidden ? styles.shelfChipActive : ''}`}
            style={{ '--shelf': activeHidden?.color ?? 'var(--muted)' } as React.CSSProperties}
            aria-haspopup="menu"
            aria-expanded={open}
            title={`${hidden.length} more shelf${hidden.length === 1 ? '' : 'ves'}`}
            onClick={() => setOpen(v => !v)}
          >
            {activeHidden
              ? <ShelfBody shelf={activeHidden} />
              : <span className={styles.shelfName}>{hidden.length} more</span>}
            <ShelfChevron />
          </button>

          {open && (
            <div className={styles.moreMenu} role="menu">
              {hidden.map(s => (
                <button
                  key={s.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s.key === active}
                  className={`${styles.moreRow} ${s.key === active ? styles.moreRowActive : ''}`}
                  style={{ '--shelf': s.color } as React.CSSProperties}
                  onClick={() => { onSelect(s.key); setOpen(false); }}
                >
                  <span
                    className={`${styles.shelfDot} ${s.hollow ? styles.shelfDotHollow : ''}`}
                    style={s.hollow ? undefined : { background: s.color }}
                  />
                  <span className={styles.moreName}>{s.label}</span>
                  <span className={styles.shelfCount}>{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {onManage && (
        <button ref={manageRef} className={styles.manageLink} onClick={onManage}>
          Manage folders <span aria-hidden>→</span>
        </button>
      )}

      {/* The measuring copy: every chip at its natural width, plus both labels
          the trigger can carry. Out of the layout, out of the tab order and out
          of the accessibility tree - it exists to be read with offsetWidth. */}
      <div className={styles.railMirror} ref={mirrorRef} aria-hidden>
        {shelves.map((s, i) => (
          <Fragment key={s.key}>
            {i === 1 && divider}
            <span data-chip className={styles.shelfChip}><ShelfBody shelf={s} /></span>
          </Fragment>
        ))}
        <span data-more className={`${styles.shelfChip} ${styles.moreChip}`}>
          <span className={styles.shelfName}>{shelves.length} more</span>
          <ShelfChevron />
        </span>
        {activeShelf && (
          <span data-more className={`${styles.shelfChip} ${styles.moreChip}`}>
            <ShelfBody shelf={activeShelf} />
            <ShelfChevron />
          </span>
        )}
      </div>
    </div>
  );
}
