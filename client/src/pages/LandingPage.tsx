import {
  Band, Closer, MarketingPage, Points, SectionHead, SectionLinks, ShotFrame, Trail, chrome, useGo,
} from '../marketing/Chrome';
import { HERO_SHOT, SECTIONS } from '../marketing/sections';
import styles from './LandingPage.module.css';

// The front door, for anyone who isn't signed in. Public pages (a shared post,
// a profile, an article thread) still open directly - this is what's behind the
// bare "/" for a visitor who has never been here.
//
// Positioning: Newt is a curated homepage for the things a person already likes,
// and a way of sending traffic back to them. That's the argument the whole page
// makes, and it's what the dark band a third of the way down says outright.
// Self-hosting is real, and lives at /self-hosting - it is a footnote here
// because leading with "clone this repo" sends everyone else away to install
// Docker. Each of the six sections gets a stripe here and a page of its own.
//
// Every screenshot is a ShotFrame carrying its own spec, so the page ships
// legible and self-documenting: a frame becomes a real image by dropping a file
// in /public/shots and adding `src` to its entry in marketing/sections.ts.

interface Props {
  navigate: (to: string) => void;
  signedIn?: boolean;
}

// The three legs of the argument, on the dark band. Not features - the reason
// the features are shaped the way they are.
const CREED: [string, string][] = [
  [
    'You put it there.',
    'Every tile, every feed, every card on the page arrived because you added it. ' +
    'Nothing turns up on its own, and nothing you added quietly stops appearing.',
  ],
  [
    'It points outward.',
    'Newt is a doorway, not a destination. The best thing it can do is hand you ' +
    'straight to the people whose work you came for, and get out of the way.',
  ],
  [
    'Newest first. That’s all.',
    'Your feeds arrive in the order they were published. There is no model ' +
    'deciding which of the sites you chose has earned the top of your own page.',
  ],
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

export default function LandingPage({ navigate, signedIn }: Props) {
  const go = useGo(navigate);

  return (
    <MarketingPage title="Newt - a new tab worth opening" navigate={navigate} signedIn={signedIn}>
      {/* ══ Hero ══ */}
      <Band tone="air" className={styles.heroBand} innerClassName={styles.hero}>
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
          Sign up at <strong className={chrome.domain}>newt.page</strong> and set your
          new tab to it - there’s nothing to install.
        </p>

        <div className={`${chrome.ctaRow} ${chrome.ctaCentre} ${styles.heroCta}`}>
          <a className={`${chrome.solidBtn} ${chrome.bigBtn}`} href="/signup" onClick={go('/signup')}>
            Create your account
          </a>
          <a className={`${chrome.ghostBtn} ${chrome.bigBtn}`} href="/signin" onClick={go('/signin')}>
            I already have one
          </a>
        </div>

        <p className={styles.microCopy}>
          Free to start · Nothing to install · Works in whatever browser you already use
        </p>

        <div className={styles.heroShot}>
          <ShotFrame shot={HERO_SHOT} tall />
        </div>
      </Band>

      <Trail />

      {/* ══ The argument ══
          The page's one dark slab, and its only raised voice. Everything after
          it is a feature; this is the reason the features are shaped that way. */}
      <Band tone="deep" edge id="why">
        <div className={styles.creedHead} data-reveal>
          <span className={`${chrome.kicker}`}>Why bother</span>
          <h2 className={styles.creedTitle}>
            A homepage for the things
            <br />
            <span className={styles.grad}>you already like.</span>
          </h2>
          <p className={styles.creedLede}>
            Somewhere along the way the front page of the internet stopped being a list
            you wrote. Newt is the older idea, rebuilt: a page of your sites, your feeds,
            your saved things - and a shove out of the door toward whichever of them you
            came for.
          </p>
        </div>

        <div className={styles.creed} data-reveal-group style={{ ['--stagger' as string]: '90ms' }}>
          {CREED.map(([title, body]) => (
            <div className={styles.creedCard} key={title} data-reveal>
              <h3 className={styles.creedCardTitle}>{title}</h3>
              <p className={styles.creedCardBody}>{body}</p>
            </div>
          ))}
        </div>

        <p className={styles.pull} data-reveal>
          Supporting what <em>you</em> like - not what an algorithm has decided
          you ought to.
        </p>
      </Band>

      {/* ══ The six sections ══
          Alternating tones so the run of stripes has a pulse to it, and each one
          washed with its own section colour. */}
      <div id="features">
        {SECTIONS.map((s, i) => (
          <Band key={s.slug} tone={i % 2 ? 'soft' : 'air'} tint={s.tint} tight>
            <div className={`${styles.feature} ${s.landing.flip ? styles.featureFlip : ''}`}>
              <div className={styles.featureText} data-reveal>
                <span className={`${chrome.kicker} ${chrome.kickerTint}`}>{s.kicker}</span>
                <h2 className={chrome.h2}>{s.landing.title}</h2>
                <p className={chrome.body}>{s.landing.body}</p>
                <Points items={s.landing.points} />
                <a
                  className={styles.featureLink}
                  href={`/features/${s.slug}`}
                  onClick={go(`/features/${s.slug}`)}
                >
                  How people use {s.nav.toLowerCase()} →
                </a>
              </div>
              <div className={styles.featureShot} data-reveal>
                <ShotFrame shot={s.shot} aura />
              </div>
            </div>
          </Band>
        ))}
      </div>

      {/* ══ Where to go next ══ */}
      <Band tone="canvas" edge>
        <SectionHead
          centre
          kicker="Have a proper look"
          title="Six places to go from here"
          body="A page each, with what it does and the sort of person it’s for."
        />
        <SectionLinks navigate={navigate} />
      </Band>

      {/* ══ The console ══
          Drawn, not screenshotted - it is text on a dark surface, which CSS
          renders more crisply than any capture, on a band dark enough to make
          the terminal look like it lives there. */}
      <Band tone="deep" innerClassName={styles.consoleWrap}>
        <div data-reveal>
          <span className={chrome.kicker}>Power tools</span>
          <h2 className={chrome.h2}>
            Press <kbd className={styles.kbd}><span className={styles.kbdKey}>`</span></kbd> and
            a terminal drops in
          </h2>
          <p className={chrome.body}>
            The things you end up needing mid-browse, without leaving the page: your
            public IP and where it thinks you are, a DNS lookup, a speed test. And the
            settings you’d otherwise go hunting through menus for - switch theme, jump
            to a folder, add a site, clear the cache. Type <code>help</code> if you
            forget. It’s one keystroke away from anywhere in the app.
          </p>
        </div>

        <div className={styles.console} aria-hidden data-reveal>
          <div className={styles.consoleBar}>
            <span className={`${chrome.dot} ${chrome.dotR}`} />
            <span className={`${chrome.dot} ${chrome.dotY}`} />
            <span className={`${chrome.dot} ${chrome.dotG}`} />
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
      </Band>

      {/* ══ Everything else ══ */}
      <Band tone="air" id="everything">
        <SectionHead centre kicker="And the rest" title="The small things you notice on day three" />
        <div className={styles.cards} data-reveal-group>
          {SMALL.map(s => (
            <div className={styles.card} key={s.title} data-reveal>
              <span className={styles.cardIcon}>{s.icon}</span>
              <h3 className={styles.cardTitle}>{s.title}</h3>
              <p className={styles.cardBody}>{s.body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* ══ Self-hosting, as a footnote ══
          One line and a link. The full argument, the compose file and the
          environment variables live at /self-hosting, where the people who want
          them will look and nobody else has to scroll past them. */}
      <Band tone="air" tight>
        <div className={styles.aside} data-reveal>
          <div>
            <span className={`${chrome.kicker} ${chrome.kickerTint}`}>For the tinkerers</span>
            <h3 className={styles.asideTitle}>Or run the whole thing yourself</h3>
            <p className={styles.asideBody}>
              Newt is open source, and it’s three containers and a compose file if you’d
              rather it lived on your own hardware.
            </p>
          </div>
          <a className={chrome.ghostBtn} href="/self-hosting" onClick={go('/self-hosting')}>
            How self-hosting works →
          </a>
        </div>
      </Band>

      {/* ══ Closer ══ */}
      <Band tone="glow" edge>
        <Closer
          navigate={navigate}
          signedIn={signedIn}
          title="Go on, then."
          body={
            <>
              A username and a password, and <strong className={chrome.domain}>newt.page</strong>{' '}
              is your new tab. Everything else you can decide later.
            </>
          }
        />
      </Band>
    </MarketingPage>
  );
}
