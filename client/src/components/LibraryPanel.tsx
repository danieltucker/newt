import { useMemo, useState } from 'react';
import styles from './LibraryPanel.module.css';
import { ReadingListItem, ReadingFolder } from '../types';
import { useReadingFolders, SHELF_COLORS as COLORS, nextShelfColor } from '../hooks/useReadingFolders';

// Null is the Unsorted shelf, not "no selection" - see ReadingListItem.folderId.
type Shelf = string | null;

interface Props {
  items: ReadingListItem[];
  accessToken: string | null;
  /** Move an article to a shelf (null = Unsorted). */
  onMoveToFolder: (id: string, folderId: string | null) => void;
  /** Take an article back out to the active reading list. */
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  /** Articles a deleted shelf dropped into Unsorted. */
  onFoldersDeleted: (unsortedIds: string[]) => void;
  onOpenArticle?: (url: string) => void;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export default function LibraryPanel({
  items, accessToken, onMoveToFolder, onRestore, onDelete, onFoldersDeleted, onOpenArticle,
}: Props) {
  const { folders, createFolder, updateFolder, deleteFolder } = useReadingFolders(accessToken);
  const [shelf, setShelf] = useState<Shelf>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [moving, setMoving] = useState<string | null>(null);

  const library = useMemo(() => items.filter(i => i.inLibrary), [items]);

  // Counts come from the loaded items rather than the server's itemCount here:
  // this panel already holds every Library article, and deriving keeps the rail
  // in step with an optimistic move instead of lagging a request behind.
  const countFor = useMemo(() => {
    const m = new Map<Shelf, number>();
    for (const i of library) m.set(i.folderId, (m.get(i.folderId) ?? 0) + 1);
    return m;
  }, [library]);

  const shown = useMemo(
    () => library.filter(i => i.folderId === shelf),
    [library, shelf]
  );

  // Suggest the first unused hue instead of always the same one, so folders
  // made in a row don't all come out indigo and have to be recoloured by hand.
  const suggestedColor = useMemo(() => nextShelfColor(folders), [folders]);
  const pickedColor = newColor ?? suggestedColor;

  function openCreate() {
    setNewColor(null);
    setNewName('');
    setCreating(true);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const created = await createFolder(name, pickedColor);
    setNewName('');
    setNewColor(null);
    setCreating(false);
    setShelf(created.id);
  }

  async function handleDeleteFolder(f: ReadingFolder) {
    const count = countFor.get(f.id) ?? 0;
    const msg = count > 0
      ? `Delete "${f.name}"? Its ${count} article${count === 1 ? '' : 's'} will move to Unsorted.`
      : `Delete "${f.name}"?`;
    if (!window.confirm(msg)) return;
    const unsortedIds = await deleteFolder(f.id);
    onFoldersDeleted(unsortedIds);
    if (shelf === f.id) setShelf(null);
  }

  function commitRename(f: ReadingFolder) {
    const name = renameText.trim();
    if (name && name !== f.name) updateFolder(f.id, { name });
    setRenaming(null);
  }

  return (
    <div className={styles.panel}>
      {/* The tab this sits under was called "Library", which read as the name of
          a feature rather than as a place your own articles are. Saying what is
          in here, and how much of it, is the part the tab label can't carry. */}
      <div className={styles.intro}>
        <h2 className={styles.introTitle}>Saved articles</h2>
        <p className={styles.introText}>
          {library.length === 0
            ? 'Articles you keep from your reading list are filed here, in folders of your own. Only you can see them.'
            : `${library.length} article${library.length === 1 ? '' : 's'} you’ve kept from your reading list, filed into folders of your own. Only you can see them.`}
        </p>
      </div>

      {/* ── Shelf rail ── */}
      <div className={styles.rail}>
        <button
          className={`${styles.shelf} ${shelf === null ? styles.shelfActive : ''}`}
          style={{ '--shelf': 'var(--muted)' } as React.CSSProperties}
          onClick={() => setShelf(null)}
        >
          <span className={`${styles.dot} ${styles.dotHollow}`} />
          <span className={styles.shelfName}>Unsorted</span>
          <span className={styles.shelfCount}>{countFor.get(null) ?? 0}</span>
        </button>

        {folders.map(f => (
          <div key={f.id} className={styles.shelfRow}>
            {renaming === f.id ? (
              <input
                className={styles.nameInput}
                value={renameText}
                autoFocus
                onChange={e => setRenameText(e.target.value)}
                onBlur={() => commitRename(f)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(f);
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <>
                <button
                  className={`${styles.shelf} ${shelf === f.id ? styles.shelfActive : ''}`}
                  style={{ '--shelf': f.color } as React.CSSProperties}
                  onClick={() => setShelf(f.id)}
                >
                  <span className={styles.dot} style={{ background: f.color }} />
                  <span className={styles.shelfName}>{f.name}</span>
                  <span className={styles.shelfCount}>{countFor.get(f.id) ?? 0}</span>
                </button>
                {/* Rename was double-click only, which nothing announces. Both
                    controls now surface on hover of the row. */}
                <button
                  className={styles.shelfIcon}
                  aria-label={`Rename ${f.name}`}
                  title="Rename"
                  onClick={() => { setRenaming(f.id); setRenameText(f.name); }}
                >
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7.5 1.5l2 2L3 10H1v-2L7.5 1.5z" />
                  </svg>
                </button>
                {/* Archived has no delete control. It is where clearing an
                    article off the reading list puts it, and deleting a shelf
                    tips its articles into Unsorted - which would empty the
                    archive back into the Library in one press. Renaming and
                    recolouring are still the user's; the shelf itself stays.
                    The server refuses it too, so this is the polite half of
                    the rule rather than the whole of it. */}
                {!f.system && (
                  <button
                    className={`${styles.shelfIcon} ${styles.shelfDelete}`}
                    aria-label={`Delete ${f.name}`}
                    title="Delete folder"
                    onClick={() => handleDeleteFolder(f)}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="M1 1l10 10M11 1L1 11" />
                    </svg>
                  </button>
                )}
              </>
            )}
          </div>
        ))}

        {creating ? (
          <div className={styles.createBox}>
            {/* The dot previews the pick right where the folder's own dot will
                sit, so the choice is visible without reading the swatch strip */}
            <div className={styles.createTop}>
              <span className={styles.dot} style={{ background: pickedColor }} />
              <input
                className={styles.nameInput}
                placeholder="Folder name"
                value={newName}
                autoFocus
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') setCreating(false);
                }}
              />
            </div>

            <div className={styles.colorRow} role="group" aria-label="Folder colour">
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`${styles.swatch} ${c === pickedColor ? styles.swatchOn : ''}`}
                  style={{ '--swatch': c } as React.CSSProperties}
                  aria-label={c}
                  aria-pressed={c === pickedColor}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>

            <div className={styles.createBtns}>
              <button className={styles.primaryBtn} onClick={handleCreate} disabled={!newName.trim()}>
                Create
              </button>
              <button className={styles.ghostBtn} onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className={styles.addShelf} onClick={openCreate}>
            <span className={styles.addPlus} aria-hidden="true">+</span>
            New folder
          </button>
        )}
      </div>

      {/* ── Articles on the selected shelf ── */}
      <div className={styles.articles}>
        {shown.length === 0 ? (
          <div className={styles.empty}>
            {shelf === null
              ? 'Nothing unsorted. Articles you keep land here until you file them.'
              : 'This folder is empty. Move articles in from Unsorted.'}
          </div>
        ) : shown.map(item => (
          <div key={item.id} className={styles.card}>
            <button
              className={styles.cardMain}
              onClick={() => onOpenArticle?.(item.url)}
            >
              {item.imageUrl && <img className={styles.thumb} src={item.imageUrl} alt="" />}
              <div className={styles.cardText}>
                <div className={styles.cardTitle}>{item.title}</div>
                <div className={styles.cardHost}>{item.source || hostOf(item.url)}</div>
              </div>
            </button>

            <div className={styles.cardActions}>
              {/* A plain select is the whole move UI - drag-and-drop across a
                  scrolling rail is worse on touch and needs a lot more code. */}
              {moving === item.id ? (
                <select
                  className={styles.moveSelect}
                  autoFocus
                  defaultValue={item.folderId ?? ''}
                  onBlur={() => setMoving(null)}
                  onChange={e => {
                    onMoveToFolder(item.id, e.target.value || null);
                    setMoving(null);
                  }}
                >
                  <option value="">Unsorted</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              ) : (
                <button className={styles.smallBtn} onClick={() => setMoving(item.id)}>Move</button>
              )}
              <button className={styles.smallBtn} onClick={() => onRestore(item.id)}>Restore</button>
              <button className={`${styles.smallBtn} ${styles.dangerBtn}`} onClick={() => onDelete(item.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
