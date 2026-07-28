import { Band, Closer, MarketingPage, SectionHead, chrome, useGo } from '../marketing/Chrome';
import styles from './SelfHostPage.module.css';

// Self-hosting, moved off the landing page and given a room of its own.
//
// It used to be a strip near the bottom of "/", which was the wrong size in both
// directions: too much for the visitor who only wanted a new tab, and far too
// little for the person who actually intends to run it. Here it can be honest -
// including about the parts that are work - and the landing page gets one line
// and a link.
//
// Deliberately steel-coloured rather than one of the six section tints: this is
// not a seventh feature, it's a different question.
const TINT = '#9AA7C7';

const STACK: { name: string; role: string; note: string }[] = [
  { name: 'client', role: 'React + Vite, served by nginx', note: 'Static build. Nothing in it is user-specific.' },
  { name: 'server', role: 'Express + Prisma, on Node', note: 'The API, the feed fetcher and the auth.' },
  { name: 'db', role: 'PostgreSQL 17', note: 'One volume. This is the thing to back up.' },
];

const STEPS: { cmd: string; body: string }[] = [
  { cmd: 'git clone …/newTab', body: 'The whole thing, client and server, in one repository.' },
  { cmd: 'cp .env.example .env', body: 'Database URL, JWT secrets, the origin you’ll serve it from. The example file lists every key with a comment.' },
  { cmd: 'docker compose up --build', body: 'Three containers. Prisma applies the migrations on start; the first account you register is the administrator.' },
];

// The honest half. A hosting pitch that only lists upsides is a pitch you
// distrust by the third bullet.
const YOURS: { title: string; body: string }[] = [
  {
    title: 'Backups',
    body:
      'One Postgres volume holds every bookmark, note and post. Nobody is taking a copy of it ' +
      'for you, and the day you find that out should not be the day you needed one.',
  },
  {
    title: 'Certificates and a domain',
    body:
      'Newt expects to be behind HTTPS - cookies are set secure, and the origin is checked. ' +
      'A reverse proxy with automatic certificates is the short version of this job.',
  },
  {
    title: 'Updates',
    body:
      'New versions land as commits. Pulling and rebuilding is a minute of your evening, but ' +
      'it is your evening, and skipping it for eight months is how upgrades get exciting.',
  },
  {
    title: 'Being the administrator',
    body:
      'Reports from your users arrive in a queue that only you can see. If other people use ' +
      'your instance, moderation is a chair you have agreed to sit in.',
  },
];

const COMPARE: { row: string; hosted: string; self: string }[] = [
  { row: 'Getting started', hosted: 'A username and a password', self: 'A machine, a domain and an evening' },
  { row: 'Updates', hosted: 'Already done', self: 'git pull, when you feel like it' },
  { row: 'Backups', hosted: 'Ours to worry about', self: 'Yours to worry about' },
  { row: 'Your data', hosted: 'On our Postgres', self: 'On your disk, in your building' },
  { row: 'Changing it', hosted: 'Ask, and maybe', self: 'It’s your fork now' },
];

interface Props {
  navigate: (to: string) => void;
  signedIn?: boolean;
}

const REPO = 'https://github.com/danieltucker/newTab';

export default function SelfHostPage({ navigate, signedIn }: Props) {
  const go = useGo(navigate);

  return (
    <MarketingPage
      title="Self-hosting Newt"
      tint={TINT}
      navigate={navigate}
      active="self-hosting"
      signedIn={signedIn}
    >
      {/* ══ Hero ══ */}
      <Band tone="glow" className={styles.heroBand} innerClassName={styles.hero}>
        <div className={styles.heroText}>
          <a className={styles.back} href="/" onClick={go('/')}>← Everything Newt does</a>
          <span className={`${chrome.kicker} ${chrome.kickerTint} ${styles.heroKicker}`}>Self-hosting</span>
          <h1 className={styles.h1}>Run the whole thing yourself</h1>
          <p className={styles.lede}>
            Newt is open source. It’s a React front end, an Express API and a Postgres database,
            and it comes up with one compose file. If you’d rather your bookmarks, notes and
            posts lived on hardware you can put a hand on, this page is how.
          </p>
          <p className={styles.ledeNote}>
            You don’t have to. <strong className={chrome.domain}>newt.page</strong> is the same
            app, already running, with nothing for you to patch at midnight.
          </p>
          <div className={`${chrome.ctaRow} ${styles.heroCta}`}>
            <a className={`${chrome.solidBtn} ${chrome.bigBtn}`} href={REPO} target="_blank" rel="noopener noreferrer">
              Read the source on GitHub
            </a>
            {!signedIn && (
              <a className={`${chrome.ghostBtn} ${chrome.bigBtn}`} href="/signup" onClick={go('/signup')}>
                Or just use newt.page
              </a>
            )}
          </div>
        </div>

        <div className={styles.terminal} aria-hidden>
          <div className={styles.terminalBar}>
            <span className={`${chrome.dot} ${chrome.dotR}`} />
            <span className={`${chrome.dot} ${chrome.dotY}`} />
            <span className={`${chrome.dot} ${chrome.dotG}`} />
          </div>
          <pre className={styles.terminalBody}>
            <code>
              <span className={styles.prompt}>❯</span> git clone …/newTab{'\n'}
              <span className={styles.prompt}>❯</span> cd newTab{'\n'}
              <span className={styles.prompt}>❯</span> cp .env.example .env{'\n'}
              <span className={styles.prompt}>❯</span> docker compose up --build{'\n'}
              <span className={styles.out}>{'\n'}  client   ready on :80{'\n'}  server   listening on :3001{'\n'}  db       database system is ready{'\n'}</span>
            </code>
          </pre>
        </div>
      </Band>

      {/* ══ The stack ══ */}
      <Band tone="deep" edge>
        <SectionHead
          centre
          kicker="What it is"
          title="Three containers, one file"
          body="No queue, no cache, no object store, no message bus. It is a small application and it is deployed like one."
        />
        <div className={styles.stack} data-reveal-group style={{ ['--stagger' as string]: '90ms' }}>
          {STACK.map(s => (
            <div className={styles.stackCard} key={s.name} data-reveal>
              <code className={styles.stackName}>{s.name}</code>
              <h3 className={styles.stackRole}>{s.role}</h3>
              <p className={styles.stackNote}>{s.note}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* ══ Bringing it up ══ */}
      <Band tone="canvas">
        <SectionHead kicker="Bringing it up" title="Four commands, in the order you’d guess" tintKicker />
        <ol className={styles.steps} data-reveal-group>
          {STEPS.map((s, i) => (
            <li className={styles.step} key={s.cmd} data-reveal>
              <span className={styles.stepNum}>{i + 1}</span>
              <div>
                <code className={styles.stepCmd}>{s.cmd}</code>
                <p className={styles.stepBody}>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className={styles.footnote} data-reveal>
          A note on ARM: the server uses Prisma’s pure-JavaScript Postgres adapter rather than
          the Rust engine, which is what makes it come up on ARM64 machines - a Pi, an Apple
          silicon Mac, a cheap ARM VPS - without a fight.
        </p>
      </Band>

      {/* ══ What you're taking on ══ */}
      <Band tone="air">
        <SectionHead
          kicker="The honest part"
          title="Four things that become yours"
          body="None of these are hard. All of them are work, and it’s better to read them now than to discover them in a year."
          tintKicker
        />
        <div className={styles.yours} data-reveal-group>
          {YOURS.map(y => (
            <div className={styles.yoursCard} key={y.title} data-reveal>
              <h3 className={styles.yoursTitle}>{y.title}</h3>
              <p className={styles.yoursBody}>{y.body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* ══ Which one ══ */}
      <Band tone="soft">
        <SectionHead centre kicker="Which one" title="The same app, two different jobs" tintKicker />
        <div className={styles.tableWrap} data-reveal>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col"><span className={styles.srOnly}>Concern</span></th>
                <th scope="col">newt.page</th>
                <th scope="col">Your machine</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(c => (
                <tr key={c.row}>
                  <th scope="row">{c.row}</th>
                  <td>{c.hosted}</td>
                  <td>{c.self}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.footnote} data-reveal>
          The accounts are not linked. If you start on newt.page and move to your own instance
          later, export your bookmarks and import them the same way you would from a browser.
        </p>
      </Band>

      {/* ══ Closer ══ */}
      <Band tone="glow" edge>
        <Closer
          navigate={navigate}
          signedIn={signedIn}
          title="Or skip all that."
          body={
            <>
              The code isn’t going anywhere. If you’d rather have the new tab today,{' '}
              <strong className={chrome.domain}>newt.page</strong> takes about a minute.
            </>
          }
        />
      </Band>
    </MarketingPage>
  );
}
