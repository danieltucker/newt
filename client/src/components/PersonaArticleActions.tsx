import { useState, useEffect, useRef } from 'react';
import {
  Persona, loadPersonaContext, personaComment, personaAngles, personaPost,
} from '../services/personas';
import { apiErrorText } from '../services/api';
import PersonaBadge from './PersonaBadge';
import styles from './PersonaArticleActions.module.css';

/**
 * The admin control on an article: have a persona comment on it, offer angles
 * on it, or write a post about it.
 *
 * Renders nothing at all for a non-admin, which is almost everybody — the
 * persona list comes back empty for them (see loadPersonaContext), so this
 * costs an ordinary reader one memoised request per session and no pixels.
 *
 * **The three verbs land differently, and the UI has to say so.** A comment and
 * an angles card are both posted publicly and immediately, into the thread below.
 * A post is created as a *draft* under the persona's name and goes nowhere until
 * somebody opens and publishes it. That asymmetry is a server decision
 * (routes/adminPersonas.ts); this component's job is to make sure an admin is
 * never surprised by which one they just got, which is why the result line names
 * the outcome rather than saying "done".
 *
 * Angles is the verb to reach for by default. It puts a short list of open
 * questions in the thread, each one a link that opens Explore already asking it —
 * which is a thing only software would post, and reads as such. Comment is the
 * one that puts an opinion under a name, so it is the one worth thinking about
 * before pressing.
 */

interface Props {
  url: string;
  title: string;
  /** Reload the comment thread after a persona comments. */
  onCommented?: () => void;
}

type Verb = 'comment' | 'angles' | 'post';

/** What each verb does, said before it is done rather than after. */
const MENU_NOTES: Record<Verb, string> = {
  comment: 'Posts a public comment straight away.',
  angles: 'Posts a public card of questions, each one an Explore link.',
  post: 'Creates a draft post. Nothing is published.',
};

export default function PersonaArticleActions({ url, title, onCommented }: Props) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState<Verb | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPersonaContext().then(ctx => {
      if (cancelled) return;
      setPersonas(ctx.personas);
      setReady(ctx.ready);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(verb: Verb, p: Persona) {
    setBusy(true);
    setError('');
    setResult('');
    try {
      if (verb === 'comment') {
        await personaComment(p.id, url, title);
        setResult(`${p.user.displayName} commented.`);
        onCommented?.();
      } else if (verb === 'angles') {
        const { angles } = await personaAngles(p.id, url, title);
        // The count, because it is the one thing the admin cannot see without
        // scrolling to the thread, and a card of two is a different result from
        // a card of four.
        setResult(`${p.user.displayName} posted ${angles.length} ${angles.length === 1 ? 'angle' : 'angles'}.`);
        onCommented?.();
      } else {
        const post = await personaPost(p.id, url);
        // Named as a draft, with where it went: the admin has to know this is
        // not live and know where to find it.
        setResult(`Draft “${post.title}” saved to @${p.user.username}.`);
      }
      setOpen(null);
    } catch (e) {
      setError(apiErrorText(e, 'Generation failed.'));
    } finally {
      setBusy(false);
    }
  }

  if (personas.length === 0) return null;

  const menuFor = (verb: Verb) => (
    <div className={styles.menu} role="menu">
      <div className={styles.menuNote}>
        {MENU_NOTES[verb]}
      </div>
      {personas.map(p => (
        <button
          key={p.id}
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => void run(verb, p)}
          disabled={busy}
        >
          <span className={styles.menuName}>{p.user.displayName}</span>
          <span className={styles.menuHandle}>@{p.user.username}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <span className={styles.label}>
        Personas
        {/* The disclosure, again, on the control itself. An admin about to speak
            as one of these accounts should be looking at what readers will see —
            hence the shared component rather than a local span. */}
        <PersonaBadge />
      </span>

      <span className={styles.slot}>
        <button
          type="button"
          className={styles.btn}
          disabled={!ready || busy}
          aria-expanded={open === 'comment'}
          onClick={() => setOpen(o => (o === 'comment' ? null : 'comment'))}
          title={ready ? 'Have a persona comment on this article' : 'No instance model is configured'}
        >
          {busy && open === 'comment' ? 'Writing…' : 'Comment'}
        </button>
        {open === 'comment' && menuFor('comment')}
      </span>

      <span className={styles.slot}>
        <button
          type="button"
          className={styles.btn}
          disabled={!ready || busy}
          aria-expanded={open === 'angles'}
          onClick={() => setOpen(o => (o === 'angles' ? null : 'angles'))}
          title={ready ? 'Have a persona suggest where to take this article' : 'No instance model is configured'}
        >
          {busy && open === 'angles' ? 'Reading…' : 'Angles'}
        </button>
        {open === 'angles' && menuFor('angles')}
      </span>

      <span className={styles.slot}>
        <button
          type="button"
          className={styles.btn}
          disabled={!ready || busy}
          aria-expanded={open === 'post'}
          onClick={() => setOpen(o => (o === 'post' ? null : 'post'))}
          title={ready ? 'Have a persona draft a post about this article' : 'No instance model is configured'}
        >
          {busy && open === 'post' ? 'Writing…' : 'Draft a post'}
        </button>
        {open === 'post' && menuFor('post')}
      </span>

      {result && <span className={styles.result}>{result}</span>}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
