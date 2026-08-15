import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './NewtButton.module.css';
import { EmbedData } from '../utils/noteEmbed';
import {
  MAX_REFERENCES, ReferenceItem, referenceCommandAt, referenceSuggestions,
} from '../utils/referenceCommand';
import { DockSide, readDock, sideForX, writeDock } from '../utils/newtDock';
import { useFeedSearch } from '../hooks/useFeedSearch';
import { faviconUrl } from '../utils/color';

/**
 * The newt button - the round "n" in the bottom corner.
 *
 * It was the notes launcher, and for a while notes were the only thing worth
 * putting behind it. They aren't any more: the same corner is now the shortest
 * route to a question about whatever is on screen, so the button opens a small
 * menu rather than one console. What it does *not* do is grow into a launcher
 * for the whole app - everything here is a way of writing something down or
 * asking about what you are reading, which is the one sentence that decides
 * whether a future row belongs in it.
 *
 * The button can be dragged to the other side of the window. That is a
 * left-handed reader's fix, and a fix for the button sitting on top of whatever
 * a particular site's own bottom-right control is; the side is remembered per
 * device (see utils/newtDock).
 */

// Past this the pointer is dragging the button rather than pressing it. Small
// enough that a deliberate throw registers immediately, large enough that the
// wobble in a tap on a phone still opens the menu.
const DRAG_SLOP = 6;

// How long the pills and the card take to leave. Must match the exit animations
// in the stylesheet - this is the timer that unmounts them once they have
// played, so a longer one leaves a frozen card on screen and a shorter one cuts
// the animation off partway.
const CLOSE_MS = 150;

interface Props {
  /** Open the notes console on whatever was last being written. */
  onOpenNotes: () => void;
  /** Open it on a fresh, empty note instead. */
  onNewNote: () => void;
  /**
   * Ask the reader's own model, carrying whatever page is open as context and
   * any articles /reference attached. Undefined when no model is connected, in
   * which case the field is replaced by the way to connect one.
   */
  onAsk?: (question: string, refs: string[]) => void;
  /** Where to go to connect a model. Offered only when none is. */
  onOpenSettings: () => void;
  /**
   * What the question would be asked *about* - "this article", "this post" - or
   * null on a page with nothing to read. Shown so the reader can see what the
   * model is being handed before they type into it.
   */
  contextLabel?: string | null;
  /** What /reference can attach: saved articles and your own posts. */
  references?: EmbedData[];
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Hide an icon that 404s rather than leaving a broken-image glyph behind. */
function hideBroken(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).style.display = 'none';
}

const NoteIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h4" />
  </svg>
);

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h13" /><path d="M12 5l7 7-7 7" />
  </svg>
);

export default function NewtButton({
  onOpenNotes, onNewNote, onAsk, onOpenSettings, contextLabel, references = [],
}: Props) {
  const [side, setSide] = useState<DockSide>(readDock);
  const [open, setOpen] = useState(false);
  // Open, but on its way out: still mounted so the exit animation has something
  // to play on. Nothing in here is interactive while it's true.
  const [closing, setClosing] = useState(false);
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ReferenceItem[]>([]);
  /** Where the button is while it's being dragged; null when it's docked. */
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null);

  // The close cross paints itself with the brand gradient, and a gradient needs
  // an id of its own - two newt buttons on one page must not share one.
  const crossGradient = useId();

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Pointer bookkeeping for the drag. In a ref because none of it renders and
  // a move handler that re-rendered on every pixel would be the one thing that
  // makes dragging feel bad.
  const pressRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  // Published so the other things pinned to the bottom of the window can get
  // out of the way - the feed offer sits in the left corner, back-to-top stacks
  // above this button while it's in the right one, and Explore's composer keeps
  // its send button out from under it. A data attribute rather than a variable
  // each of them has to read: what they need to know is which corner is taken,
  // not where exactly.
  //
  // Never cleared. It describes a preference, not a mounted component, and this
  // button unmounts every time the notes console opens - which, on a window wide
  // enough for the console to leave the page visible around it, meant Explore's
  // composer visibly reflowing 72px wider behind the overlay and back again.
  useEffect(() => {
    document.documentElement.dataset.newtDock = side;
  }, [side]);

  // ── The Ask field ────────────────────────────────────────────────────────
  // Exactly the composer's bargain, in miniature: /reference turns the box into
  // a picker, choosing an article takes the command back out and leaves the
  // question it was appended to, and the chips ride along when it is sent. See
  // utils/referenceCommand, which both question boxes parse with.
  const refCmd = onAsk ? referenceCommandAt(draft) : null;
  const refTerm = refCmd?.query ?? null;
  const refHits = useFeedSearch(refTerm ?? '');
  const attachedUrls = useMemo(() => attached.map(r => r.url), [attached]);
  const suggestions = useMemo(
    () => (refTerm === null ? [] : referenceSuggestions(refTerm, references, refHits, attachedUrls)),
    [refTerm, references, refHits, attachedUrls],
  );

  // The timer that finishes a close. Held so a reopen mid-animation can cancel
  // it - otherwise the pills you just brought back vanish a moment later.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  /**
   * Close, with the exit animation played out first.
   *
   * `immediate` is for the cases where the surface has no business animating
   * anywhere: a drag has picked the whole assembly up and moved it, or a pill
   * has just opened the notes console over the top. Both leave nothing for an
   * exit to be an exit *from*.
   *
   * The draft survives either way - a card dismissed by a stray click outside
   * it should not also throw away a half-typed question. Sending clears it.
   */
  const close = useCallback((immediate = false) => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (immediate) { setClosing(false); setOpen(false); return; }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setClosing(false);
      setOpen(false);
    }, CLOSE_MS);
  }, []);

  const toggle = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    // Reopening mid-close catches the card on its way out rather than queuing
    // behind it: clearing `closing` puts the entrance animation back on.
    if (closing) { setClosing(false); setOpen(true); return; }
    if (open) { close(); return; }
    setOpen(true);
  }, [open, closing, close]);

  // Outside click and Escape, the same two ways out every other menu here has.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Opening is a request to type: the field is the only thing in here you can't
  // reach with one more click.
  useEffect(() => {
    if (open && onAsk) inputRef.current?.focus();
  }, [open, onAsk]);

  function attach(item: ReferenceItem) {
    setAttached(prev => (
      prev.length >= MAX_REFERENCES || prev.some(r => r.url === item.url) ? prev : [...prev, item]
    ));
    // The command has done its job, so it comes out of the box - it would
    // otherwise be sent to the model as part of what was asked. Only the
    // command: whatever question it was appended to stays, with a space to
    // carry on typing after.
    const rest = refCmd?.rest ?? '';
    setDraft(rest ? `${rest} ` : '');
    inputRef.current?.focus();
  }

  function detach(url: string) {
    setAttached(prev => prev.filter(r => r.url !== url));
  }

  function send() {
    if (!onAsk) return;
    // A /reference still in the box has not chosen anything yet, and the text
    // of the command is not a question.
    if (refTerm !== null) return;
    const question = draft.trim();
    if (!question) return;
    onAsk(question, attachedUrls);
    setDraft('');
    setAttached([]);
    // Immediate: the question has gone, and Explore is arriving over the top.
    close(true);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Escape abandons a /reference mid-search rather than closing the card, and
    // takes only the command with it - the picker is a detour, not a mode you
    // get stuck in. The same bargain Explore's composer makes. Stopping
    // propagation is what keeps the document-level Escape from closing the card
    // out from under it.
    if (e.key === 'Escape' && refTerm !== null) {
      e.preventDefault();
      e.stopPropagation();
      const rest = refCmd?.rest ?? '';
      setDraft(rest ? `${rest} ` : '');
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if ((e.nativeEvent as KeyboardEvent).isComposing) return;
    e.preventDefault();
    // Enter while the picker is up takes the first article rather than doing
    // nothing, which is what "/reference clim" + Enter obviously means.
    if (refTerm !== null) {
      if (suggestions.length > 0) attach(suggestions[0]);
      return;
    }
    send();
  }

  // A pill's action. Closed immediately rather than animated out: what these
  // open - the notes console, the settings dialog - covers this corner in the
  // same frame, so an exit animation would play underneath it.
  function pick(run: () => void) {
    close(true);
    run();
  }

  // ── Dragging ─────────────────────────────────────────────────────────────
  // Pointer events on the button itself rather than a drag library: there is
  // one draggable thing here with two possible resting places, and the whole
  // gesture is "which half of the window did you let go in".

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pressRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_SLOP;
    if (!press.moved && !far) return;
    if (!press.moved) {
      press.moved = true;
      // Everything open is anchored to a corner the button is no longer in, so
      // it goes at once rather than animating out of a place it has left.
      close(true);
    }
    setDragAt({ x: e.clientX, y: e.clientY });
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const press = pressRef.current;
    if (!press || press.id !== e.pointerId) return;
    pressRef.current = null;
    // Guarded: releasing a pointer that isn't captured throws, and a
    // pointercancel between down and up is exactly how that happens.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!press.moved) { toggle(); return; }
    // Only the side is kept. The button lives in a corner, so a drag says which
    // corner and nothing else; letting it come to rest wherever it was dropped
    // would be a control the reader can lose behind the fold.
    const next = sideForX(e.clientX, window.innerWidth, side);
    setDragAt(null);
    if (next === side) return;
    setSide(next);
    writeDock(next);
  }

  function onPointerCancel() {
    pressRef.current = null;
    setDragAt(null);
  }

  const dragging = dragAt !== null;
  // The mark shows a close cross exactly while there is something on screen to
  // close. `closing` counts as shut: the cross should be unwinding back into the
  // "n" at the same moment the pills retract, not a beat behind them.
  const showX = open && !closing && !dragging;

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap} ${side === 'left' ? styles.wrapLeft : ''} ${dragging ? styles.wrapDragging : ''}`}
      style={dragging ? { left: dragAt.x, top: dragAt.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      {/* The Ask card, floating clear above the button. Its own surface rather
          than the top of a menu: the two things this button does are ask and
          write, and they are different enough shapes - a field you type into,
          and two places to go - that one card holding both made the field look
          like a third menu row. */}
      {open && !dragging && (
        <div
          className={`${styles.ask} ${closing ? styles.askClosing : ''}`}
          role="dialog"
          aria-label="Ask"
        >
          {onAsk ? (
            <>
              {/* What the model is being handed, said before anything is
                  typed rather than discovered in the answer. */}
              <div className={styles.askContext}>
                {contextLabel ? `about ${contextLabel}` : 'nothing on this page to attach'}
              </div>

              {attached.length > 0 && (
                <div className={styles.chips}>
                  {attached.map(r => (
                    <span key={r.url} className={styles.chip} title={r.title}>
                      <img className={styles.chipIcon} src={faviconUrl(domainOf(r.url))} alt="" onError={hideBroken} />
                      <span className={styles.chipText}>{r.title}</span>
                      <button
                        className={styles.chipX}
                        onClick={() => detach(r.url)}
                        title="Remove"
                        aria-label={`Remove ${r.title}`}
                      >
                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M1 1l10 10M11 1L1 11" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className={styles.field}>
                <textarea
                  ref={inputRef}
                  className={styles.input}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={2}
                  placeholder={
                    attached.length >= MAX_REFERENCES
                      ? 'Ask about these…'
                      : 'Ask a question — /reference to attach an article'
                  }
                  aria-label="Ask your model about this page"
                />
                <button
                  className={styles.send}
                  onClick={send}
                  disabled={!draft.trim() || refTerm !== null}
                  title="Ask"
                  aria-label="Ask"
                >
                  <SendIcon />
                </button>
              </div>

              {/* The picker. Replaces nothing - it opens under the box the
                  moment /reference is typed and closes when it leaves. */}
              {refTerm !== null && (
                <div className={styles.picker}>
                  {attached.length >= MAX_REFERENCES ? (
                    <div className={styles.pickerNote}>
                      {MAX_REFERENCES} articles is the most one question can carry.
                    </div>
                  ) : !refTerm ? (
                    <div className={styles.pickerNote}>Type part of a headline…</div>
                  ) : suggestions.length === 0 ? (
                    <div className={styles.pickerNote}>Nothing saved or in your feeds matches that.</div>
                  ) : (
                    suggestions.map(item => (
                      <button
                        key={item.url}
                        className={styles.pickerRow}
                        onClick={() => attach(item)}
                      >
                        <img
                          className={styles.chipIcon}
                          src={faviconUrl(domainOf(item.url))}
                          alt=""
                          onError={hideBroken}
                        />
                        <span className={styles.pickerText}>
                          <span className={styles.pickerTitle}>{item.title || item.url}</span>
                          <span className={styles.pickerSource}>{item.source || domainOf(item.url)}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          ) : (
            /* No model connected. The honest thing to show is the way to
               connect one, not a box that would have nowhere to send. */
            <button className={styles.askEmpty} onClick={() => pick(onOpenSettings)}>
              Connect a model to ask about what you’re reading
            </button>
          )}
        </div>
      )}

      {/* The button and the two places it can send you, on one row. Reversed
          when the button is docked left, so the pills always spring out into
          the room rather than off the edge of the window - the group keeps its
          reading order either way, it is which side of the button it sits on
          that flips. */}
      <div className={`${styles.dock} ${side === 'left' ? styles.dockLeft : ''}`}>
        {open && !dragging && (
          <div className={`${styles.pills} ${closing ? styles.pillsClosing : ''}`}>
            <button className={styles.pill} onClick={() => pick(onOpenNotes)}>
              <NoteIcon />
              <span>Notes</span>
              <kbd className={styles.pillKey}>n</kbd>
            </button>
            <button className={styles.pill} onClick={() => pick(onNewNote)}>
              <PlusIcon />
              <span>New note</span>
            </button>
          </div>
        )}

        <button
          className={styles.button}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          // Click is deliberately not handled: the pointer sequence above
          // decides between a press and a drag, and a click listener would fire
          // again after a drag that happened to end where it started.
          aria-expanded={open}
          aria-haspopup="dialog"
          title={showX ? 'Close' : 'Newt — notes and Ask (drag to move)'}
          aria-label={showX ? 'Close newt menu' : 'Newt menu'}
        >
          {/* The mark turns into a close button while the menu is out, so the
              thing that opened it is visibly the thing that shuts it. Both
              glyphs are always mounted, stacked in one grid cell and
              counter-rotated past each other - a swap you can watch reads as
              one object turning, where a straight cross-fade reads as two. */}
          <span className={`${styles.glyph} ${showX ? styles.glyphOpen : ''}`} aria-hidden>
            <span className={styles.letter}>n</span>
            <svg className={styles.cross} viewBox="0 0 24 24" fill="none">
              <defs>
                {/* Its own gradient per instance, the same way NewtMark does
                    it - two marks on one page must not share an id. */}
                <linearGradient id={crossGradient} x1="6" y1="6" x2="18" y2="18" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#9B8CFF" />
                  <stop offset=".55" stopColor="#5BC8E6" />
                  <stop offset="1" stopColor="#36D6A6" />
                </linearGradient>
              </defs>
              {/* Sized to the mark it replaces: 12 of 24 units across, which
                  lands within a pixel of the "n"'s own width. */}
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke={`url(#${crossGradient})`}
                strokeWidth="2.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </button>
      </div>
    </div>
  );
}
