import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import styles from './ReadingList.module.css';
import { ReadingListItem, ReadingFolder, CommentPrefs } from '../types';
import { parseDomain } from '../utils/color';
import { sitePathFor, siteDomainOf } from '../utils/siteUrl';
import { apiFetch } from '../services/api';
import { useCommentCounts } from '../hooks/useCommentCounts';
import { useSaveCounts } from '../hooks/useSaveCounts';
import { articleEmbed } from '../utils/noteEmbed';
import { startRepost } from '../utils/composerSeed';
import { CommentBar } from './CommentsPanel';
import ArticleDetailModal from './ArticleDetailModal';
import TagChipInput from './TagChipInput';
import { StarIcon } from './TagChip';
import FavoritesControl from './FavoritesControl';
import {
  prepareFavorites, favoritesFor, isFavoriteTag, coveringFavorites, PreparedFavorite,
} from '../utils/favoriteTags';
import LayoutSwitch, { ListIcon, CardsIcon, MagazineIcon } from './LayoutSwitch';
import FeedFilterBar, { FilterOption } from './FeedFilterBar';
import SaveButton, { SaveDestination } from './SaveButton';
import CloseButton from './CloseButton';
import ReadingListLauncher from './ReadingListLauncher';
import { totalMinutes, formatDuration } from '../utils/readingTime';
import { loadVisited, markVisited } from '../utils/visitedArticles';
import { hideWithoutMovingThePage } from '../utils/scrollAnchor';

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

// A card that has left the list - archived, un-saved, or filed into the Library
// - but is still drawn in its old spot, greyed out, until the page is reloaded.
// All three commit straight away; this is only a placeholder, so that removing
// one article doesn't shuffle every card below it under a cursor that's already
// moving toward the next one. See the ghost handling in ReadingList below.
//
// 'archived' and 'deleted' look alike and are not: archiving files the article
// onto the Archived shelf and the row survives, which is what keeps its save
// count up, while un-saving really does delete it. The list's own remove
// control does the first; the second is reachable only from the Save menu.
type GhostKind = 'deleted' | 'shelved' | 'archived';

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
  /** Resolves to the saved row - which may be a copy that was already there,
   *  flagged `duplicate`, since an article is only saved to a place once. */
  onSave: (item: Omit<ReadingListItem, 'id' | 'savedAt' | 'inLibrary' | 'folderId' | 'notes' | 'duplicate'>) => Promise<ReadingListItem>;
  onUpdate: (id: string, patch: Partial<Pick<ReadingListItem, 'title' | 'tag' | 'notes'>>) => Promise<void>;
  /**
   * Un-save: deletes the row, and takes the article's save count down with it.
   * Reached from the Save menu only - the card's own remove control archives.
   */
  onDelete: (id: string) => void;
  /** Undo of onDelete. The row is already gone, so this re-creates it. */
  onRestore?: (item: ReadingListItem) => Promise<unknown>;
  /**
   * Clear an article off the list without un-saving it: the row moves onto the
   * Archived shelf. This is what the card's remove control does.
   *
   * Resolves with the shelf, which may have just been created - the Archived
   * shelf is made on first use - so the Library sidebar can learn about it.
   */
  onArchive?: (id: string) => Promise<ReadingFolder | void> | void;
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
  /** Start an Explore thread about an article. Absent when no model is connected. */
  onExplore?: (url: string, title: string) => void;
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
  /** Clear this off the list - files it onto Archived, does not delete it. */
  onArchive: (id: string) => void;
  /** Take the save back for real. Offered in the Save menu, not on the card. */
  onUnsave?: () => void;
  onUndo: (id: string) => void;
  articleOpenMode?: 'new-tab' | 'same-tab' | 'iframe';
  onOpenArticle?: (url: string) => void;
  commentCount: number;
  /** How many people have saved this article. */
  saveCount: number;
  onOpenReader: () => void;
  /** Favorites this item matched - the list did the matching. */
  favHits?: string[];
  favorites?: PreparedFavorite[];
  readingFolders?: ReadingFolder[];
  onCreateFolder?: (name: string) => Promise<string>;
  onOpenSite?: (domain: string) => void;
  /** Opens an Explore thread. Undefined when the account has no model. */
  onExplore?: (url: string, title: string) => void;
}

function ReadingCard({ item, variant, ghost, filing, onCancelFiling, onConfirmFiling, visited, onOpened, onArchive, onUnsave, onUndo, articleOpenMode = 'new-tab', onOpenArticle, commentCount, saveCount, onOpenReader, favHits, favorites = [], readingFolders = [], onCreateFolder, onOpenSite, onExplore }: CardProps) {
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
              <span className={styles.ghostLabel}>Unsaved</span>
            ) : ghost.kind === 'archived' ? (
              <>
                <span className={styles.ghostFolderIcon} aria-hidden><FolderFilledIcon size={13} /></span>
                {/* Says where it went, like the shelved placeholder does, because
                    that is the whole difference from the old Deleted: the article
                    is still saved and still somewhere you can go and get it. */}
                <span className={styles.ghostLabel}>Archived</span>
              </>
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
            onError={e => hideWithoutMovingThePage(e.currentTarget)}
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
            onError={e => hideWithoutMovingThePage(e.currentTarget)}
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
        {/* Explore and Repost hang off the comment pill's caret - the same two
            things the reader offers at the foot of the article, reachable from
            the card for the times you already know which one you want. The
            embed is built from the saved row, which is exactly the shape
            articleEmbed asks for. */}
        <CommentBar
          count={commentCount}
          onClick={onOpenReader}
          onExplore={onExplore && (() => onExplore(item.url, item.title))}
          onRepost={() => startRepost({ title: item.title, embed: articleEmbed(item) })}
          shareUrl={item.url}
        />
        {/* Pressing the label files it under Unsorted straight away; the caret
            is there for the times you know which shelf. Either way the card
            leaves a "Saved to <shelf>" placeholder with an Undo, which is what
            makes committing on one press safe. */}
        {/* `canUnsave` rather than `saved`: every card in this list is a saved
            article, but the pill still reads "Save" because pressing it files
            onto a shelf. The two states come apart here in a way they do not on
            a feed card, which is why the menu needs telling. */}
        <SaveButton
          className={styles.rowSave}
          label="Save"
          icon={<FolderIcon size={13} />}
          saveCount={saveCount}
          canUnsave={!!onUnsave}
          onUnsave={onUnsave}
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
          {/* Archives rather than deletes. The article leaves the list, keeps
              its row, and lands on the Archived shelf - so the count of how
              many people saved it does not drop because one of them finished
              reading it. Un-saving is still available, in the Save menu. */}
          <button
            className={`${styles.actionBtn} ${styles.deleteBtn}`}
            aria-label="Archive article"
            title="Archive"
            onClick={() => onArchive(item.id)}
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

export default function ReadingList({ items, onSave, onUpdate, onDelete, onRestore, onArchive, onAddToLibrary, readingFolders = [], onMoveToFolder, onOpenLibrary, articleOpenMode, onOpenArticle, layout = 'magazine', onLayoutChange, commentPrefs, onViewProfile, onExplore, favoriteTags = [], onToggleFavoriteTag, onSetFavoriteTags, onCreateFolder, onOpenSite }: Props) {
  // The list is a room you go into now, not a drawer under the feed. See
  // ReadingListLauncher for why.
  const [open, setOpen] = useState(false);
  const [shelfKey, setShelfKey] = useState<ShelfKey>(PILE);
  // Cards that have left the list but are still drawn where they were. Local
  // and deliberately not persisted: a reload is what clears them, which is also
  // the moment the list re-lays out. Keyed by the id the item had at the time.
  const [ghosts, setGhosts] = useState<Map<string, Ghost>>(new Map());

  // One list of URLs, counted two ways - see the note on the same pair in
  // FeedPanel.
  const urls = useMemo(() => items.map(i => i.url), [items]);

  const { counts: commentCounts, setCount: setCommentCount } = useCommentCounts(urls);

  // How many people have saved each article. Every card here is one the viewer
  // saved, so the number is never 0 and the badge always draws - which is the
  // point: a shelf shows which of the things you kept other people kept too.
  const { counts: saveCounts } = useSaveCounts(urls);

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

  // The card's remove control. Files the article onto Archived rather than
  // deleting it: the row is what holds the article's save count up, and having
  // finished with something is not the same as never having saved it.
  //
  // Falls back to un-saving when no archive handler was given, so a caller that
  // has not been wired up for it still gets a working control rather than a
  // dead one.
  function requestArchive(id: string) {
    if (!onArchive) { requestUnsave(id); return; }
    addGhost(id, 'archived');
    void onArchive(id);
  }

  // Un-saving, from the Save menu. Deletes for real - see the ghost note above.
  function requestUnsave(id: string) {
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
    if (ghost.kind === 'shelved' || ghost.kind === 'archived') {
      // Still the same row - pulling it back out of the Library is enough, and
      // that update is optimistic, so the real card is there in the same commit.
      // The server clears folderId alongside inLibrary, so this also takes it
      // back off the shelf it was just filed onto, Archived included: an
      // archive is a move, so undoing one is a move back.
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
  // Said when a save turned out to be one you had already made. Not an error -
  // the article is saved - so it reports where it is rather than refusing.
  const [notice, setNotice] = useState('');
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

  // Everywhere you can be *other* than the pile, as rows for the shelf group.
  // The pile itself is the group's "all" row rather than an option, because
  // that is the row the bar already draws first and already treats as the one
  // you fall back to - see allColor/allHint in FeedFilterBar.
  //
  // Empty until there is somewhere to go: with nothing filed and no folders
  // made, the only shelf is the pile, and the bar drops a group whose choices
  // amount to where you already are.
  const shelfOptions = useMemo<FilterOption[]>(() => {
    if (filedCount === 0 && readingFolders.length === 0) return [];
    return [
      // Unsorted's dot is --muted rather than a colour of its own: it is the
      // Library shelf for things you filed without saying where.
      {
        value: libKey(null),
        label: 'Unsorted',
        hint: String(shelfCounts.get(libKey(null)) ?? 0),
        color: 'var(--muted)',
      },
      ...readingFolders.map(f => ({
        value: libKey(f.id),
        label: f.name,
        hint: String(shelfCounts.get(libKey(f.id)) ?? 0),
        color: f.color,
      })),
    ];
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

  // Where a copy that was already saved is sitting, in words - so "you have
  // this already" can also say where to find it.
  function placeOf(item: ReadingListItem): string {
    if (!item.inLibrary) return 'in your reading list';
    const shelf = item.folderId ? readingFolders.find(f => f.id === item.folderId) : null;
    return shelf ? `on the “${shelf.name}” shelf` : 'in your Library';
  }

  async function handleSave() {
    const trimUrl = url.trim();
    if (!trimUrl) return;
    const domain = parseDomain(trimUrl) || trimUrl;
    // Commit any pending tag input
    const finalTags = tagInput.trim()
      ? [...tags, tagInput.trim().toLowerCase()]
      : tags;
    setSaving(true);
    setNotice('');
    try {
      const saved = await onSave({
        url: trimUrl.startsWith('http') ? trimUrl : `https://${trimUrl}`,
        title: title.trim() || domain,
        source: domain,
        readTime: '',
        tag: finalTags.join(','),
        imageUrl: fetchedImage,
      });
      // An article is only saved to a place once, so this may have found the
      // copy already there. Say so and stay open: clearing the form and closing
      // would look exactly like a save that worked, and the list would not have
      // grown to say otherwise.
      if (saved.duplicate) {
        setNotice(`You already have this one — it's ${placeOf(saved)}.`);
        return;
      }
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
    setNotice('');
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
    setNotice('');
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

      {/* ── One bar: where you are, what you're narrowing to, what you can do ──
          The shelves used to be a rail of their own above this row, which made
          three bands of chrome between the title and the first card - and on a
          phone that is most of the screen before an article appears. They are a
          group in the filter bar now, the same one the feed uses, so the whole
          surface is controlled from a single line that folds down to one chip
          and a ⋯ rather than stacking.

          Folding the rail in also deleted its whole measuring apparatus: it
          used to lay out a hidden copy of every chip to work out how many fit.
          FeedFilterBar already answers that question once, for everything in
          the row, and answers it off the bar's own width. See useElementWidth.

          A shelf is not a filter, and the bar knows it: `scope: true` keeps it
          out of the filter count and out of "Clear all filters", which must
          show you everything on this shelf rather than walking you off it. */}
      <div className={styles.modalToolbar}>
        <FeedFilterBar
          groups={[
            /* Where you are. First in the row because the two filters after it
               are built out of whatever it lands on - the topics and sites
               offered are the ones on this shelf, not in the whole list. */
            {
              id: 'shelf',
              label: 'Shelf',
              scope: true,
              allLabel: 'Reading list',
              // The pile is a shelf like the others and carries its own colour
              // and count, so its row lines up with the folders below it rather
              // than reading as "no folder".
              allColor: 'var(--accent)',
              allHint: String(shelfCounts.get(PILE) ?? 0),
              value: shelfKey === PILE ? null : shelfKey,
              onChange: v => setShelfKey(v ?? PILE),
              searchable: shelfOptions.length > SEARCHABLE_AT,
              options: shelfOptions,
            },
            /* Same control the feed uses, for the same reason: a row of every
               tag in the list was the loudest thing on screen and put the
               filters in a different shape on each surface. Topics keep their
               stars here - the tags printed on a card aren't buttons (see
               ReadingCard), so this is still the reading list's favoriting
               surface. */
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
          /* The far end of the same bar: the things that act on the list rather
             than narrow it. Fenced off by a rule and wearing a solid fill, and
             below FOLD_ACTIONS_AT they go behind one ⋯ with their words intact
             - see the `actions` note in FeedFilterBar for why the two halves
             share a row but must not be mistakable for each other. */
          actions={
            <>
              {/* "Add", not "+ Save article": every other Save in here files an
                  article you already have onto a shelf, and this one is the only
                  control on the surface that brings a new article in. Shaped
                  like the controls it shares the row with, because it is another
                  control in that row and was reading as a stray link. */}
              {!expanded ? (
                <button className={styles.addBtn} onClick={() => setExpanded(true)} title="Add an article by URL">
                  <PlusIcon />
                  Add
                </button>
              ) : (
                <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
              )}

              {/* Where the shelves come from, next to the things that act
                  rather than inside the shelf list - it leaves the reading list
                  for another page, which is not something a row in a dropdown
                  should do. Icon and a tooltip in the bar, its words back in
                  the ⋯ menu, exactly as the feed's "Manage feeds" behaves. */}
              {onOpenLibrary && (
                <button
                  className={styles.manageBtn}
                  onClick={() => { close(); onOpenLibrary(); }}
                  title="Manage folders"
                  aria-label="Manage folders"
                >
                  <FolderIcon size={13} />
                  <span className={styles.actionLabel}>Manage folders</span>
                </button>
              )}

              {onLayoutChange && (
                <LayoutSwitch value={layout} options={LAYOUT_OPTIONS} onChange={onLayoutChange} label="Reading list layout" />
              )}
            </>
          }
        />
      </div>

      <div className={styles.modalBody}>

      {expanded && (
        <div className={styles.addForm}>
          {/* A URL field, and it has to say so. As `type="text"` a phone
              treated an address like prose: it capitalised the first letter,
              autocorrected the host to the nearest English word, and offered a
              space bar instead of a slash - so what arrived was rarely what was
              pasted or typed. `type="url"` gets the URL keyboard; the three
              attributes after it turn off the corrections, which iOS applies to
              any field it is allowed to. There is no form around this, so the
              type brings no validation with it - "verge.com/article" without a
              scheme still submits (handleSave prefixes https://). */}
          <input
            className={styles.formInput}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="URL (e.g. verge.com/article)"
            value={url}
            onChange={e => { setUrl(e.target.value); setNotice(''); }}
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
          {notice && <div className={styles.formNotice} role="status">{notice}</div>}
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
            onArchive={requestArchive}
            onUnsave={() => requestUnsave(item.id)}
            onUndo={undoGhost}
            articleOpenMode={articleOpenMode}
            onOpenArticle={onOpenArticle}
            commentCount={commentCounts[item.url] ?? 0}
            saveCount={saveCounts[item.url] ?? 0}
            onOpenReader={() => setReading(item)}
            favHits={favHits.get(item.id)}
            favorites={favorites}
            readingFolders={readingFolders}
            onCreateFolder={onCreateFolder}
            onOpenSite={onOpenSite}
            onExplore={onExplore}
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
          onExplore={onExplore}
          actions={
            /* The same control the card carries, so filing works identically
               whether you decided before opening the article or after reading
               it. Closing the reader is the point: the list behind it is where
               the "Saved to <shelf>" placeholder and its Undo appear. */
            <SaveButton
              label="Save"
              icon={<FolderIcon size={13} />}
              saveCount={saveCounts[reading.url] ?? 0}
              canUnsave
              onUnsave={() => { setReading(null); requestUnsave(reading.id); }}
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
