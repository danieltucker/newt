import {
  Band, Closer, MarketingPage, Points, SectionHead, SectionLinks, ShotFrame, chrome, useGo,
} from '../marketing/Chrome';
import type { Section } from '../marketing/sections';
import styles from './FeaturePage.module.css';

// One page per section of the app - six of them, all rendered from this file and
// the data in marketing/sections.ts. They exist because the landing page can
// only give each section a paragraph, and a paragraph can say what a thing is
// but not who it's for.
//
// The shape is the same every time so the six read as a set: what it is, how it
// goes, the one sentence worth remembering, three people who use it, the small
// print, and a way through to the other five. What changes is the colour - the
// section's tint drives the hero glow, the kickers, the step numbers, the tick
// marks and the aura behind the screenshot, so the page is recognisably about
// Feeds and not about Notes before a word has been read.

interface Props {
  section: Section;
  navigate: (to: string) => void;
  signedIn?: boolean;
}

export default function FeaturePage({ section, navigate, signedIn }: Props) {
  const go = useGo(navigate);
  const { page } = section;

  return (
    <MarketingPage
      title={`${section.nav} - Newt`}
      tint={section.tint}
      navigate={navigate}
      active={section.slug}
      signedIn={signedIn}
    >
      {/* ══ Hero ══ */}
      <Band tone="glow" className={styles.heroBand} innerClassName={styles.hero}>
        <div className={styles.heroText}>
          <a className={styles.back} href="/" onClick={go('/')}>← Everything Newt does</a>
          <span className={`${chrome.kicker} ${chrome.kickerTint} ${styles.heroKicker}`}>{section.kicker}</span>
          <h1 className={styles.h1}>{page.title}</h1>
          <p className={styles.lede}>{page.lede}</p>
          <Points items={section.landing.points} />
          <div className={`${chrome.ctaRow} ${styles.heroCta}`}>
            {signedIn ? (
              <a className={`${chrome.solidBtn} ${chrome.bigBtn}`} href="/" onClick={go('/')}>Open Newt</a>
            ) : (
              <>
                <a className={`${chrome.solidBtn} ${chrome.bigBtn}`} href="/signup" onClick={go('/signup')}>
                  Create your account
                </a>
                <a className={`${chrome.ghostBtn} ${chrome.bigBtn}`} href="/signin" onClick={go('/signin')}>
                  Sign in
                </a>
              </>
            )}
          </div>
        </div>

        <div className={styles.heroShot}>
          <ShotFrame shot={section.shot} aura />
        </div>
      </Band>

      {/* ══ How it goes ══ */}
      <Band tone="canvas" edge>
        <SectionHead centre kicker="How it goes" title="Three steps, and two of them are optional" tintKicker />
        <ol className={styles.steps} data-reveal-group style={{ ['--stagger' as string]: '90ms' }}>
          {page.steps.map((s, i) => (
            <li className={styles.step} key={s.title} data-reveal>
              <span className={styles.stepNum}>{i + 1}</span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
            </li>
          ))}
        </ol>
      </Band>

      {/* ══ The one sentence ══
          A whole band for a single line. It is the most expensive thing on the
          page per word, which is the point - it's what a reader takes away. */}
      <Band tone="deep">
        <p className={styles.statement} data-reveal>{page.statement}</p>
      </Band>

      {/* ══ Who it's for ══ */}
      <Band tone="air">
        <SectionHead
          centre
          tintKicker
          kicker="In practice"
          title="Three people who’d be glad of it"
          body="Not personas. Just the situations this part of Newt was built around."
        />
        <div className={styles.cases} data-reveal-group>
          {page.useCases.map(c => (
            <article className={styles.case} key={c.who} data-reveal>
              <h3 className={styles.caseWho}>{c.who}</h3>
              <p className={styles.caseProblem}>{c.problem}</p>
              <p className={styles.caseAnswer}>{c.answer}</p>
            </article>
          ))}
        </div>
      </Band>

      {/* ══ The small print ══ */}
      <Band tone="soft">
        <SectionHead kicker="The details" title="Things worth knowing" tintKicker />
        <div className={styles.details} data-reveal-group>
          {page.details.map(d => (
            <div className={styles.detail} key={d.title} data-reveal>
              <h3 className={styles.detailTitle}>{d.title}</h3>
              <p className={styles.detailBody}>{d.body}</p>
            </div>
          ))}
        </div>
      </Band>

      {/* ══ The other five ══ */}
      <Band tone="air" tint="#9B8CFF">
        <SectionHead centre kicker="The rest of it" title="Newt is five other things as well" />
        <SectionLinks navigate={navigate} exclude={section.slug} />
      </Band>

      {/* ══ Closer ══ */}
      <Band tone="glow" edge>
        <Closer
          navigate={navigate}
          signedIn={signedIn}
          title="Put it on your new tab."
          body={
            <>
              {section.nav} is one part of it. The rest arrives with the account, at{' '}
              <strong className={chrome.domain}>newt.page</strong>.
            </>
          }
        />
      </Band>
    </MarketingPage>
  );
}
