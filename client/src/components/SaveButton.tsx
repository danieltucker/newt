import { useState, Fragment, ReactNode } from 'react';
import SplitMenuButton, { MenuHeading, MenuItem, MenuSeparator } from './SplitMenuButton';
import styles from './SaveButton.module.css';

// The one "save this article" control, shared by the feed cards and the reading
// list cards.
//
// It is a split button, because saving has a default and a choice and those
// used to be two different buttons in two different corners: a small icon that
// filed instantly, and a "Save to…" that opened a picker. Pressing the label
// saves to the obvious place; the caret is there when it isn't the place you
// wanted. Nothing about it is destructive - every surface that uses it leaves an
// Undo behind - so the default committing on one press is safe.
//
// The pill, the menu and the sheet it turns into on a phone are SplitMenuButton;
// what is left here is the part that is about saving.

export interface SaveDestination {
  /** Stable key, handed straight back to onSelect. */
  id: string;
  label: string;
  /** Heading this item files under. Consecutive items sharing one are grouped. */
  group?: string;
  /** Small right-hand note - "Default", or where the article is now. */
  hint?: string;
}

interface Props {
  /** The main segment's label. Short - it sits next to a comment pill. */
  label: string;
  /** Which destination the main segment commits to. */
  defaultId: string;
  destinations: SaveDestination[];
  onSelect: (id: string) => void;
  icon: ReactNode;
  /** Marked as current in the menu - where the article already lives. */
  currentId?: string;
  /** Heading over the menu, and the caret's accessible name. */
  menuLabel?: string;
  className?: string;
  /**
   * Offered as a last row in the menu when present: make a destination by this
   * name and save into it. Naming one is a decision about *this* article, so it
   * happens here rather than sending you off to the Library to make a folder
   * and come back.
   *
   * Create and save are one call rather than "resolve an id, then onSelect it",
   * because the new destination is by definition not in `destinations` yet -
   * this button would be selecting an id it cannot name. Rejecting leaves the
   * menu open with the typed name intact.
   */
  onCreateDestination?: (name: string) => Promise<void>;
  createLabel?: string;
  /**
   * This article is already saved. The label stops being a verb and becomes a
   * state: it reads `savedLabel`, fills its icon, and pressing it takes the
   * article back out via `onUnsave` rather than saving it again.
   *
   * The caret is unchanged either way - filing a saved article onto a shelf is
   * still a thing to want, and it is the one action the label can no longer do.
   */
  saved?: boolean;
  savedLabel?: string;
  /** The filled counterpart of `icon`. Falls back to `icon` when absent. */
  savedIcon?: ReactNode;
  onUnsave?: () => void;
  /**
   * Whether the menu offers "Unsave". Defaults to `saved`, which is the right
   * answer on a feed card: the pill's own state says whether there is a save
   * to take back.
   *
   * The reading list passes it explicitly, because there the two come apart -
   * every card in the list is a saved article, but its pill still reads "Save"
   * and files onto a shelf when pressed, so `saved` is false while unsaving is
   * very much available.
   */
  canUnsave?: boolean;
  /**
   * How many people have saved this article, shown as a badge on the pill.
   * Undefined or 0 draws nothing - see the note in SplitMenuButton.
   *
   * It is a count of people, not of copies: one reader filing the same piece
   * onto two shelves is one save. The server is what guarantees that; this only
   * shows what it returns.
   */
  saveCount?: number;
}

export default function SaveButton({
  label, defaultId, destinations, onSelect, icon, currentId,
  menuLabel = 'Save to…', className = '',
  onCreateDestination, createLabel = 'New folder…',
  saved = false, savedLabel = 'Saved', savedIcon, onUnsave, saveCount, canUnsave,
}: Props) {
  // The name being typed, or null while the row is still just a row.
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const target = destinations.find(d => d.id === defaultId) ?? destinations[0];

  // Only a caller that can undo a save gets the toggle; without onUnsave the
  // button would say "Saved" and then save it again when pressed.
  const isOn = saved && !!onUnsave;

  // Un-saving reached the menu in v1.27.0. It used to be available only by
  // pressing a pill that already read "Saved", which meant the reading list -
  // where every card is saved but the pill still says "Save" - had no way to
  // offer it at all, and clearing an article off the list was the only route
  // out. Now that clearing archives rather than deletes, taking a save back
  // needs somewhere of its own to live, and the caret's menu is where the
  // article's other placement decisions already are.
  const showUnsave = !!onUnsave && (canUnsave ?? saved);

  // Naming a folder here is not filing under "somewhere to put things later",
  // it is filing this article - so the caller does both and this just closes.
  async function createAndSave(close: () => void) {
    const name = (newName ?? '').trim();
    if (!name || !onCreateDestination || creating) return;
    setCreating(true);
    try {
      await onCreateDestination(name);
      close();
    } catch {
      // The menu stays up with the name intact, so it can be tried again
      setCreating(false);
    }
  }

  return (
    <SplitMenuButton
      className={className}
      label={isOn ? savedLabel : label}
      count={saveCount}
      countLabel={saveCount === 1 ? 'Saved by 1 person' : `Saved by ${saveCount} people`}
      icon={isOn ? (savedIcon ?? icon) : icon}
      active={isOn}
      onPrimary={() => { if (isOn) onUnsave!(); else if (target) onSelect(target.id); }}
      primaryTitle={isOn ? 'Remove from saved'
        : target ? `${menuLabel.replace(/…$/, '')} ${target.label}` : label}
      menuLabel={menuLabel}
      // A closed menu forgets a half-typed folder name. Reopening to find one
      // waiting would be a draft nobody asked to keep.
      onOpenChange={open => { if (!open) { setNewName(null); setCreating(false); } }}
      menu={close => {
        let lastGroup: string | undefined;
        return (
          <>
            {destinations.map(d => {
              const heading = d.group && d.group !== lastGroup ? d.group : null;
              lastGroup = d.group;
              return (
                <Fragment key={d.id}>
                  {heading && <MenuHeading>{heading}</MenuHeading>}
                  <MenuItem
                    label={d.label}
                    hint={d.hint}
                    current={d.id === currentId}
                    onClick={() => { close(); onSelect(d.id); }}
                  />
                </Fragment>
              );
            })}

            {onCreateDestination && (
              <>
                <MenuSeparator />
                {newName === null ? (
                  <MenuItem
                    label={createLabel}
                    icon={<span className={styles.plus}>+</span>}
                    muted
                    // Deliberately does not close: the field it opens is in the
                    // menu, and the save happens from there.
                    onClick={() => setNewName('')}
                  />
                ) : (
                  <div className={styles.newRow}>
                    <input
                      className={styles.newInput}
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      placeholder="Folder name"
                      aria-label={createLabel}
                      autoFocus
                      disabled={creating}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); void createAndSave(close); }
                        // Escape backs out of the name field first, then out of
                        // the menu - one key, one step, so it never closes more
                        // than you meant it to. Stopping the event is what
                        // leaves the second press to SplitMenuButton.
                        if (e.key === 'Escape') { e.stopPropagation(); setNewName(null); }
                      }}
                    />
                    <button
                      type="button"
                      className={styles.newGo}
                      onClick={() => void createAndSave(close)}
                      disabled={creating || !newName.trim()}
                    >
                      {creating ? '…' : 'Save'}
                    </button>
                  </div>
                )}
              </>
            )}

            {showUnsave && (
              <>
                <MenuSeparator />
                {/* Last, under a rule, and away from the list of places this
                    article could go - it is the one row here that takes the
                    article out rather than putting it somewhere. `danger` is
                    what makes it read that way.

                    It really does un-save: the row goes and the article's save
                    count comes down with it. That is the difference between
                    this and clearing a card off the reading list, which files
                    it onto Archived and leaves the count alone. */}
                <MenuItem
                  label="Unsave"
                  icon={<span className={styles.unsaveIcon} aria-hidden>×</span>}
                  danger
                  onClick={() => { close(); onUnsave!(); }}
                />
              </>
            )}
          </>
        );
      }}
    />
  );
}
