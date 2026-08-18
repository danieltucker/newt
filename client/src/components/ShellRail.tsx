import { ReactNode, useRef } from 'react';
import styles from './ShellRail.module.css';
import { railPlaces, activeRailPlace } from '../utils/railPlaces';
import { useRailMarker } from '../hooks/useRailMarker';

/**
 * The navigation rail: where you can go, then what you have kept.
 *
 * It carries content and only content. Settings, the admin console and your own
 * account row are in the avatar menu instead - see shellNav. That line is the
 * point of the thing: the rail is your library, the corner your face is in is
 * your account, and nothing appears in both. Newt's old problem was Posts and
 * Explore filed under a photograph of you because there was nowhere else, and a
 * rail that then repeated them would have been the same mistake twice.
 *
 * Zones, top to bottom:
 *
 *   Places      where you can go. Short, fixed, every row a real route.
 *   Bookmarks   what you have kept: the pinned tiles, then the folder tree.
 *
 * Pinned sits directly above the folders rather than above everything, because
 * pinned links and folders are the same subject and reading them as one block is
 * what makes the rail scannable. It still outlives the tree changing with the
 * place - once Feed and Reading have their own trees, the bookmarks group stays
 * where it is and the tree above it is what swaps.
 *
 * There is one presentation and no collapsed variant. A folded icons-only rail
 * was built and taken out again: it cost the folder list its names, the pinned
 * links their labels, and every affordance a second design - a flyout for
 * folders, a deck for pins, a hover-to-open for the column - none of which paid
 * for itself against simply having the rail there. If it comes back it comes
 * back on its own terms rather than as a squeeze of this one.
 *
 * What is deliberately not here yet: Feed, Reading and Bookmarks rows. They are
 * three of the six places the design calls for, and they arrive with their
 * routes rather than ahead of them - see railPlaces.
 */

interface Props {
  /** Adds the Explore row. Gated as the old avatar menu gated it. */
  hasModel?: boolean;
  /** Pathname, so the current place highlights. Not the full URL. */
  path: string;
  navigate: (to: string) => void;

  /** The pinned-bookmark tiles, at the head of the bookmarks group. */
  pinned?: ReactNode;
  /** The folder tree. */
  tree?: ReactNode;
  /** What the bookmarks group is called this time. */
  treeLabel?: string;

  /**
   * Called after any row is picked, so a drawer can dismiss itself. The column
   * passes nothing: there is no drawer to close, and navigating is the result.
   */
  onNavigated?: () => void;
}

// ── Icons ──
// One per place id. Kept here rather than in railPlaces because that file is
// the rule about which places exist and this is what they look like.
const PlaceIcon = ({ id }: { id: string }) => {
  const p = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (id) {
    case 'today':
      return <svg {...p}><path d="M3 10.5 12 4l9 6.5" /><path d="M5.5 9.5V20h13V9.5" /></svg>;
    case 'posts':
      return <svg {...p}><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" /><path d="M14 6.5 17.5 10" /></svg>;
    case 'explore':
      // Centred at 12,12 like the others. Drawn from 3.5 to 17.5 it sat a
      // unit and a half high in a 24-unit box, which on a row of three icons
      // is the one that looks like it slipped.
      return <svg {...p}><path d="M12 5l1.9 5.1 5.1 1.9-5.1 1.9L12 19l-1.9-5.1L5 12l5.1-1.9z" /></svg>;
    default:
      return <svg {...p}><circle cx="12" cy="12" r="7.5" /></svg>;
  }
};

export default function ShellRail({
  hasModel, path, navigate,
  pinned, tree, treeLabel = 'Bookmarks', onNavigated,
}: Props) {
  const places = railPlaces({ hasModel });
  const active = activeRailPlace(path);

  // The highlight rests on the place you are in and slides when you go
  // somewhere else. It does not follow the pointer - see useRailMarker.
  const placesRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const marker = useRailMarker({
    activeId: active,
    elementFor: id => rowRefs.current[id] ?? null,
    containerRef: placesRef,
    deps: [places.length],
  });

  function go(href: string) {
    navigate(href);
    onNavigated?.();
  }

  return (
    <nav className={styles.rail} aria-label="Navigation">
      {/* ── Places ── */}
      <div className={styles.places} ref={placesRef}>
        {/* Painted under the rows, so a row's own text and icon sit on top of it
            and inherit nothing from it. aria-hidden: the highlight repeats what
            aria-current already says. */}
        <span
          className={`${styles.lozenge} ${marker ? styles.lozengeOn : ''}`}
          style={marker ? { transform: `translateY(${marker.top}px)`, height: marker.height } : undefined}
          aria-hidden
        />
        {places.map(place => {
          const on = active === place.id;
          return (
            <button
              key={place.id}
              ref={el => { rowRefs.current[place.id] = el; }}
              className={`${styles.row} ${on ? styles.rowOn : ''}`}
              onClick={() => go(place.href)}
              // A set of destinations, so the current one is the selected one -
              // `current` rather than `pressed`, which would say it is held down.
              aria-current={on ? 'page' : undefined}
            >
              <span className={styles.icon}><PlaceIcon id={place.id} /></span>
              <span className={styles.label}>{place.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── Bookmarks: the pinned tiles and the folder tree, as one subject ── */}
      {(pinned || tree) && (
        <div className={styles.bookmarks}>
          <div className={styles.zoneLabel}>{treeLabel}</div>
          {pinned && <div className={styles.pinned}>{pinned}</div>}
          {tree && <div className={styles.treeBody}>{tree}</div>}
        </div>
      )}
    </nav>
  );
}
