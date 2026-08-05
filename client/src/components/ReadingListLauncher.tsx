import styles from './ReadingListLauncher.module.css';
import { shortDuration } from '../utils/readingTime';
import { faviconUrl } from '../utils/color';

// The reading list's front door on the new tab.
//
// It used to be a section that unfolded in place behind a chevron, which meant
// the thing the app is actually for - what you kept, and whether you're getting
// to it - was either a wall of cards under the feed or a single grey word. A
// collapsed heading says nothing, and an expanded grid says everything at once.
//
// This says the two numbers that matter and how they're trending, and opens the
// list proper. Only the pile is counted: articles filed into folders are dealt
// with, and a shelf full of things you meant to keep is not a backlog.

// How hard it pushes. Not a straight scale - the difference between two saved
// articles and five is nothing, and the difference between five and twenty is
// the difference between a reading list and a guilty conscience.
export type Urgency = 'empty' | 'calm' | 'building' | 'full' | 'urgent';

// Where the meter reads full. Past this the bar pins and the copy carries the
// rest, because a bar that can always grow a bit more never says "enough".
const METER_MAX = 16;

export function urgencyFor(count: number): Urgency {
  if (count === 0) return 'empty';
  if (count <= 3) return 'calm';
  if (count <= 8) return 'building';
  if (count <= 15) return 'full';
  return 'urgent';
}

// One line, in the voice of how far gone the pile is. The stats above it are
// already the facts; this is the part that says whether to worry.
const LINES: Record<Urgency, string> = {
  empty:    'Save an article from your feed and it lands here.',
  calm:     'A short stack. Good time to start one.',
  building: 'An evening’s reading, waiting on you.',
  full:     'The pile is getting deep. Clear a couple out.',
  urgent:   'This has been building for a while.',
};

/** Enough of an article to draw a thumbnail of it. */
export interface PreviewItem {
  id: string;
  title: string;
  url: string;
  imageUrl: string;
}

// How many covers the stack shows. Four is the most that reads as a stack
// rather than as a row of small pictures.
const STACK = 4;

interface Props {
  /** Articles on the pile - saved, not yet filed. */
  count: number;
  /** Their total read time, in minutes. */
  minutes: number;
  /** Articles filed onto shelves. Named, not counted against you. */
  filedCount: number;
  /** The newest few on the pile, for the cover stack. Newest first. */
  preview?: PreviewItem[];
  onOpen: () => void;
}

export default function ReadingListLauncher({ count, minutes, filedCount, preview = [], onOpen }: Props) {
  const urgency = urgencyFor(count);
  const fill = Math.min(1, count / METER_MAX);
  const stack = preview.slice(0, STACK);

  return (
    <button
      type="button"
      className={`${styles.launcher} ${styles[urgency]}`}
      onClick={onOpen}
      aria-label={`Open reading list - ${count} article${count === 1 ? '' : 's'} waiting`}
    >
      {/* The count, at the size the count deserves, with its own unit under it.
          It is the one number the whole control exists to put in front of you,
          and a figure this big is legible from across a room - which is the
          difference between noticing the pile and going to read a label.
          The word belongs here rather than in the stats line beside it: said in
          both places it was the same fact printed twice, six inches apart. */}
      <span className={styles.badge} aria-hidden>
        <span className={styles.badgeNum}>{count}</span>
        <span className={styles.badgeUnit}>{count === 1 ? 'article' : 'articles'}</span>
      </span>

      <span className={styles.text}>
        <span className={styles.title}>Reading list</span>
        <span className={styles.stats}>
          {count === 0 ? (
            <span className={styles.statsEmpty}>Nothing waiting</span>
          ) : (
            <span className={styles.stat}>
              <ClockIcon />
              {shortDuration(minutes)} of reading
            </span>
          )}
          {filedCount > 0 && (
            <>
              <span className={styles.sep} aria-hidden>·</span>
              <span className={styles.statMuted}>{filedCount} filed</span>
            </>
          )}
        </span>
        <span className={styles.line}>{LINES[urgency]}</span>
      </span>

      {/* What's actually on the pile, as a short overlapping stack of covers.
          It fills the middle of the panel, which was empty, and it does it with
          the one thing worth putting there: the articles themselves. A count
          tells you how big the stack is; this tells you what is in it, which is
          what decides whether you open it now or later.
          Art-less articles fall back to the publisher's favicon, so a stack
          never goes half-blank. Both are hidden on error rather than left as
          broken-image boxes. */}
      {stack.length > 0 && (
        <span className={styles.stack} aria-hidden>
          {stack.map((p, i) => (
            <span key={p.id} className={styles.stackItem} style={{ zIndex: STACK - i }}>
              {p.imageUrl ? (
                <img
                  className={styles.stackCover}
                  src={p.imageUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <img
                  className={styles.stackFavicon}
                  src={faviconUrl(p.url)}
                  alt=""
                  loading="lazy"
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              )}
            </span>
          ))}
        </span>
      )}

      <span className={styles.go}>
        <span className={styles.goLabel}>Open</span>
        <span className={styles.goArrow} aria-hidden>→</span>
      </span>

      {/* Along the bottom edge, so the control has a reading even before any of
          its type does. Empty is a hairline, not a missing bar - the track has
          to be visible for the fill to mean anything. */}
      <span className={styles.meter} aria-hidden>
        <span className={styles.meterFill} style={{ transform: `scaleX(${fill})` }} />
      </span>
    </button>
  );
}

function ClockIcon() {
  return (
    <svg className={styles.clock} width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4v3.2l2 1.3" />
    </svg>
  );
}
