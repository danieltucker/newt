import { useEffect, useRef } from 'react';
import NewtMark from '../components/NewtMark';
import SiteFooter from '../components/SiteFooter';
import styles from './LandingPage.module.css';

// The front door, for anyone who isn't signed in. Public pages (a shared post,
// a profile, an article thread) still open directly - this is what's behind the
// bare "/" for a visitor who has never been here.
//
// Built to be filled in: every screenshot is a ShotFrame carrying its own spec,
// so the page ships legible and self-documenting, and each frame becomes a real
// image by dropping a file in /public/shots and adding `src` to its SHOTS entry.
// Nothing here fetches anything.
//
// Positioning: newt.page is the product. Self-hosting is real and stays on the
// page, but as a footnote for the minority who want it - leading with "clone
// this repo" would send everyone else away to install Docker.

interface Props {
  navigate: (to: string) => void;
}

// ── Screenshots still to take ─────────────────────────────────────────
// `src` is deliberately absent on every entry: until one is set the frame
// renders its spec instead of an image, so what's missing is visible on the
// page rather than buried in a to-do list.
interface ShotSpec {
  id: string;
  /** What to name the file, and what the frame calls itself while empty. */
  title: string;
  /** Pixel size to capture at - 2× these for a retina asset. */
  size: string;
  /** Everything that must be on screen for the shot to make its point. */
  capture: string[];
  /** Set to '/shots/<file>.png' once taken. */
  src?: string;
}

const SHOTS: Record<string, ShotSpec> = {
  hero: {
    id: 'hero',
    title: 'The whole new tab',
    size: '1600 × 1000',
    capture: [
      'Dark theme, a full folder of bookmarks, sidebar open',
      'Reading list showing 3–4 cards with artwork',
      'An RSS folder with a couple of unread dots',
      'Search bar empty - it is the first thing the eye lands on',
    ],
  },
  bookmarks: {
    id: 'bookmarks',
    title: 'Bookmarks and folders',
    size: '1200 × 800',
    capture: [
      'Four or five colour-coded folders in the sidebar',
      'A tile mid-drag, with the drop gap open',
      'The pinned row across the top of the sidebar',
    ],
  },
  feeds: {
    id: 'feeds',
    title: 'RSS, discovered for you',
    size: '1200 × 800',
    capture: [
      'A folder’s article list with real headlines',
      'At least two unread indicators',
      'A favourited tag chip, so the gold is visible',
    ],
  },
  reading: {
    id: 'reading',
    title: 'The reading list',
    size: '1200 × 900',
    capture: [
      'Magazine layout - one feature card plus standards',
      'Tags visible on at least one card',
      'The read-time estimates showing',
    ],
  },
  notes: {
    id: 'notes',
    title: 'The notes console',
    size: '1400 × 900',
    capture: [
      'Console open over the dimmed new tab page',
      'The slash command menu open, mid-list',
      'A note with a heading, a to-do or two, and a reference card',
    ],
  },
  blog: {
    id: 'blog',
    title: 'A published post',
    size: '1200 × 900',
    capture: [
      'A real post with a hero image and a byline',
      'A reference card embedded in the body',
      'The comment thread started underneath',
    ],
  },
  social: {
    id: 'social',
    title: 'Profiles and friends',
    size: '1200 × 800',
    capture: [
      'A profile with an avatar, a few posts and the Friends tab',
      'The Follow button in its un-followed state',
      'A comment thread with two or three replies nested',
    ],
  },
};

// ── Bits and pieces ───────────────────────────────────────────────────

// A browser-chrome frame. With `src` it shows the screenshot; without one it
// shows what that screenshot needs to contain, which is the point until the
// images exist.
function ShotFrame({ shot, tall = false }: { shot: ShotSpec; tall?: boolean }) {
  return (
    <figure className={`${styles.shot} ${tall ? styles.shotTall : ''}`}>
      <div className={styles.chrome} aria-hidden>
        <span className={`${styles.dot} ${styles.dotR}`} />
        <span className={`${styles.dot} ${styles.dotY}`} />
        <span className={`${styles.dot} ${styles.dotG}`} />
        <span className={styles.chromeBar}>newt.page</span>
      </div>

      {shot.src ? (
        <img className={styles.shotImg} src={shot.src} alt={shot.title} loading="lazy" />
      ) : (
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
      )}
    </figure>
  );
}

// A trail of newt prints, walking. The same motif as the site footer, stretched
// out here to divide the page - alternating left/right so it reads as walking
// rather than hopping.
function Trail({ count = 9 }: { count?: number }) {
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

interface Feature {
  kicker: string;
  title: string;
  body: string;
  points: string[];
  shot: ShotSpec;
  /** Screenshot on the left instead of the right. */
  flip?: boolean;
}

const FEATURES: Feature[] = [
  {
    kicker: 'Bookmarks',
    title: 'A desk, not a drawer',
    body:
      'Colour-coded folders you can actually tell apart, drag-and-drop that goes where you ' +
      'aimed it, and a pinned row for the eight or nine sites you open without thinking. ' +
      'Already have a tangle? Import your browser’s bookmarks file and sort it out here.',
    points: ['Colour-coded folders', 'Pin to the top row', 'Import from any browser', 'Panel or inline layout'],
    shot: SHOTS.bookmarks,
  },
  {
    kicker: 'Feeds',
    title: 'It goes and finds the RSS for you',
    body:
      'Bookmark a site and Newt quietly checks whether it publishes a feed. If it does, new ' +
      'posts light up on the tile, and the whole folder’s worth of articles is one click ' +
      'away. No feed reader to keep in sync, no separate app to remember.',
    points: ['Auto-discovered feeds', 'Unread indicators', 'Read by folder', 'Star a tag to flag matches'],
    shot: SHOTS.feeds,
    flip: true,
  },
  {
    kicker: 'Reading list',
    title: 'The articles you meant to get to',
    body:
      'Save anything with a tag, a note to yourself, and an honest read-time estimate - so ' +
      '"I’ll read this later" becomes a plan rather than a lie. Lays out as a magazine, ' +
      'as cards, or as a plain list, depending on how much you want to be tempted.',
    points: ['Tags and personal notes', 'Read-time estimates', 'Magazine / cards / list', 'Archive when done'],
    shot: SHOTS.reading,
  },
  {
    kicker: 'Notes',
    title: 'Type / and keep going',
    body:
      'A proper writing surface hiding behind your new tab: folders, headings, to-dos, tables, ' +
      'code blocks, images you can paste straight in. Reference a saved article and it embeds ' +
      'as a card. Delete something and it waits fifteen days before it means it.',
    points: ['Slash commands', 'Folders and search', 'To-dos, tables, code, images', 'Recently deleted'],
    shot: SHOTS.notes,
    flip: true,
  },
  {
    kicker: 'Blogging',
    title: 'Publish, or just think out loud',
    body:
      'Every account comes with a blog. Posts can be public, friends-only, or private - and ' +
      'private doubles as your drafts folder, so there is no separate place for the half-' +
      'finished ones. Readers can follow you, and every post carries its own comment thread.',
    points: ['Public, friends-only, private', 'Drafts are just private posts', 'Cover images', 'Followers'],
    shot: SHOTS.blog,
  },
  {
    kicker: 'Together',
    title: 'Talk about what you read',
    body:
      'Comment on any article, anywhere. Threads hang off the article’s own URL, so the ' +
      'conversation you started from an RSS card is the same one you find on the saved copy ' +
      'a month later. Say it publicly, to friends only, or to nobody but future you.',
    points: ['Threads on any URL', 'Three visibility levels', 'Friend requests', 'Block and report'],
    shot: SHOTS.social,
    flip: true,
  },
];

interface Small { icon: JSX.Element; title: string; body: string; }

const ico = (d: JSX.Element) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);

const SMALL: Small[] = [
  {
    icon: ico(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>),
    title: 'Search that starts at home',
    body: 'Google, DuckDuckGo, Bing or Brave - but it looks through your own bookmarks, notes and saved articles first.',
  },
  {
    icon: ico(<><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>),
    title: 'Dark, light, or ask the OS',
    body: 'Three settings, one of which is "stop asking me". The whole app follows, right down to the reading cards.',
  },
  {
    icon: ico(<><rect x="2.5" y="4" width="19" height="16" rx="2.5" /><path d="m7 10 2.5 2L7 14M12.5 15H17" /></>),
    title: 'A terminal on a backtick',
    body: 'Look up your IP, run a DNS query or a speed test, and reach half your settings without opening a menu.',
  },
  {
    icon: ico(<><rect x="4" y="10.5" width="16" height="10.5" rx="2.5" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>),
    title: 'Two-factor, properly',
    body: 'TOTP with a QR code and any authenticator app. Reasonable, given how much of your day is in here.',
  },
  {
    icon: ico(<><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 20h16" /></>),
    title: 'Bring everything with you',
    body: 'Import the bookmarks HTML your browser exports. Folders and all, in one drop.',
  },
  {
    icon: ico(<><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="14" y="3" width="7" height="5" rx="1.6" /><rect x="3" y="14" width="18" height="7" rx="2" /></>),
    title: 'The same tab everywhere',
    body: 'It’s a website, not an extension. Laptop, desktop, phone - same bookmarks, same notes, same place in the article.',
  },
];

// Real commands, real shapes of output - see COMMANDS in components/Console.tsx.
// One from each half of what the console is for: something you needed to look
// up, and something you'd otherwise have opened Settings for.
const CONSOLE_LINES: [string, string][] = [
  ['ip', '73.15.42.9 · Bellingham, WA'],
  ['dns newt.page', 'A  185.199.110.153'],
  ['speedtest', '↓ 412 Mbps · ↑ 38 Mbps · 14 ms'],
  ['theme light', 'ok - blinding'],
];

// ── Page ──────────────────────────────────────────────────────────────

export default function LandingPage({ navigate }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Newt - a new tab worth opening';
    return () => { document.title = 'New Tab'; };
  }, []);

  // Reveal on scroll. Anything past the fold starts folded down and rises as it
  // comes into view; if the browser can't observe, everything is simply shown.
  useEffect(() => {
    const els = rootRef.current?.querySelectorAll('[data-reveal]');
    if (!els) return;
    if (!('IntersectionObserver' in window)) {
      els.forEach(el => el.setAttribute('data-shown', ''));
      return;
    }
    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.setAttribute('data-shown', '');
        io.unobserve(e.target);
      }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };

  return (
    <div className={styles.root} ref={rootRef}>
      {/* Same ambient background the app itself uses, so signing in doesn't
          feel like arriving somewhere else. */}
      <div className={styles.bg} aria-hidden>
        <div className={styles.bgBase} />
        <div className={`${styles.blobWrap} ${styles.blobWrap1}`}><div className={`${styles.blob} ${styles.blob1}`} /></div>
        <div className={`${styles.blobWrap} ${styles.blobWrap2}`}><div className={`${styles.blob} ${styles.blob2}`} /></div>
        <div className={`${styles.blobWrap} ${styles.blobWrap3}`}><div className={`${styles.blob} ${styles.blob3}`} /></div>
        <div className={styles.bgGrain} />
      </div>

      <header className={styles.nav}>
        <div className={styles.navInner}>
          <a className={styles.brand} href="/" onClick={go('/')}>
            <NewtMark className={styles.brandMark} />
            <span className={styles.brandName}>newt</span>
          </a>
          <nav className={styles.navLinks}>
            <a href="#features">Features</a>
            <a href="#everything">Everything else</a>
            <a href="#selfhost">Self-host</a>
            {/* Kept, because the people who want it look for it - but it points
                at a footnote near the bottom, not at a pillar. */}
          </nav>
          <div className={styles.navCta}>
            <a className={styles.ghostBtn} href="/signin" onClick={go('/signin')}>Sign in</a>
            <a className={styles.solidBtn} href="/signup" onClick={go('/signup')}>Get started</a>
          </div>
        </div>
      </header>

      <main>
        {/* ── Hero ── */}
        <section className={styles.hero}>
          <span className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            Live at newt.page · free to start
          </span>

          <h1 className={styles.h1}>
            Turn over a<br />
            <span className={styles.grad}>new tab.</span>
          </h1>

          <p className={styles.lede}>
            Your browser opens a blank page a hundred times a day. Newt puts something
            worth looking at there: the bookmarks you actually use, the feeds you follow,
            the articles you swore you’d read, and the notes you keep meaning to write.
            Sign up at <strong className={styles.domain}>newt.page</strong> and set your
            new tab to it - there’s nothing to install.
          </p>

          <div className={styles.heroCta}>
            <a className={`${styles.solidBtn} ${styles.bigBtn}`} href="/signup" onClick={go('/signup')}>
              Create your account
            </a>
            <a className={`${styles.ghostBtn} ${styles.bigBtn}`} href="/signin" onClick={go('/signin')}>
              I already have one
            </a>
          </div>

          <p className={styles.microCopy}>
            Free · Nothing to install · No ads · No trackers · No algorithm deciding what you see
          </p>

          <div className={styles.heroShot}>
            <ShotFrame shot={SHOTS.hero} tall />
          </div>
        </section>

        <Trail />

        {/* ── The pitch, in four words ── */}
        <section className={styles.nots} data-reveal>
          {[
            ['No ads.', 'Not now, not later, not "just this once".'],
            ['No trackers.', 'The only analytics are the ones you read yourself.'],
            ['No infinite scroll.', 'The page ends. On purpose.'],
            ['No suggestions.', 'You decide what turns up. Every time.'],
          ].map(([big, small]) => (
            <div className={styles.not} key={big}>
              <div className={styles.notBig}>{big}</div>
              <div className={styles.notSmall}>{small}</div>
            </div>
          ))}
        </section>

        {/* ── Feature stripes ── */}
        <div id="features">
          {FEATURES.map(f => (
            <section className={`${styles.feature} ${f.flip ? styles.featureFlip : ''}`} key={f.kicker}>
              <div className={styles.featureText} data-reveal>
                <span className={styles.kicker}>{f.kicker}</span>
                <h2 className={styles.h2}>{f.title}</h2>
                <p className={styles.body}>{f.body}</p>
                <ul className={styles.points}>
                  {f.points.map(p => (
                    <li key={p}>
                      <svg viewBox="0 0 16 16" aria-hidden><path d="m3 8.5 3.2 3.2L13 5" /></svg>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={styles.featureShot} data-reveal>
                <ShotFrame shot={f.shot} />
              </div>
            </section>
          ))}
        </div>

        <Trail count={7} />

        {/* ── Everything else ── */}
        <section className={styles.grid} id="everything">
          <div className={styles.gridHead} data-reveal>
            <span className={styles.kicker}>And the rest</span>
            <h2 className={styles.h2}>The small things you notice on day three</h2>
          </div>
          <div className={styles.cards}>
            {SMALL.map(s => (
              <div className={styles.card} key={s.title} data-reveal>
                <span className={styles.cardIcon}>{s.icon}</span>
                <h3 className={styles.cardTitle}>{s.title}</h3>
                <p className={styles.cardBody}>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── The console. Drawn, not screenshotted - it is text on a dark
              surface, which CSS renders more crisply than any capture. ── */}
        <section className={styles.consoleWrap} data-reveal>
          <div className={styles.consoleText}>
            <span className={styles.kicker}>Power tools</span>
            <h2 className={styles.h2}>
              Press <kbd className={styles.kbd}><span className={styles.kbdKey}>`</span></kbd> and
              a terminal drops in
            </h2>
            <p className={styles.body}>
              The things you end up needing mid-browse, without leaving the page: your
              public IP and where it thinks you are, a DNS lookup, a speed test. And the
              settings you’d otherwise go hunting through menus for - switch theme, jump
              to a folder, add a site, clear the cache. Type <code>help</code> if you
              forget. It’s one keystroke away from anywhere in the app.
            </p>
          </div>
          <div className={styles.console} aria-hidden>
            <div className={styles.consoleBar}>
              <span className={`${styles.dot} ${styles.dotR}`} />
              <span className={`${styles.dot} ${styles.dotY}`} />
              <span className={`${styles.dot} ${styles.dotG}`} />
            </div>
            <div className={styles.consoleBody}>
              {CONSOLE_LINES.map(([cmd, out]) => (
                <div key={cmd}>
                  <div className={styles.cmdLine}>
                    <span className={styles.prompt}>❯</span>{cmd}
                  </div>
                  <div className={styles.outLine}>{out}</div>
                </div>
              ))}
              <div className={styles.cmdLine}>
                <span className={styles.prompt}>❯</span>
                <span className={styles.caret} />
              </div>
            </div>
          </div>
        </section>

        {/* ── Self-hosting ──
            Deliberately a footnote, not a pillar: newt.page is the way in, and
            this is here for the minority who would rather run it themselves.
            It reads as an aside - one strip, small type, no screenshot. */}
        <section className={styles.selfhost} id="selfhost" data-reveal>
          <div className={styles.selfhostText}>
            <span className={styles.kicker}>For the tinkerers</span>
            <h3 className={styles.selfhostTitle}>Or run the whole thing yourself</h3>
            <p className={styles.selfhostBody}>
              Newt is open source - a React front end, an Express API and a Postgres
              database in three containers. Clone it, fill in a few environment variables,
              and bring it up on your own hardware. You don’t have to, though:{' '}
              <strong className={styles.domain}>newt.page</strong> is the same app, already
              running, with nothing for you to patch at midnight.
            </p>
          </div>
          <div className={styles.selfhostAside}>
            <pre className={styles.code}>
              <code>
                git clone …/newTab{'\n'}
                cp .env.example .env{'\n'}
                docker-compose up --build
              </code>
            </pre>
            <a
              className={styles.sourceLink}
              href="https://github.com/danieltucker/newTab"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the source on GitHub →
            </a>
          </div>
        </section>

        {/* ── Closer ── */}
        <section className={styles.closer} data-reveal>
          <NewtMark className={styles.closerMark} />
          <h2 className={styles.closerTitle}>Go on, then.</h2>
          <p className={styles.closerBody}>
            A username and a password, and <strong className={styles.domain}>newt.page</strong>{' '}
            is your new tab. Everything else you can decide later.
          </p>
          <div className={styles.heroCta}>
            <a className={`${styles.solidBtn} ${styles.bigBtn}`} href="/signup" onClick={go('/signup')}>
              Create your account
            </a>
            <a className={`${styles.ghostBtn} ${styles.bigBtn}`} href="/signin" onClick={go('/signin')}>
              Sign in
            </a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
