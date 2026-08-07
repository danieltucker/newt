import { useState, useRef, useMemo, useEffect } from 'react';
import { FeedSubscription, FeedFolder, ImportableFeed, SuggestedFeed } from '../types';
import { feedLabel, feedHost } from '../utils/feedLabel';
import { parseYouTubeSubscriptions, isYouTubeAddress, YouTubeChannel } from '../utils/youtubeSubscriptions';
import { accessBadge } from '../utils/feedAccess';
import { apiErrorText } from '../services/api';
import styles from './FeedManagerModal.module.css';

const PALETTE = [
  '#5E6AD2', '#FF4500', '#EA4C89', '#1DB954', '#F48024', '#A259FF',
  '#E0479E', '#00A8E8', '#FF6600', '#24A0ED', '#7C5CFC', '#0FB57B',
];

// Null is Uncategorised, which is a real place - so it needs a stable key that
// can't collide with a category id.
const UNCATEGORIZED = '__none__';

// Not a destination but a verb, parked in the same list. See CategorySelect.
const NEW_CATEGORY = '__new__';

// Imported YouTube channels are filed here by name; the server creates the
// category on demand (see the `category` handling in POST /feeds/batch). A
// hundred channels landing in Uncategorised would bury whatever was already
// there, and "everything I watch" is a category by any reading.
const YOUTUBE_CATEGORY = 'YouTube';

// A subscription export is a few hundred rows of two short columns. Anything
// this size that claims to be one isn't, and there is no reason to read it
// into memory to find that out.
const MAX_CSV_BYTES = 2_000_000;

interface Props {
  subscriptions: FeedSubscription[];
  folders: FeedFolder[];
  importable: ImportableFeed[];
  suggested: SuggestedFeed[];
  onAddFeed: (url: string, opts?: { name?: string; feedFolderId?: string | null; skipValidation?: boolean }) => Promise<FeedSubscription>;
  onAddFeeds: (feeds: Array<{ url: string; name?: string; category?: string; feedFolderId?: string | null }>) => Promise<{ added: FeedSubscription[]; skipped: { url: string; reason: string }[] }>;
  onUpdateFeed: (id: string, updates: { name?: string; url?: string; feedFolderId?: string | null }) => Promise<unknown>;
  onRemoveFeed: (id: string) => Promise<void>;
  onCreateFolder: (name: string, color?: string) => Promise<FeedFolder>;
  onUpdateFolder: (id: string, updates: { name?: string; color?: string }) => Promise<void>;
  onRemoveFolder: (id: string) => Promise<void>;
  onRefreshImportable: () => void;
  onClose: () => void;
}

const XIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M1 1l10 10M11 1L1 11" />
  </svg>
);

const PencilIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * Picks a category, and makes one when the right category doesn't exist yet.
 *
 * Creating a category used to be a field pinned to the bottom of the Following
 * tab, below every subscription you had - so filing a feed somewhere new meant
 * scrolling past the whole list, naming the category, scrolling back up, and
 * picking it from a menu you had just been standing next to. The moment you want
 * a new category is the moment you are looking at this list and not finding it,
 * so that is where making one belongs.
 *
 * It cannot be an ordinary menu item: a native <select> holds strings, not text
 * fields. So the option is a verb that swaps the menu for a name field, and the
 * category it creates is selected on the way back - the choice you were making
 * when you went looking for it.
 */
function CategorySelect({ value, onChange, folders, onCreateFolder, className, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  folders: FeedFolder[];
  onCreateFolder: Props['onCreateFolder'];
  className: string;
  ariaLabel: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (naming) nameRef.current?.focus(); }, [naming]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const folder = await onCreateFolder(trimmed);
      // The whole point: what you just made is what you were choosing.
      onChange(folder.id);
      setNaming(false);
      setName('');
    } catch (e) {
      setError(apiErrorText(e, "Couldn't create that category"));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setNaming(false);
    setName('');
    setError('');
  }

  if (naming) {
    return (
      <div className={styles.categoryCreate}>
        <input
          ref={nameRef}
          className={styles.categoryNameInput}
          value={name}
          placeholder="Category name — Tech, Local news, Auto…"
          aria-label="New category name"
          onChange={e => { setName(e.target.value); setError(''); }}
          onKeyDown={e => {
            // This sits inside the add-feed <form>; without preventDefault,
            // Enter submits it and adds the feed instead of the category.
            if (e.key === 'Enter') { e.preventDefault(); create(); }
            // Escape backs out of naming, not out of the whole modal - the
            // modal's own handler is on `document`, so this has to stop the
            // event reaching it.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
          }}
        />
        {/* type="button" on both: inside a form, a bare <button> submits. */}
        <button type="button" className={styles.ghostBtn} onClick={create} disabled={busy || !name.trim()}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className={styles.linkBtn} onClick={cancel} disabled={busy}>
          Cancel
        </button>
        {error && <div className={styles.categoryCreateError}>{error}</div>}
      </div>
    );
  }

  return (
    <select
      className={className}
      value={value}
      aria-label={ariaLabel}
      onChange={e => {
        if (e.target.value === NEW_CATEGORY) { setNaming(true); return; }
        onChange(e.target.value);
      }}
    >
      <option value={UNCATEGORIZED}>Uncategorised</option>
      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
      {/* Last, and after the real destinations, because it is the odd one out:
          everything above is a place to put this feed, and this is a thing to
          do first. */}
      <option value={NEW_CATEGORY}>+ New category…</option>
    </select>
  );
}

/** One subscription: a summary row that opens into its own editor. */
function FeedRow({ feed, folders, onUpdate, onRemove, onCreateFolder }: {
  feed: FeedSubscription;
  folders: FeedFolder[];
  onUpdate: Props['onUpdateFeed'];
  onRemove: Props['onRemoveFeed'];
  onCreateFolder: Props['onCreateFolder'];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feed.name);
  const [url, setUrl] = useState(feed.url);
  const [folderId, setFolderId] = useState(feed.feedFolderId ?? UNCATEGORIZED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function open() {
    setName(feed.name);
    setUrl(feed.url);
    setFolderId(feed.feedFolderId ?? UNCATEGORIZED);
    setError('');
    setEditing(true);
  }

  async function save() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) { setError('A feed URL is required'); return; }
    // Send only what actually changed, so an untouched field can't trip the
    // server's validation or its duplicate check.
    const updates: { url?: string; name?: string; feedFolderId?: string | null } = {};
    if (trimmedUrl !== feed.url) updates.url = trimmedUrl;
    if (name.trim() !== feed.name) updates.name = name.trim();
    const nextFolder = folderId === UNCATEGORIZED ? null : folderId;
    if (nextFolder !== (feed.feedFolderId ?? null)) updates.feedFolderId = nextFolder;
    if (Object.keys(updates).length === 0) { setEditing(false); return; }

    setBusy(true);
    setError('');
    try {
      await onUpdate(feed.id, updates);
      setEditing(false);
    } catch (e) {
      setError(apiErrorText(e, 'Could not save that change'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onRemove(feed.id);
    } catch (e) {
      setError(apiErrorText(e, 'Could not remove that feed'));
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className={styles.feedItem}>
        <span className={styles.feedLabel}>{feedLabel(feed)}</span>
        <span className={styles.feedHost}>{feedHost(feed.url)}</span>
        <button className={styles.feedEdit} onClick={open} title="Edit feed" aria-label={`Edit ${feedLabel(feed)}`}><PencilIcon /></button>
        <button className={styles.feedRemove} onClick={remove} disabled={busy} title="Unfollow" aria-label={`Unfollow ${feedLabel(feed)}`}><XIcon /></button>
      </div>
    );
  }

  return (
    <div className={styles.feedEditor}>
      <label className={styles.fieldLabel}>Name</label>
      <input
        className={styles.input}
        value={name}
        autoFocus
        placeholder={feedLabel({ name: '', url: feed.url, title: feed.title })}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      />

      <label className={styles.fieldLabel}>Feed URL</label>
      <input
        className={styles.input}
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      />

      <label className={styles.fieldLabel}>Category</label>
      <CategorySelect
        className={styles.select}
        value={folderId}
        onChange={setFolderId}
        folders={folders}
        onCreateFolder={onCreateFolder}
        ariaLabel="Category for this feed"
      />

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.editorActions}>
        <button className={styles.ghostBtn} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        <button className={styles.primaryBtn} onClick={save} disabled={busy || !url.trim()}>
          {busy ? 'Saving…' : 'Save feed'}
        </button>
      </div>
    </div>
  );
}

/** A category heading, editable in place. */
function CategoryHeader({ folder, count, onUpdate, onRemove }: {
  folder: FeedFolder;
  count: number;
  onUpdate: Props['onUpdateFolder'];
  onRemove: Props['onRemoveFolder'];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState(folder.color);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onUpdate(folder.id, { name: name.trim(), color });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className={styles.categoryEditor}>
        <input
          className={styles.input}
          value={name}
          autoFocus
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        />
        <div className={styles.colorRow}>
          {PALETTE.map(c => (
            <button
              key={c}
              className={`${styles.colorSwatch} ${c === color ? styles.colorSelected : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
        <div className={styles.editorActions}>
          <button className={styles.ghostBtn} onClick={() => setEditing(false)}>Cancel</button>
          <button className={styles.primaryBtn} onClick={save} disabled={busy || !name.trim()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.categoryHeader}>
      <span className={styles.categoryDot} style={{ background: folder.color }} aria-hidden />
      <span className={styles.categoryName}>{folder.name}</span>
      <span className={styles.categoryCount}>{count}</span>
      {confirming ? (
        <span className={styles.confirmRow}>
          {/* Says what it will and won't do: the feeds are not going anywhere. */}
          <span className={styles.confirmText}>Delete category? Its feeds move to Uncategorised.</span>
          <button className={styles.confirmYes} onClick={() => onRemove(folder.id)}>Delete</button>
          <button className={styles.confirmNo} onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      ) : (
        <>
          <button className={styles.feedEdit} onClick={() => { setName(folder.name); setColor(folder.color); setEditing(true); }} title="Rename category"><PencilIcon /></button>
          <button className={styles.feedRemove} onClick={() => setConfirming(true)} title="Delete category"><XIcon /></button>
        </>
      )}
    </div>
  );
}

type Tab = 'feeds' | 'discover';

export default function FeedManagerModal({
  subscriptions, folders, importable, suggested,
  onAddFeed, onAddFeeds, onUpdateFeed, onRemoveFeed,
  onCreateFolder, onUpdateFolder, onRemoveFolder,
  onRefreshImportable, onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>(subscriptions.length === 0 ? 'discover' : 'feeds');
  const [urlInput, setUrlInput] = useState('');
  const [targetFolder, setTargetFolder] = useState<string>(UNCATEGORIZED);
  const [checking, setChecking] = useState(false);
  const [addError, setAddError] = useState('');
  const [addOk, setAddOk] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  // Channels read out of a Takeout CSV. They live in component state rather than
  // going straight to the server: the file is a list of everything you have ever
  // subscribed to, which is not the same as a list of what you want in your
  // feed, so it lands as a pickable list like every other source in here.
  const [ytChannels, setYtChannels] = useState<YouTubeChannel[]>([]);
  const [ytError, setYtError] = useState('');
  const csvRef = useRef<HTMLInputElement>(null);

  // Whether to explain the Takeout import at all.
  //
  // It used to sit open in Discover for everyone, which is a paragraph about
  // Google Takeout in front of people who have never thought about YouTube here
  // and a permanent claim on the top of that tab. It is a specific answer to a
  // specific question, so it waits to be asked: typing a YouTube address into
  // the box above is the question.
  const [ytRevealed, setYtRevealed] = useState(false);
  const ytOffered = isYouTubeAddress(urlInput);
  const ytOpen = ytRevealed || ytChannels.length > 0;

  const subscribedYt = useMemo(
    () => new Set(subscriptions.map(s => s.url)),
    [subscriptions],
  );
  const ytNew = useMemo(
    () => ytChannels.filter(c => !subscribedYt.has(c.feedUrl)),
    [ytChannels, subscribedYt],
  );

  async function handleCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared straight away so picking the same file twice in a row still fires
    // a change event.
    e.target.value = '';
    if (!file) return;
    setYtError('');
    if (file.size > MAX_CSV_BYTES) {
      setYtError("That file is far too big to be a subscriptions export.");
      return;
    }
    try {
      const channels = parseYouTubeSubscriptions(await file.text());
      if (channels.length === 0) {
        setYtError("No channels in that file — it should be subscriptions.csv from your Takeout export.");
        setYtChannels([]);
        return;
      }
      setYtChannels(channels);
      // Pre-selected: someone who has just gone and exported their subscriptions
      // has already said what they want. Unpicking a few is less work than
      // picking ninety.
      setPicked(prev => {
        const next = new Set(prev);
        for (const c of channels) if (!subscribedYt.has(c.feedUrl)) next.add(c.feedUrl);
        return next;
      });
    } catch {
      setYtError("Couldn't read that file.");
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Grouped for display: categories in their own order, Uncategorised last
  // because it's the fallback, not the headline.
  const grouped = useMemo(() => {
    const byFolder = new Map<string, FeedSubscription[]>();
    for (const s of subscriptions) {
      const key = s.feedFolderId ?? UNCATEGORIZED;
      const list = byFolder.get(key);
      if (list) list.push(s); else byFolder.set(key, [s]);
    }
    return { byFolder, uncategorized: byFolder.get(UNCATEGORIZED) ?? [] };
  }, [subscriptions]);

  /**
   * Adds whatever is in the box. The server does the resolving - a site's home
   * page is as good an answer as its feed URL - so the only thing to do here is
   * report what it found or what it couldn't.
   */
  async function handleAdd(e?: React.FormEvent) {
    e?.preventDefault();
    const url = urlInput.trim();
    if (!url) return;
    setChecking(true);
    setAddError('');
    setAddOk('');
    try {
      const sub = await onAddFeed(url, {
        feedFolderId: targetFolder === UNCATEGORIZED ? null : targetFolder,
      });
      setAddOk(`Now following ${feedLabel(sub)}`);
      setUrlInput('');
      setTab('feeds');
      urlRef.current?.focus();
    } catch (err) {
      setAddError(apiErrorText(err, 'Could not add that feed'));
    } finally {
      setChecking(false);
    }
  }

  function togglePick(url: string) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  // Both discover lists commit through one batch call, so picking six things
  // costs one request and a single re-render rather than six of each.
  async function handleImportPicked() {
    if (picked.size === 0) return;
    setImporting(true);
    setAddError('');
    try {
      const chosen = [
        ...suggested.filter(s => picked.has(s.url)).map(s => ({
          url: s.url, name: s.name, category: s.category,
        })),
        ...importable.filter(b => picked.has(b.feedUrl)).map(b => ({
          url: b.feedUrl, name: b.name,
          feedFolderId: targetFolder === UNCATEGORIZED ? null : targetFolder,
        })),
        // Filed under YouTube by name, the same way a suggested feed carries its
        // own category - not into whatever the box at the top happens to say.
        ...ytNew.filter(c => picked.has(c.feedUrl)).map(c => ({
          url: c.feedUrl, name: c.title, category: YOUTUBE_CATEGORY,
        })),
      ];
      const { added, skipped } = await onAddFeeds(chosen);
      setPicked(new Set());
      // Folded away again once it has been used, rather than left open for the
      // rest of the session: it is a panel you summon, and leaving it standing
      // there afterwards is the thing that was wrong with it being permanent.
      setYtChannels([]);
      setYtRevealed(false);
      setYtError('');
      onRefreshImportable();
      setAddOk(
        skipped.length > 0
          ? `Added ${added.length}. Skipped ${skipped.length}.`
          : `Added ${added.length} feed${added.length === 1 ? '' : 's'}.`
      );
      if (added.length > 0) setTab('feeds');
    } catch (err) {
      setAddError(apiErrorText(err, 'Could not add those feeds'));
    } finally {
      setImporting(false);
    }
  }

  const suggestedByCategory = useMemo(() => {
    const map = new Map<string, SuggestedFeed[]>();
    for (const s of suggested) {
      const list = map.get(s.category);
      if (list) list.push(s); else map.set(s.category, [s]);
    }
    return [...map.entries()];
  }, [suggested]);

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="Manage feeds" onClick={e => e.stopPropagation()}>
        <div className={styles.head}>
          <div className={styles.title}>Manage feeds</div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>

        {/* ── Add a feed ─────────────────────────────────────── */}
        <form className={styles.addForm} onSubmit={handleAdd}>
          <input
            ref={urlRef}
            className={styles.urlInput}
            value={urlInput}
            onChange={e => { setUrlInput(e.target.value); setAddError(''); setAddOk(''); }}
            placeholder="Paste a site or feed address — npr.org, example.com/feed"
            aria-label="Site or feed address"
          />
          <CategorySelect
            className={styles.folderSelect}
            value={targetFolder}
            onChange={setTargetFolder}
            folders={folders}
            onCreateFolder={onCreateFolder}
            ariaLabel="Category for the new feed"
          />
          <button className={styles.primaryBtn} type="submit" disabled={!urlInput.trim() || checking}>
            {checking ? 'Checking…' : 'Add'}
          </button>
        </form>
        <div className={styles.addHint}>
          Give it a site and it'll find the feed. If there isn't one, it'll say so.
        </div>
        {addError && <div className={styles.error}>{addError}</div>}
        {addOk && <div className={styles.ok}><CheckIcon /> {addOk}</div>}

        {/* Offered only to someone who is plainly here about YouTube, and only
            until they take it up. Add still does the obvious thing - this is the
            other question they might have been about to ask. */}
        {ytOffered && !ytOpen && (
          <div className={styles.ytOffer}>
            <span>
              Add follows this one channel. You can also bring over everything
              you subscribe to.
            </span>
            <button
              className={styles.linkBtn}
              onClick={() => { setYtRevealed(true); setTab('discover'); }}
            >
              Import my subscriptions
            </button>
          </div>
        )}

        <div className={styles.tabs} role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'feeds'}
            className={`${styles.tab} ${tab === 'feeds' ? styles.tabActive : ''}`}
            onClick={() => setTab('feeds')}
          >
            Following <span className={styles.tabCount}>{subscriptions.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'discover'}
            className={`${styles.tab} ${tab === 'discover' ? styles.tabActive : ''}`}
            onClick={() => setTab('discover')}
          >
            Discover
            {importable.length > 0 && <span className={styles.tabCount}>{importable.length}</span>}
          </button>
        </div>

        <div className={styles.body}>
          {tab === 'feeds' ? (
            <>
              {subscriptions.length === 0 && (
                <div className={styles.empty}>
                  You're not following anything yet. Paste an address above, or take a
                  look at <button className={styles.linkBtn} onClick={() => setTab('discover')}>Discover</button>.
                </div>
              )}

              {folders.map(folder => {
                const feeds = grouped.byFolder.get(folder.id) ?? [];
                return (
                  <div key={folder.id} className={styles.group}>
                    <CategoryHeader
                      folder={folder}
                      count={feeds.length}
                      onUpdate={onUpdateFolder}
                      onRemove={onRemoveFolder}
                    />
                    {feeds.length === 0 ? (
                      <div className={styles.groupEmpty}>Nothing filed here yet.</div>
                    ) : feeds.map(f => (
                      <FeedRow key={f.id} feed={f} folders={folders} onUpdate={onUpdateFeed} onRemove={onRemoveFeed} onCreateFolder={onCreateFolder} />
                    ))}
                  </div>
                );
              })}

              {grouped.uncategorized.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.categoryHeader}>
                    <span className={styles.categoryDot} style={{ background: 'var(--text-dim, #888)' }} aria-hidden />
                    <span className={styles.categoryName}>Uncategorised</span>
                    <span className={styles.categoryCount}>{grouped.uncategorized.length}</span>
                  </div>
                  {grouped.uncategorized.map(f => (
                    <FeedRow key={f.id} feed={f} folders={folders} onUpdate={onUpdateFeed} onRemove={onRemoveFeed} onCreateFolder={onCreateFolder} />
                  ))}
                </div>
              )}

            </>

          ) : (
            <>
              {importable.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.discoverLabel}>From your bookmarks</div>
                  <div className={styles.discoverNote}>
                    These bookmarked sites publish a feed you're not following.
                  </div>
                  {importable.map(b => {
                    const on = picked.has(b.feedUrl);
                    return (
                      <button
                        key={b.feedUrl}
                        className={`${styles.pick} ${on ? styles.pickOn : ''}`}
                        onClick={() => togglePick(b.feedUrl)}
                        aria-pressed={on}
                      >
                        <span className={styles.pickCheck}>{on ? <CheckIcon /> : null}</span>
                        <span className={styles.pickMain}>
                          <span className={styles.pickName}>{b.name}</span>
                          <span className={styles.pickBlurb}>{b.domain}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* ── YouTube subscriptions ──
                  Hidden until asked for - see ytRevealed above.

                  A file, not a "Connect YouTube" button: see the note at the top
                  of utils/youtubeSubscriptions for why an OAuth grant is the
                  wrong price for a list this small. Nothing leaves the browser
                  until something is picked and Follow is pressed. */}
              {ytOpen && (
              <div className={styles.group}>
                <div className={styles.discoverLabel}>From YouTube</div>
                <div className={styles.discoverNote}>
                  Every channel you subscribe to publishes a feed. Export your
                  list from{' '}
                  <a href="https://takeout.google.com/" target="_blank" rel="noopener noreferrer">
                    Google Takeout
                  </a>{' '}
                  (deselect all → YouTube and YouTube Music → subscriptions) and
                  drop <code>subscriptions.csv</code> in here. Your Google account
                  is never involved.
                </div>

                <div className={styles.csvRow}>
                  <button className={styles.ghostBtn} onClick={() => csvRef.current?.click()}>
                    {ytChannels.length > 0 ? 'Choose a different file' : 'Choose subscriptions.csv'}
                  </button>
                  {ytChannels.length > 0 && (
                    <span className={styles.csvSummary}>
                      {ytChannels.length} channel{ytChannels.length === 1 ? '' : 's'}
                      {ytNew.length !== ytChannels.length &&
                        ` · ${ytChannels.length - ytNew.length} already followed`}
                    </span>
                  )}
                  <input
                    ref={csvRef}
                    className={styles.csvInput}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleCsv}
                    aria-label="YouTube subscriptions CSV"
                  />
                </div>

                {ytError && <div className={styles.error}>{ytError}</div>}

                {ytNew.map(c => {
                  const on = picked.has(c.feedUrl);
                  return (
                    <button
                      key={c.feedUrl}
                      className={`${styles.pick} ${on ? styles.pickOn : ''}`}
                      onClick={() => togglePick(c.feedUrl)}
                      aria-pressed={on}
                    >
                      <span className={styles.pickCheck}>{on ? <CheckIcon /> : null}</span>
                      <span className={styles.pickMain}>
                        <span className={styles.pickName}>{c.title || c.channelId}</span>
                        <span className={styles.pickBlurb}>youtube.com</span>
                      </span>
                    </button>
                  );
                })}

                {ytChannels.length > 0 && ytNew.length === 0 && (
                  <div className={styles.groupEmpty}>
                    You already follow every channel in that file.
                  </div>
                )}
              </div>
              )}

              {suggestedByCategory.map(([category, feeds]) => (
                <div key={category} className={styles.group}>
                  <div className={styles.discoverLabel}>{category}</div>
                  {feeds.map(s => {
                    const on = picked.has(s.url);
                    return (
                      <button
                        key={s.url}
                        className={`${styles.pick} ${on ? styles.pickOn : ''}`}
                        onClick={() => togglePick(s.url)}
                        aria-pressed={on}
                      >
                        <span className={styles.pickCheck}>{on ? <CheckIcon /> : null}</span>
                        <span className={styles.pickMain}>
                          <span className={styles.pickName}>
                            {s.name}
                            {accessBadge(s.access) && (
                              <span className={styles.accessBadge} title={accessBadge(s.access)!.title}>
                                {accessBadge(s.access)!.label}
                              </span>
                            )}
                          </span>
                          <span className={styles.pickBlurb}>{s.blurb}</span>
                        </span>
                        <span className={styles.pickSite}>{s.site}</span>
                      </button>
                    );
                  })}
                </div>
              ))}

              {importable.length === 0 && suggested.length === 0 && (
                <div className={styles.empty}>
                  Nothing left to suggest — you're following everything we'd have
                  recommended. Paste an address above to add more.
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.foot}>
          {tab === 'discover' && picked.size > 0 && (
            <button className={styles.primaryBtn} onClick={handleImportPicked} disabled={importing}>
              {importing ? 'Adding…' : `Follow ${picked.size} selected`}
            </button>
          )}
          <button className={styles.ghostBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
