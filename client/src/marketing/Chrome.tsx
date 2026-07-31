import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import NewtMark from '../components/NewtMark';
import SiteFooter from '../components/SiteFooter';
import Lightbox from '../components/Lightbox';
import { SECTIONS, type Section, type ShotSpec } from './sections';
import styles from './chrome.module.css';
import './reveal.css';

// Everything the marketing pages are assembled from. The landing page and the
// six section pages are different arrangements of these parts, which is the only
// reason six pages is a sane amount of page to have.
//
// The load-bearing idea is Band: a full-bleed slab with a *tone*. Changing tone
// is how the page changes temperature as the subject changes, and it is why a
// manifesto and a feature stripe don't look like the same paragraph in
// different words. See chrome.module.css for what each tone actually is.

export type Tone = 'air' | 'soft' | 'deep' | 'canvas' | 'glow';

const TONE_CLASS: Record<Tone, string> = {
  air: styles.toneAir,
  soft: styles.toneSoft,
  deep: styles.toneDeep,
  canvas: styles.toneCanvas,
  glow: styles.toneGlow,
};

/**
 * Reveal-on-scroll for every `[data-reveal]` inside `ref`.
 *
 * Elements start at `opacity: 0` (see reveal.css) and are only made visible
 * once observed, so anything this hook fails to observe is *permanently
 * invisible*. That is the whole risk here, and it is why the DOM is watched
 * rather than scanned once:
 *
 * Marketing routes swap their content without remounting MarketingPage — the
 * six feature pages are all <FeaturePage>, so React reconciles rather than
 * remounts. A one-shot scan on mount therefore observed the *first* page's
 * elements and none of the next page's. Navigating from one feature page to
 * another left the section headings visible (they carry no data-reveal) above
 * step cards and use-case cards stuck at zero opacity — the copy was there in
 * the DOM the whole time, just never revealed.
 */
export function useReveal(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    // No observer means no animation rather than no content.
    if (!('IntersectionObserver' in window)) {
      const showAll = () => root.querySelectorAll('[data-reveal]')
        .forEach(el => el.setAttribute('data-shown', ''));
      showAll();
      const mo = new MutationObserver(showAll);
      mo.observe(root, { childList: true, subtree: true });
      return () => mo.disconnect();
    }

    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.setAttribute('data-shown', '');
        io.unobserve(e.target);
      }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );

    // Observing twice would be harmless, but the set keeps this O(new nodes)
    // rather than O(page) on every mutation.
    const seen = new WeakSet<Element>();
    const sweep = () => {
      root.querySelectorAll('[data-reveal]').forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        io.observe(el);
      });
    };

    sweep();
    const mo = new MutationObserver(sweep);
    mo.observe(root, { childList: true, subtree: true });

    return () => { mo.disconnect(); io.disconnect(); };
  }, [ref]);
}

/** `navigate`, wrapped so a link is a real href that doesn't reload the page. */
export function useGo(navigate: (to: string) => void) {
  return (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
    window.scrollTo({ top: 0 });
  };
}

// ── Nav ───────────────────────────────────────────────────────────────

interface NavProps {
  navigate: (to: string) => void;
  /** Slug of the section page being viewed, if any - marks the menu entry. */
  active?: string;
  /** Swaps the two auth buttons for a single way back into the app. */
  signedIn?: boolean;
}

function FeaturesMenu({ navigate, active }: { navigate: (to: string) => void; active?: string }) {
  const [open, setOpen] = useState(false);
  const go = useGo(navigate);

  return (
    <div
      className={`${styles.menu} ${open ? styles.menuOpen : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // Focus moving anywhere outside the menu closes it, so it behaves for
      // keyboard and pointer alike without a document-level listener.
      onFocus={() => setOpen(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
    >
      <button className={styles.menuBtn} type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        What’s in it
        <svg className={styles.menuCaret} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <div className={styles.menuPanel}>
        {SECTIONS.map(s => (
          <a
            key={s.slug}
            className={styles.menuItem}
            style={{ ['--tint' as string]: s.tint }}
            href={`/features/${s.slug}`}
            onClick={go(`/features/${s.slug}`)}
            aria-current={active === s.slug ? 'page' : undefined}
          >
            <span className={styles.menuItemTitle}>
              <span className={styles.menuDot} />
              {s.nav}
            </span>
            <span className={styles.menuItemBody}>{s.blurb}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function MarketingNav({ navigate, active, signedIn }: NavProps) {
  const go = useGo(navigate);
  return (
    <header className={styles.nav}>
      <div className={styles.navInner}>
        <a className={styles.brand} href="/" onClick={go('/')}>
          <NewtMark className={styles.brandMark} />
          <span className={styles.brandName}>newt</span>
        </a>

        <nav className={styles.navLinks}>
          <FeaturesMenu navigate={navigate} active={active} />
          <a
            className={`${styles.navLink} ${active === 'self-hosting' ? styles.navLinkOn : ''}`}
            href="/self-hosting"
            onClick={go('/self-hosting')}
          >
            Self-hosting
          </a>
        </nav>

        <div className={styles.navCta}>
          {signedIn ? (
            <a className={styles.solidBtn} href="/" onClick={go('/')}>Open Newt</a>
          ) : (
            <>
              <a className={styles.ghostBtn} href="/signin" onClick={go('/signin')}>Sign in</a>
              <a className={styles.solidBtn} href="/signup" onClick={go('/signup')}>Get started</a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Page shell ────────────────────────────────────────────────────────

interface PageProps extends NavProps {
  /** Set as document.title while the page is mounted. */
  title: string;
  /** The page's colour. Everything tinted inside it inherits from here. */
  tint?: string;
  children: ReactNode;
}

/** Backdrop, nav, reveal wiring and footer - the frame around every page. */
export function MarketingPage({ title, tint, navigate, active, signedIn, children }: PageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useReveal(rootRef);

  useEffect(() => {
    document.title = title;
    return () => { document.title = 'New Tab'; };
  }, [title]);

  return (
    <div
      className={styles.root}
      ref={rootRef}
      style={tint ? ({ ['--tint' as string]: tint }) : undefined}
    >
      {/* The same ambient background the app itself uses, so signing in doesn't
          feel like arriving somewhere else. */}
      <div className={styles.bg} aria-hidden>
        <div className={styles.bgBase} />
        <div className={`${styles.blobWrap} ${styles.blobWrap1}`}><div className={`${styles.blob} ${styles.blob1}`} /></div>
        <div className={`${styles.blobWrap} ${styles.blobWrap2}`}><div className={`${styles.blob} ${styles.blob2}`} /></div>
        <div className={`${styles.blobWrap} ${styles.blobWrap3}`}><div className={`${styles.blob} ${styles.blob3}`} /></div>
        <div className={styles.bgGrain} />
      </div>

      <MarketingNav navigate={navigate} active={active} signedIn={signedIn} />
      <main>{children}</main>
      <SiteFooter />
    </div>
  );
}

// ── Band ──────────────────────────────────────────────────────────────

interface BandProps {
  tone?: Tone;
  /** Overrides the page tint for this band and everything in it. */
  tint?: string;
  /** A hairline of the logo gradient across the top edge - use sparingly. */
  edge?: boolean;
  /** Less vertical air, for strips rather than chapters. */
  tight?: boolean;
  id?: string;
  className?: string;
  /** Applied to the inner column, where the layout usually lives. */
  innerClassName?: string;
  children: ReactNode;
}

export function Band({
  tone = 'air', tint, edge, tight, id, className = '', innerClassName = '', children,
}: BandProps) {
  return (
    <section
      id={id}
      className={[
        styles.band,
        TONE_CLASS[tone],
        tight ? styles.bandTight : '',
        className,
      ].filter(Boolean).join(' ')}
      style={tint ? ({ ['--tint' as string]: tint }) : undefined}
    >
      {edge && <span className={styles.edge} aria-hidden />}
      <div className={`${styles.bandInner} ${innerClassName}`}>{children}</div>
    </section>
  );
}

// ── Screenshot frame ──────────────────────────────────────────────────

/**
 * How far the frame tips at its very edge, in degrees. Deliberately small: this
 * should read as a surface giving under the pointer, not as a card being thrown
 * around. Anything past about 8 and the browser chrome at the top starts to
 * look like it is falling off.
 */
const PRESS_TILT = 5;

/**
 * Pointer-tracked "press". The frame tips *away* from the cursor — the corner
 * you are over is the corner that sinks — and a soft highlight follows the
 * contact point.
 *
 * Both are published as CSS custom properties rather than as inline transforms,
 * so the stylesheet still owns what the effect looks like and this only reports
 * where the pointer is. Clearing the properties on the way out lets the CSS
 * transition ease it back to rest instead of snapping.
 */
function usePress() {
  const raf = useRef(0);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // A finger is already in contact with the thing it is touching, so tipping
    // the surface away under it says nothing. Mouse only.
    if (e.pointerType !== 'mouse') return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      // −1..1 out from the centre. rotateX is negated because a positive value
      // tips the *top* away from the viewer, and what we want is for the edge
      // under the cursor to be the one that goes down.
      el.style.setProperty('--press-rx', `${-(y - 0.5) * 2 * PRESS_TILT}deg`);
      el.style.setProperty('--press-ry', `${(x - 0.5) * 2 * PRESS_TILT}deg`);
      el.style.setProperty('--press-x', `${x * 100}%`);
      el.style.setProperty('--press-y', `${y * 100}%`);
    });
  }, []);

  const onPointerLeave = useCallback((e: React.PointerEvent<HTMLElement>) => {
    cancelAnimationFrame(raf.current);
    const el = e.currentTarget;
    for (const p of ['--press-rx', '--press-ry', '--press-x', '--press-y']) {
      el.style.removeProperty(p);
    }
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return { onPointerMove, onPointerLeave };
}

/** A browser-chrome frame. With `src` it shows the screenshot; without one it
 *  shows what that screenshot needs to contain, which is the point until the
 *  images exist.
 *
 *  A frame that has its image is also a control: the shots are captured at 2×
 *  (2400–3200px wide) but drawn here at ~700px, so there is a great deal more
 *  detail in the file than the page ever shows. Clicking opens it full size in
 *  the same Lightbox the app uses for post images. */
export function ShotFrame({ shot, tall = false, aura = false }: { shot: ShotSpec; tall?: boolean; aura?: boolean }) {
  const [zoomed, setZoomed] = useState(false);
  const press = usePress();

  const chrome = (
    <div className={styles.chrome} aria-hidden>
      <span className={`${styles.dot} ${styles.dotR}`} />
      <span className={`${styles.dot} ${styles.dotY}`} />
      <span className={`${styles.dot} ${styles.dotG}`} />
      <span className={styles.chromeBar}>newt.page</span>
    </div>
  );

  const frame = (
    <figure
      className={`${styles.shot} ${tall ? styles.shotTall : ''} ${shot.src ? styles.shotLive : ''}`}
      {...(shot.src ? press : {})}
    >
      {shot.src ? (
        // A real button, so Enter and Space work and it lands in the tab order
        // with a focus ring, rather than a div wearing role="button".
        <button
          type="button"
          className={styles.shotBtn}
          onClick={() => setZoomed(true)}
          aria-label={`${shot.title} — view full size`}
        >
          {chrome}
          <img className={styles.shotImg} src={shot.src} alt={shot.title} loading="lazy" />
        </button>
      ) : (
        <>
          {chrome}
          <div className={styles.placeholder}>
            <div className={styles.phHead}>
              <NewtMark className={styles.phMark} />
              <div>
                <div className={styles.phTitle}>{shot.title}</div>
                <div className={styles.phMeta}>
                  <code>/shots/{shot.id}.png</code> · {shot.size}
                </div>
              </div>
            </div>
            <ul className={styles.phList}>
              {shot.capture.map(line => <li key={line}>{line}</li>)}
            </ul>
          </div>
        </>
      )}
    </figure>
  );

  const zoom = (
    <Lightbox
      image={zoomed && shot.src ? { src: shot.src, alt: shot.title } : null}
      onClose={() => setZoomed(false)}
    />
  );

  if (!aura) return <>{frame}{zoom}</>;
  return (
    <>
      <div className={styles.shotWrap}>
        <span className={styles.aura} aria-hidden />
        {frame}
      </div>
      {zoom}
    </>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────

/** A trail of newt prints, walking, as a divider. The same motif as the site
 *  footer - alternating left/right so it reads as walking rather than hopping. */
export function Trail({ count = 9 }: { count?: number }) {
  return (
    <div className={styles.trail} aria-hidden data-reveal>
      {Array.from({ length: count }, (_, i) => (
        <svg
          key={i}
          className={styles.print}
          style={{ animationDelay: `${i * 110}ms`, transform: `rotate(${i % 2 ? 16 : -16}deg)` }}
          width="13" height="13" viewBox="0 0 12 12"
        >
          <ellipse cx="6" cy="8" rx="2.1" ry="2.6" />
          <circle cx="2.6" cy="4.6" r="1.05" />
          <circle cx="5" cy="2.6" r="1.05" />
          <circle cx="7.6" cy="2.8" r="1.05" />
          <circle cx="9.6" cy="5" r="1.05" />
        </svg>
      ))}
    </div>
  );
}

export function SectionHead({
  kicker, title, body, centre, tintKicker,
}: { kicker: string; title: string; body?: string; centre?: boolean; tintKicker?: boolean }) {
  return (
    <div className={`${styles.sectionHead} ${centre ? styles.sectionHeadCentre : ''}`} data-reveal>
      <span className={`${styles.kicker} ${tintKicker ? styles.kickerTint : ''}`}>{kicker}</span>
      <h2 className={styles.h2}>{title}</h2>
      {body && <p className={styles.body}>{body}</p>}
    </div>
  );
}

export function Points({ items }: { items: string[] }) {
  return (
    <ul className={styles.points}>
      {items.map(p => (
        <li key={p}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="m3 8.5 3.2 3.2L13 5" /></svg>
          {p}
        </li>
      ))}
    </ul>
  );
}

/** The six sections as a strip of cards. `exclude` drops the one you're on. */
export function SectionLinks({
  navigate, exclude, sections = SECTIONS,
}: { navigate: (to: string) => void; exclude?: string; sections?: Section[] }) {
  const go = useGo(navigate);
  return (
    <div className={styles.pageLinks} data-reveal-group>
      {sections.filter(s => s.slug !== exclude).map(s => (
        <a
          key={s.slug}
          className={styles.pageLink}
          style={{ ['--tint' as string]: s.tint }}
          href={`/features/${s.slug}`}
          onClick={go(`/features/${s.slug}`)}
          data-reveal
        >
          <h3 className={styles.pageLinkTitle}>{s.nav}</h3>
          <p className={styles.pageLinkBody}>{s.blurb}</p>
          <span className={styles.pageLinkGo}>Take a look →</span>
        </a>
      ))}
    </div>
  );
}

export function Closer({
  navigate, signedIn, title, body,
}: { navigate: (to: string) => void; signedIn?: boolean; title: string; body: ReactNode }) {
  const go = useGo(navigate);
  return (
    <div className={styles.closer} data-reveal>
      <NewtMark className={styles.closerMark} />
      <h2 className={styles.closerTitle}>{title}</h2>
      <p className={styles.closerBody}>{body}</p>
      <div className={styles.ctaRow}>
        {signedIn ? (
          <a className={`${styles.solidBtn} ${styles.bigBtn}`} href="/" onClick={go('/')}>Open your new tab</a>
        ) : (
          <>
            <a className={`${styles.solidBtn} ${styles.bigBtn}`} href="/signup" onClick={go('/signup')}>
              Create your account
            </a>
            <a className={`${styles.ghostBtn} ${styles.bigBtn}`} href="/signin" onClick={go('/signin')}>
              Sign in
            </a>
          </>
        )}
      </div>
    </div>
  );
}

// Re-exported so pages compose their own layouts from the shared type scale and
// buttons without importing the stylesheet a second time.
export { styles as chrome };
