import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ResearchThread, ResearchMessage, ResearchSource,
  listThreads, getThread, startThread, renameThread, deleteThread, condenseThread,
  streamResearchReply, apiErrorText,
} from '../services/llm';
import { apiGet, apiPost } from '../services/api';
import { blogEditPathFor } from '../utils/blogUrl';
import { explorePathFor } from '../utils/researchUrl';
import { MAX_REFERENCES, referenceCommandAt, referenceSuggestions } from '../utils/referenceCommand';
import { EmbedData } from '../utils/noteEmbed';
import { relTime } from '../utils/notifications';
import { faviconUrl } from '../utils/color';
import { useFeedSearch } from '../hooks/useFeedSearch';
import { useMediaQuery } from '../hooks/useMediaQuery';
import NewtMark from '../components/NewtMark';
import ExploreShareModal from '../components/ExploreShareModal';
import styles from './ResearchPage.module.css';

/**
 * Explore: a conversation with your own model, kept.
 *
 * Called Research until v1.17.0, and the rename was the honest one — you are
 * not conducting research, you are asking for more about something you just
 * read. Everything below the surface still says research: this file, the API
 * routes, the tables. Only what a reader sees changed.
 *
 * Threads are the unit. One starts from a question typed here or from an
 * Explore button on an article, and it lives in the sidebar until deleted —
 * which is the whole point of it being a page rather than a panel. A thread you
 * cannot come back to is a chat window, and there are plenty of those.
 *
 * The condense button turns a thread into a private draft post and drops the
 * author into the composer with it. It is the reason the transcript is worth
 * keeping: the conversation is the working-out, and the post is what comes of
 * it.
 */

interface Props {
  navigate: (to: string, replace?: boolean) => void;
  /** Deep link: open this thread on mount. */
  threadId?: string | null;
  /**
   * Start a new thread, from `?url=` (an article's Explore button) or `?q=`
   * (the search bar's /ask). Each distinct seed is consumed exactly once — see
   * the effect that reads it, and why "once per mount" was the wrong rule.
   */
  seed?: { question: string; url?: string } | null;
  /**
   * Articles to attach to the next question, from `?ref=` — the search bar's
   * /reference. Unlike `seed` this asks nothing: it fills the composer's
   * attachment row and waits for a question to be typed.
   */
  seedRefs?: string[];
  /**
   * What /reference can point at, in the same shape the editor's picker takes
   * (see utils/noteEmbed): saved articles and your own posts. Deliberately the
   * same corpus and the same command, because it is the same sentence — "this
   * one, the piece I mean" — said to a note in one place and to a model in the
   * other.
   *
   * The feed archive is searched on the server alongside it: it is too large to
   * hold in the page, and it is the half a reader is least likely to have
   * already filed anywhere.
   */
  references?: EmbedData[];
  /** False while the account has no model connected — the page says so instead. */
  hasModel: boolean;
  onOpenSettings: () => void;
  /**
   * Opens the article reader (text, comments) over the page. Undefined only in
   * a context that has no reader to open, in which case the source card falls
   * back to linking out to the publisher.
   */
  onOpenArticle?: (url: string) => void;
}

/** A turn that is still arriving. Not a ResearchMessage until the server saves it. */
interface Streaming {
  text: string;
  error: string | null;
  /** Articles from the reader's own feed that were pulled in for this answer. */
  sources: ResearchSource[];
}

/** What /api/v1/articles knows about the URL a thread started from. */
interface SourceArticle {
  title: string;
  source: string;
  pubDate: string | null;
  readTime: number | null;
  snippet: string | null;
  imageUrl: string | null;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Hide an image that 404s rather than leaving a broken-image glyph behind. */
function hideBroken(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).style.display = 'none';
}

/**
 * The article a thread started from, as the card it deserves.
 *
 * The link back used to be one line of grey text under the title, which was
 * strictly less than the app already knew: there is a hero image, a standfirst,
 * a publisher, a date, and a comment thread of your own. Six weeks later the
 * question "what was this about?" is answered by the picture faster than by the
 * URL, so the picture is here — and the whole card opens the reader, which is
 * where the text and the comments are.
 *
 * Both requests fail quietly. A thread whose source article has since dropped
 * out of the feed still shows its title and still links out; a card that could
 * not be enriched is not a reason to break the conversation above it.
 */
function SourceCard({ url, title, onOpen }: {
  url: string;
  title: string;
  onOpen?: (url: string) => void;
}) {
  const [article, setArticle] = useState<SourceArticle | null>(null);
  const [comments, setComments] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArticle(null);
    setComments(null);
    apiGet<{ article: SourceArticle | null }>(`/api/v1/articles?url=${encodeURIComponent(url)}`)
      .then(d => { if (!cancelled) setArticle(d.article ?? null); })
      .catch(() => {});
    apiPost<{ counts: Record<string, number> }>('/api/v1/comments/counts', { urls: [url] })
      .then(d => { if (!cancelled) setComments(d.counts?.[url] ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  const domain = domainOf(url);
  const heading = article?.title || title || domain || url;
  const source = article?.source || domain;
  const image = article?.imageUrl || null;
  const meta = [
    shortDate(article?.pubDate),
    article?.readTime != null ? `${article.readTime} min read` : '',
  ].filter(Boolean);
  const open = onOpen ? () => onOpen(url) : null;

  return (
    <aside className={styles.card}>
      <span className={styles.cardRail} aria-hidden />

      {image && (
        open ? (
          <button className={styles.cardThumb} onClick={open} aria-label={`Read ${heading}`}>
            <img src={image} alt="" referrerPolicy="no-referrer" onError={hideBroken} />
          </button>
        ) : (
          <a className={styles.cardThumb} href={url} target="_blank" rel="noopener noreferrer">
            <img src={image} alt="" referrerPolicy="no-referrer" onError={hideBroken} />
          </a>
        )
      )}

      <div className={styles.cardBody}>
        <div className={styles.cardKicker}>
          <span className={styles.cardKickerLabel}>Exploring</span>
          {domain && (
            <img className={styles.cardFavicon} src={faviconUrl(domain)} alt="" onError={hideBroken} />
          )}
          {source && <span className={styles.cardSource}>{source}</span>}
          {meta.map(bit => (
            <span key={bit}>
              <span className={styles.cardDot}>·</span> {bit}
            </span>
          ))}
        </div>

        {open
          ? <button className={styles.cardTitle} onClick={open}>{heading}</button>
          : (
            <a className={styles.cardTitle} href={url} target="_blank" rel="noopener noreferrer">
              {heading}
            </a>
          )}

        {article?.snippet && <p className={styles.cardSnippet}>{article.snippet}</p>}

        <div className={styles.cardActions}>
          {open && (
            <button className={styles.cardAction} onClick={open}>
              Read it here
            </button>
          )}
          {open && comments !== null && comments > 0 && (
            <button className={styles.cardAction} onClick={open}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              {comments} comment{comments === 1 ? '' : 's'}
            </button>
          )}
          <a className={styles.cardAction} href={url} target="_blank" rel="noopener noreferrer">
            Open original
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
      </div>
    </aside>
  );
}

/**
 * The feed articles an answer was given, as things you can go and read.
 *
 * These were a row of one-line chips linking out to the publisher, which
 * undersold them twice over. They are articles from your own subscriptions, so
 * Newt has the text and the comment thread and can open both in the reader —
 * and the answer citing them is usually the moment you most want to read one.
 * Sending you to the publisher's site instead was the long way round to a place
 * you already were.
 *
 * The list is stored with the message now (see the sources column), so it is
 * still here on a thread opened next month rather than vanishing when the
 * stream ends — which is exactly when a citation stops being decoration and
 * starts being the thing you came back to check.
 */
function FeedSources({ sources, onOpen }: {
  sources: ResearchSource[];
  onOpen?: (url: string) => void;
}) {
  if (sources.length === 0) return null;

  return (
    <div className={styles.sources}>
      <span className={styles.sourcesLabel}>
        Read {sources.length} article{sources.length === 1 ? '' : 's'} from your feed
      </span>
      <div className={styles.sourceGrid}>
        {sources.map(s => {
          const domain = domainOf(s.url);
          const when = shortDate(s.pubDate);
          // The card opens the reader where there is one. Where there isn't,
          // the same card is a plain link out — the affordance stays put and
          // only the destination changes.
          const inner = (
            <>
              <span className={styles.feedCardKicker}>
                {domain && (
                  <img className={styles.feedCardFavicon} src={faviconUrl(domain)} alt="" onError={hideBroken} />
                )}
                <span className={styles.feedCardSource}>{s.source || domain}</span>
                {when && <><span className={styles.cardDot}>·</span><span>{when}</span></>}
              </span>
              <span className={styles.feedCardTitle}>{s.title || s.url}</span>
            </>
          );

          return onOpen ? (
            <button
              key={s.url}
              className={styles.feedCard}
              onClick={() => onOpen(s.url)}
              title={s.title}
            >
              {inner}
            </button>
          ) : (
            <a
              key={s.url}
              className={styles.feedCard}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.title}
            >
              {inner}
            </a>
          );
        })}
      </div>
    </div>
  );
}

/**
 * How many articles one question may carry. Shared with the other boxes that
 * take /reference, and matching the server's own ceiling — see MAX_REFS in
 * routes/research.ts, which is the one that actually binds.
 */
const MAX_REFS = MAX_REFERENCES;

/** Below this Explore is one column, and the thread list is a screen of its own. */
const EXPLORE_NARROW = '(max-width: 860px)';

/**
 * The articles a question attached with /reference, under the question.
 *
 * Distinct from FeedSources above, which is what the *model* went and found.
 * These are what the reader put in front of it, so they are labelled as such and
 * sit under the question rather than over the answer: a citation and an
 * instruction look alike on the page and are not the same claim.
 */
function AttachedRefs({ refs, onOpen, onRemove }: {
  refs: ResearchSource[];
  onOpen?: (url: string) => void;
  onRemove?: (url: string) => void;
}) {
  if (refs.length === 0) return null;

  return (
    <div className={styles.refRow}>
      <span className={styles.refRowLabel}>
        {onRemove ? 'Attached' : `Referenced ${refs.length === 1 ? 'article' : 'articles'}`}
      </span>
      {refs.map(r => {
        const domain = domainOf(r.url);
        return (
          <span key={r.url} className={styles.refChip}>
            <img className={styles.refChipFavicon} src={faviconUrl(domain)} alt="" onError={hideBroken} />
            {/* A chip opens the reader where there is one to open. On the
                composer's own row it doesn't: that row is being edited, and a
                click that navigates away mid-question is the wrong default. */}
            {onOpen && !onRemove ? (
              <button className={styles.refChipTitle} onClick={() => onOpen(r.url)} title={r.title}>
                {r.title || domain || r.url}
              </button>
            ) : (
              <span className={styles.refChipTitle} title={r.title}>{r.title || domain || r.url}</span>
            )}
            {onRemove && (
              <button
                className={styles.refChipRemove}
                onClick={() => onRemove(r.url)}
                aria-label={`Remove ${r.title || domain}`}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Openers for a page with nothing on it yet.
 *
 * Real questions, not templates: a chip sends the moment it is clicked, so
 * "explain something everyone assumes I already know" would be a question the
 * model has to guess the subject of. They also have to be questions this can
 * actually answer — an earlier draft offered "what happened this week in what I
 * follow?", which reads perfectly and cannot work: the feed is searched by
 * keyword, and that question has no keywords in it to search for.
 */
const STARTERS = [
  'Explain how large language models actually work',
  'What is the strongest case against nuclear power?',
  'What changed in web browsers over the last year?',
  'Give me a reading list on the history of the internet',
];

export default function ResearchPage({
  navigate, threadId, seed, seedRefs, references = [], hasModel, onOpenSettings, onOpenArticle,
}: Props) {
  const [threads, setThreads] = useState<ResearchThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(threadId ?? null);
  const [messages, setMessages] = useState<ResearchMessage[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [condensing, setCondensing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /** Articles attached to the question being typed. Cleared when it is sent. */
  const [refs, setRefs] = useState<ResearchSource[]>([]);
  /**
   * Which half of the page a narrow screen is showing.
   *
   * Explore is a two-column app that has to become a one-column one, and the
   * off-canvas drawer this used to be was the wrong answer twice over: it put a
   * second hamburger in a bar that already had one, and it had no way to close
   * — the button that opened it was behind the panel it opened. So the two
   * columns become two screens, with the list as the way back, which is what
   * every other list-and-detail pair on a phone does.
   *
   * Ignored entirely above EXPLORE_NARROW, where both columns are on screen and
   * there is nothing to choose between.
   */
  const [pane, setPane] = useState<'list' | 'chat'>(threadId ? 'chat' : 'list');
  const narrow = useMediaQuery(EXPLORE_NARROW);
  // What the last answer cost, in dollars. Null when the model has no known
  // price — a self-hosted endpoint, or one Newt doesn't have in its catalogue.
  const [lastCost, setLastCost] = useState<number | null>(null);

  // The live stream's cancel function. Held in a ref rather than state because
  // nothing renders from it and replacing it must not schedule a render.
  const cancelRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The seed already acted on, as a string, rather than a "have I seeded yet"
   * boolean.
   *
   * The boolean was the bug behind /ask doing nothing from inside Explore. The
   * page is already mounted there, so asking again only changes the query
   * string — no remount, the flag is still set from the first time, and the new
   * question is silently dropped. It looked like /ask was broken and worked
   * after a reload, because a reload is the one thing that clears the flag.
   *
   * Keyed on the seed's content instead, a second question is a second seed and
   * fires. Asking the *same* question twice in a row still won't, which is the
   * right call: that is what re-rendering on an unchanged URL looks like, and
   * the composer is there for anyone who genuinely wants it asked twice.
   */
  const seededRef = useRef<string | null>(null);
  /** The same once-per-content rule, for the articles arriving on `?ref=`. */
  const seededRefsRef = useRef<string | null>(null);

  const active = threads.find(t => t.id === activeId) ?? null;

  // The share dialog belongs to one conversation. Leaving it open across a
  // switch would show one thread's transcript above another thread's controls.
  useEffect(() => { setSharing(false); }, [activeId]);

  // ── References ────────────────────────────────────────────────────────────

  /**
   * What the composer is currently searching for, or null when it holds an
   * ordinary question. `/reference` on its own is the empty string, which opens
   * the picker with nothing in it yet rather than leaving it closed.
   *
   * Read from the end of the draft rather than the start of it: this is a
   * question box, and "what caused /reference" is how a question that needs a
   * citation actually gets typed. See referenceCommandAt.
   */
  const refCmd = referenceCommandAt(draft);
  const refTerm = refCmd?.query ?? null;
  const refRest = refCmd?.rest ?? '';
  const refHits = useFeedSearch(refTerm ?? '');

  const attachRef = useCallback((source: ResearchSource) => {
    setRefs(prev => (
      prev.length >= MAX_REFS || prev.some(r => r.url === source.url) ? prev : [...prev, source]
    ));
    // The command has done its job, so it comes back out of the composer - it
    // would otherwise be sent to the model as part of what was asked. Only the
    // command: the question it was appended to stays put, with a space to carry
    // on typing after.
    setDraft(refRest ? `${refRest} ` : '');
    inputRef.current?.focus();
  }, [refRest]);

  const detachRef = useCallback((url: string) => {
    setRefs(prev => prev.filter(r => r.url !== url));
  }, []);

  /**
   * The articles the picker is offering — see referenceSuggestions, which is
   * the same list the newt button's Ask field offers, ranked the same way.
   *
   * A date is the one thing a suggestion has no cheap way to know, so the
   * ResearchSource it becomes carries none. The chip it turns into doesn't show
   * one either, and the server resolves the article properly on send.
   */
  const refSuggestions = useMemo<ResearchSource[]>(
    () => referenceSuggestions(refTerm ?? '', references, refHits, refs.map(r => r.url))
      .map(s => ({ ...s, pubDate: null })),
    [refTerm, refHits, references, refs],
  );

  // ── Loading ───────────────────────────────────────────────────────────────

  const loadThreads = useCallback(async () => {
    try {
      const { threads: list } = await listThreads();
      setThreads(list);
      return list;
    } catch {
      setError('Could not load your threads.');
      return [];
    }
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const openThread = useCallback(async (id: string) => {
    // Whatever was streaming belonged to the thread being left.
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(null);
    setActiveId(id);
    setLastCost(null);
    setError(null);
    setPane('chat');
    // Keeps the address bar honest about which thread is open, so reloading or
    // sharing gets you this one. `navigate` no-ops when the URL already matches,
    // which is the case when this ran *because* of the URL changing.
    navigate(explorePathFor(id));
    try {
      const { messages: msgs } = await getThread(id);
      setMessages(msgs);
    } catch {
      setError('Could not open that thread.');
      setMessages([]);
    }
  }, [navigate]);

  useEffect(() => {
    if (threadId && threadId !== activeId) openThread(threadId);
    // activeId is deliberately not a dependency: this reacts to the URL
    // changing, not to the page opening a thread of its own accord.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, openThread]);

  // ── Asking ────────────────────────────────────────────────────────────────

  /** Stream the next assistant turn into `streaming`, then fold it into the list. */
  const runReply = useCallback((id: string, question?: string, refUrls: string[] = []) => {
    setStreaming({ text: '', error: null, sources: [] });
    cancelRef.current = streamResearchReply(id, question, refUrls, {
      onDelta: (text) => setStreaming(prev => (
        prev ? { ...prev, text: prev.text + text } : { text, error: null, sources: [] }
      )),
      onSources: (sources) => setStreaming(prev => (
        prev ? { ...prev, sources } : { text: '', error: null, sources }
      )),
      // What the server made of the attachments, which is not always what was
      // sent: a URL it has no record of resolves to nothing. Written back over
      // the optimistic question so the chips under it stop claiming an article
      // the model never actually saw.
      onReferences: (references) => setMessages(prev => {
        const last = prev.length - 1;
        if (last < 0 || prev[last].role !== 'user') return prev;
        return prev.map((m, i) => (i === last ? { ...m, sources: references } : m));
      }),
      onError: (message) => setStreaming(prev => ({
        text: prev?.text ?? '', error: message, sources: prev?.sources ?? [],
      })),
      onDone: (payload) => {
        cancelRef.current = null;
        setStreaming(null);
        if (payload.message) setMessages(prev => [...prev, payload.message!]);
        // Kept out of the message list because it isn't part of the answer: it
        // describes the request that produced it, and it applies to the most
        // recent turn only.
        setLastCost(typeof payload.costUsd === 'number' ? payload.costUsd : null);
        // The thread's updatedAt just changed, which is what the sidebar sorts
        // on — and its title may have been set from the first question.
        loadThreads();
      },
    });
  }, [loadThreads]);

  /**
   * Send a question.
   *
   * `fresh` forces a new thread instead of a follow-up in whatever is open. A
   * seed always sets it: arriving at /explore?q= or ?url= means "start
   * something", and the thread on screen is whatever you happened to be reading
   * before — appending to that would file a question about one article inside a
   * conversation about another.
   */
  const ask = useCallback(async (
    question: string,
    opts?: { url?: string; fresh?: boolean; refs?: ResearchSource[] },
  ) => {
    const text = question.trim();
    const { url, fresh = false, refs: attached = [] } = opts ?? {};
    if (!text) return;
    // A seed outranks an answer already in flight — the reader has navigated
    // somewhere new, so the old turn is abandoned rather than allowed to block
    // the new one. Everything else waits its turn.
    if (!fresh && (busy || streaming)) return;
    if (fresh) {
      cancelRef.current?.();
      cancelRef.current = null;
      setStreaming(null);
      setMessages([]);
      setLastCost(null);
      // The old thread goes with its transcript. Clearing one without the other
      // would leave a blank page still pointed at the thread that was open, and
      // if the create below fails that is where the next follow-up would
      // silently land.
      setActiveId(null);
    }
    setError(null);
    setBusy(true);
    const refUrls = attached.map(r => r.url);

    // Empty the composer only if what went out is what was in it. A question
    // that came from a follow-up chip or an article's Explore button must not
    // take a half-typed one down with it. Written as a functional update so
    // this doesn't have to depend on `draft` and be rebuilt on every keystroke.
    const clearDraftIfSent = () => setDraft(prev => (prev.trim() === text ? '' : prev));
    // The attachments belong to the question that has just left, whether or not
    // the composer's text did — a follow-up chip clicked with articles pinned
    // sends them, and it would be a strange thing to leave them behind for the
    // next question to inherit silently.
    const clearRefs = () => { if (refUrls.length > 0) setRefs([]); };

    try {
      if (activeId && !fresh) {
        // Show the question immediately with a placeholder id. The server sends
        // the real one back on `meta`, but nothing here needs it — the message
        // is replaced wholesale when the thread reloads.
        setMessages(prev => [...prev, {
          id: `pending-${Date.now()}`,
          role: 'user',
          body: text,
          suggestions: [],
          // Shown straight away as the chips under the question, then corrected
          // by the server's `meta` if any of them didn't resolve.
          sources: attached,
          createdAt: new Date().toISOString(),
        }]);
        clearDraftIfSent();
        clearRefs();
        runReply(activeId, text, refUrls);
      } else {
        const { thread, messages: msgs } = await startThread(text, url, refUrls);
        setThreads(prev => [thread, ...prev]);
        setActiveId(thread.id);
        setMessages(msgs);
        setPane('chat');
        clearDraftIfSent();
        clearRefs();
        // Put the thread's own address in the bar, replacing whatever got us
        // here. Two things depend on it: a thread started by /ask is
        // linkable and reloadable from the moment it exists, and the spent
        // `?q=` instruction is gone — so a reload re-opens this thread instead
        // of starting an identical second one, which is what it used to do.
        //
        // Safe against the deep-link effect below: `activeId` is already set to
        // this thread in the same commit, so the `threadId !== activeId` guard
        // there holds and nothing re-fetches over the stream about to start.
        navigate(explorePathFor(thread.id), true);
        // The opening question is already stored, so the reply is asked for
        // without re-sending it.
        runReply(thread.id);
      }
    } catch (err) {
      setError(apiErrorText(err, 'Could not start that.'));
    } finally {
      setBusy(false);
    }
  }, [activeId, busy, streaming, runReply, navigate]);

  /**
   * A `?ref=` URL, as the chip it has to become.
   *
   * Titles are resolved here rather than carried in the URL: a chip needs a
   * headline, and a link with the headline in it would be unreadable and would
   * go stale the moment the publisher fixed a typo. A URL Newt has no record of
   * falls back to its domain rather than vanishing — the server drops it on
   * send, and being told which one it dropped beats a chip that never appeared.
   */
  const resolveRefs = useCallback((urls: string[]): Promise<ResearchSource[]> => (
    Promise.all(urls.map(async (url) => {
      const data = await apiGet<{ article: SourceArticle | null }>(
        `/api/v1/articles?url=${encodeURIComponent(url)}`,
      ).catch(() => null);
      const domain = domainOf(url);
      return {
        url,
        title: data?.article?.title || domain || url,
        source: data?.article?.source || domain,
        pubDate: data?.article?.pubDate ?? null,
      };
    }))
  ), []);

  // Both seeds, as strings. The props they come from are rebuilt on every
  // render of the shell above, so depending on them directly would re-run these
  // effects for no reason.
  const seedKey = seed ? `${seed.url ?? ''}\n${seed.question}` : '';
  const seedRefsKey = (seedRefs ?? []).slice(0, MAX_REFS).join('\n');

  /**
   * Has this page really gone away?
   *
   * Both effects below claim their seed up front and then wait on the network,
   * and what happens in between decides whether the question is asked at all.
   * An effect-scoped `cancelled` flag is the wrong instrument for that, because
   * an effect cleanup does not mean the page has gone: StrictMode runs every
   * effect as mount → cleanup → mount, so in development the cleanup fired
   * while the request was still out, cancelled it, and the re-run then found
   * the seed already claimed and did nothing. A question typed into the newt
   * button arrived at an empty Explore with `?q=` still in the address bar, and
   * a `?ref=` link attached nothing — every time, on every dev reload.
   *
   * Only a real unmount should stop the work, which is what this is. Set on the
   * way in as well as cleared on the way out, since StrictMode's cleanup runs
   * against a page that is still very much on screen.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * The live `ask`, for the seed effect to call without depending on it.
   *
   * Its identity changes with `activeId`, `busy` and `streaming` — all three of
   * which change the moment a question goes out. Taking it as a dependency
   * would re-run the effect mid-flight, which is the same trap as above from
   * the other direction.
   */
  const askRef = useRef(ask);
  askRef.current = ask;

  // A thread started from an article's Explore button, the search bar's /ask, or
  // the newt button's Ask field. Keyed on the seed rather than on the mount —
  // see `seededRef`.
  useEffect(() => {
    if (!seed || !hasModel) return;
    const key = `${seedKey}\n${seedRefsKey}`;
    if (seededRef.current === key) return;
    seededRef.current = key;
    // Articles arriving alongside a question belong *to* that question, so they
    // are resolved before it goes rather than in parallel with it. The effect
    // below would otherwise be racing this one to attach them, and losing: it
    // sets state the question was read from several milliseconds earlier, and
    // the model would be asked to compare three articles it was never handed.
    seededRefsRef.current = seedRefsKey;
    const { question, url } = seed;
    const wanted = seedRefsKey ? seedRefsKey.split('\n') : [];
    (async () => {
      const attached = wanted.length > 0 ? await resolveRefs(wanted) : [];
      if (!mountedRef.current) return;
      askRef.current(question, { url, fresh: true, refs: attached });
    })();
    // No cleanup, deliberately — see mountedRef. The seed is claimed once and
    // is always sent.
    //
    // seed is read for its two fields, which seedKey already stands for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, seedRefsKey, hasModel, resolveRefs]);

  /**
   * Articles handed over on their own by the search bar's /reference, on
   * `?ref=` with no `?q=`.
   *
   * Nothing is asked. They land in the composer's attachment row and wait for a
   * question, which is the whole difference between this and `?q=` above — and
   * why they do *not* force a new thread: attaching an article to the
   * conversation already open is a normal thing to want, and starting a fresh
   * one behind the reader's back would be a strange way to answer it.
   */
  useEffect(() => {
    if (!seedRefsKey || seededRefsRef.current === seedRefsKey) return;
    // A question in the same URL owns them — the seed effect above resolves and
    // sends them itself.
    if (seedKey) return;
    seededRefsRef.current = seedRefsKey;

    (async () => {
      const resolved = await resolveRefs(seedRefsKey.split('\n'));
      if (!mountedRef.current) return;
      setRefs(prev => {
        const merged = [...prev];
        for (const r of resolved) {
          if (merged.length >= MAX_REFS || merged.some(m => m.url === r.url)) continue;
          merged.push(r);
        }
        return merged;
      });
      setPane('chat');
      inputRef.current?.focus();
      // Spend the instruction: without this a reload attaches the same article
      // again, and the thread that was open would drop out of the address bar.
      navigate(explorePathFor(activeId ?? undefined), true);
    })();
    // Unmount is the only thing that stops this - see mountedRef above.
    // activeId is read to keep the address bar pointed at the open thread, not
    // to re-run this — the key guard above owns when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedRefsKey, seedKey, resolveRefs, navigate]);

  // Keep the newest turn in view while it writes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streaming?.text]);


  // Stop the upstream call if the page goes away mid-answer.
  useEffect(() => () => cancelRef.current?.(), []);

  // ── Thread actions ────────────────────────────────────────────────────────

  /**
   * Everything about the open thread, cleared — but not which half of a narrow
   * screen is showing. Deleting a thread from the list and starting a new one
   * are the same clearing-up and two different intentions about where to be
   * next, so the pane is the caller's to set.
   */
  function clearThread() {
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(null);
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setRefs([]);
    setLastCost(null);
    setError(null);
    // Back to the bare /explore, dropping both the old thread's id and any
    // spent `?q=`. Without this a reload would reopen the thread just left.
    navigate(explorePathFor());
  }

  function newThread() {
    clearThread();
    setPane('chat');
  }

  async function commitRename(id: string) {
    const title = renameText.trim();
    setRenaming(null);
    if (!title) return;
    setThreads(prev => prev.map(t => t.id === id ? { ...t, title } : t));
    try { await renameThread(id, title); } catch { loadThreads(); }
  }

  async function handleDelete(id: string) {
    setConfirmDelete(null);
    setThreads(prev => prev.filter(t => t.id !== id));
    // Deliberately not newThread(): deleting a row from the list is not a
    // request to start writing, and on a phone that would answer a tap on an ×
    // by throwing the reader into a blank composer.
    if (id === activeId) clearThread();
    try { await deleteThread(id); } catch { loadThreads(); }
  }

  async function handleCondense() {
    if (!activeId || condensing) return;
    setCondensing(true);
    setError(null);
    try {
      const { post } = await condenseThread(activeId);
      navigate(blogEditPathFor(post.id));
    } catch (err) {
      setError(apiErrorText(err, 'Could not condense this into a post.'));
    } finally {
      setCondensing(false);
    }
  }

  function send() {
    // A composer holding a half-typed /reference is picking an article, not
    // asking a question. Enter there would send "/reference clim" to the model.
    if (refTerm !== null) {
      if (refSuggestions.length > 0) attachRef(refSuggestions[0]);
      return;
    }
    ask(draft, { refs });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Escape abandons a /reference mid-search, leaving whatever is already
    // attached alone — the picker is a detour, not a mode you get stuck in.
    // The command is what gets abandoned, not the question it was typed onto.
    if (e.key === 'Escape' && refTerm !== null) {
      e.preventDefault();
      setDraft(refRest ? `${refRest} ` : '');
      return;
    }
    // Enter sends, Shift+Enter breaks the line — the convention every
    // conversation surface uses, and the one people try first.
    if (e.key === 'Enter' && !e.shiftKey) {
      if ((e.nativeEvent as KeyboardEvent).isComposing) return;
      e.preventDefault();
      send();
    }
  }

  const canCondense = messages.some(m => m.role === 'assistant') && !streaming;
  const latestSuggestions = !streaming && messages.length > 0
    && messages[messages.length - 1].role === 'assistant'
      ? messages[messages.length - 1].suggestions
      : [];

  // ── No model connected ────────────────────────────────────────────────────

  if (!hasModel) {
    return (
      <div className={styles.wrap}>
        <div className={styles.empty}>
          <h1 className={styles.emptyHeading}>Explore needs a model</h1>
          <p className={styles.emptyBody}>
            Explore runs on your own AI provider, using your own API key. Nothing is
            connected to this account yet, so there is nothing to ask.
          </p>
          <button className={styles.primaryBtn} onClick={onOpenSettings}>
            Connect a model
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {/* Two columns on a laptop; on a phone, two screens with one showing.
          `pane` is what picks between them, and it is inert above the
          breakpoint — see the state's own note. */}
      <div className={`${styles.layout} ${narrow ? styles[pane === 'list' ? 'showList' : 'showChat'] : ''}`}>
        {/* ── Threads ── */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>Your conversations</span>
            <button className={styles.newBtn} onClick={newThread}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New chat
            </button>
          </div>
          <div className={styles.threadList}>
            {threads.length === 0 && (
              <p className={styles.sidebarEmpty}>Nothing yet. Ask something to start.</p>
            )}
            {threads.map(t => (
              <div
                key={t.id}
                className={`${styles.threadRow} ${t.id === activeId ? styles.threadActive : ''}`}
              >
                {renaming === t.id ? (
                  <input
                    className={styles.renameInput}
                    value={renameText}
                    autoFocus
                    onChange={e => setRenameText(e.target.value)}
                    onBlur={() => commitRename(t.id)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(t.id);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    className={styles.threadBtn}
                    onClick={() => openThread(t.id)}
                    onDoubleClick={() => { setRenaming(t.id); setRenameText(t.title); }}
                    title={t.title}
                  >
                    <span className={styles.threadTitle}>{t.title}</span>
                    <span className={styles.threadMeta}>
                      {t.sourceTitle && <span className={styles.threadSource}>from an article · </span>}
                      {relTime(t.updatedAt)}
                    </span>
                  </button>
                )}
                {confirmDelete === t.id ? (
                  <span className={styles.confirmRow}>
                    <button className={styles.dangerBtn} onClick={() => handleDelete(t.id)}>Delete</button>
                    <button className={styles.ghostBtn} onClick={() => setConfirmDelete(null)}>No</button>
                  </span>
                ) : (
                  <button
                    className={styles.threadDelete}
                    aria-label={`Delete ${t.title}`}
                    onClick={() => setConfirmDelete(t.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* ── Conversation ── */}
        <section className={styles.main}>
          <header className={styles.head}>
            {/* The way back to the list, and the only chrome the narrow layout
                adds. A second hamburger beside the shell's own was the previous
                answer and read as two menus for one page. */}
            <button
              className={styles.backBtn}
              onClick={() => setPane('list')}
              aria-label="Back to your conversations"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
              </svg>
            </button>
            <div className={styles.headText}>
              <h1 className={styles.heading}>{active ? active.title : 'Something new'}</h1>
              {/* Publisher only — the article's own name is the thread title
                  here, and the card below is where you go to open it. */}
              {active?.sourceUrl && (
                <a className={styles.sourceLink} href={active.sourceUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    className={styles.sourceLinkIcon}
                    src={faviconUrl(domainOf(active.sourceUrl))}
                    alt=""
                    onError={hideBroken}
                  />
                  {domainOf(active.sourceUrl) || active.sourceTitle}
                </a>
              )}
            </div>
            {/* Only once there is an answer to share. An empty thread has
                nothing in it, and the server refuses to widen one anyway. */}
            {active && canCondense && (
              <button
                className={active.visibility === 'private' ? styles.shareBtn : styles.sharedBtn}
                onClick={() => setSharing(true)}
                title={active.visibility === 'private'
                  ? 'Choose who can see this conversation'
                  : 'Shared — change who can see it, or copy the link'}
              >
                {active.visibility === 'private' ? 'Share…' : 'Shared'}
              </button>
            )}
            {canCondense && (
              <button className={styles.primaryBtn} onClick={handleCondense} disabled={condensing}>
                {condensing ? 'Condensing…' : 'Condense into a post'}
              </button>
            )}
          </header>

          {sharing && active && (
            <ExploreShareModal
              threadId={active.id}
              title={active.title}
              visibility={active.visibility}
              messages={messages}
              onChanged={v => {
                // Patch both copies: the sidebar reads the list, the header
                // reads the active thread, and they must not disagree about
                // whether this conversation is shared.
                setThreads(ts => ts.map(t => (t.id === active.id ? { ...t, visibility: v } : t)));
              }}
              onClose={() => setSharing(false)}
            />
          )}

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.transcript}>
            {/* Pinned above the first question: what the conversation is about,
                with a way back into it. */}
            {active?.sourceUrl && (
              <SourceCard
                key={active.sourceUrl}
                url={active.sourceUrl}
                title={active.sourceTitle}
                onOpen={onOpenArticle}
              />
            )}

            {messages.length === 0 && !streaming && (
              <div className={styles.blank}>
                <NewtMark className={styles.blankMark} />
                <p className={styles.blankLead}>What are you looking into?</p>
                <p className={styles.blankSub}>
                  Ask a question and Newt will keep the whole conversation. When you have
                  what you need, condense it into a post.
                </p>
                <div className={styles.starters}>
                  {STARTERS.map(s => (
                    <button key={s} className={styles.starter} onClick={() => ask(s, { refs })}>
                      {s}
                    </button>
                  ))}
                </div>
                <p className={styles.blankTip}>
                  Type <code>/reference</code> to put one of your own articles in front of it.
                </p>
              </div>
            )}

            {messages.map(m => (
              <article key={m.id} className={m.role === 'user' ? styles.turnUser : styles.turnAssistant}>
                <div className={styles.turnRole}>
                  <span className={styles.roleMark} aria-hidden />
                  {m.role === 'user' ? 'You' : 'Explore'}
                </div>
                {/* Above the answer, in the same place they appeared while it
                    was streaming — so the layout does not shuffle the moment
                    the turn is saved. */}
                {m.role === 'assistant' && (
                  <FeedSources sources={m.sources} onOpen={onOpenArticle} />
                )}
                <div className={styles.turnBody}>
                  {m.role === 'user'
                    ? <p className={styles.userText}>{m.body}</p>
                    : <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>}
                </div>
                {/* On a question, `sources` is what /reference attached — what
                    the reader put in front of the model rather than what it
                    went and found. Under the question, since that is where it
                    was said. */}
                {m.role === 'user' && (
                  <AttachedRefs refs={m.sources} onOpen={onOpenArticle} />
                )}
              </article>
            ))}

            {streaming && (
              <article className={styles.turnAssistant}>
                <div className={styles.turnRole}>
                  <span className={styles.roleMark} aria-hidden />
                  Explore
                </div>
                {/* Shown as soon as the feed search comes back, before the
                    answer starts. It explains the pause, and it is the part
                    that makes a claim about last week checkable. */}
                <FeedSources sources={streaming.sources} onOpen={onOpenArticle} />
                <div className={styles.turnBody}>
                  {streaming.text
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming.text}</ReactMarkdown>
                    : (
                      <p className={styles.thinking}>
                        <span className={styles.dots} aria-hidden>
                          <span className={styles.dot} />
                          <span className={styles.dot} />
                          <span className={styles.dot} />
                        </span>
                        Thinking…
                      </p>
                    )}
                  {streaming.error && <div className={styles.error}>{streaming.error}</div>}
                </div>
              </article>
            )}

            {/* Under the finished answer rather than beside the composer: it is
                a fact about the turn that just happened, and it disappears the
                moment the next one starts. */}
            {!streaming && lastCost !== null && (
              <p className={styles.cost}>
                That answer cost about {lastCost < 0.01 ? 'less than $0.01' : `$${lastCost.toFixed(2)}`}
              </p>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Follow-ups and the composer travel together, stuck to the bottom of
              the viewport. Apart, the chips sat in flow beneath a sticky
              composer — which put them off the bottom of the page until you
              scrolled all the way down, and half-covered on the way there. */}
          <div className={styles.dock}>
            {/* The follow-up directions from the last answer: the model's own
                suggestions for where to take it next. They send on click rather
                than filling the composer — they are already whole questions, and
                a chip you have to click and then confirm is two clicks for the
                thing the page is for. What is in the composer is left alone, so
                a half-typed question of your own survives the detour. */}
            {latestSuggestions.length > 0 && refTerm === null && (
              <div className={styles.suggestions}>
                <span className={styles.suggestionsLabel}>Next</span>
                {latestSuggestions.map((s, i) => (
                  <button key={i} className={styles.suggestion} onClick={() => ask(s, { refs })}>
                    {s}
                    <svg className={styles.suggestionArrow} width="11" height="11" viewBox="0 0 24 24"
                      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                      strokeLinejoin="round" aria-hidden>
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                ))}
              </div>
            )}

            {/* The /reference picker, over the composer that is driving it.
                Typing the command is the only way in — the button beside the
                input types it for you rather than opening a second kind of
                search, so there is one code path and the command gets taught in
                passing. */}
            {refTerm !== null && (
              <div className={styles.picker}>
                <span className={styles.pickerLabel}>
                  {refs.length >= MAX_REFS
                    ? `That's ${MAX_REFS} articles — remove one to attach another`
                    : 'Attach something you have saved, written or subscribed to'}
                </span>
                {refs.length < MAX_REFS && refSuggestions.map(s => (
                  <button key={s.url} className={styles.pickerRow} onClick={() => attachRef(s)}>
                    <img
                      className={styles.pickerFavicon}
                      src={faviconUrl(domainOf(s.url))}
                      alt=""
                      onError={hideBroken}
                    />
                    <span className={styles.pickerTitle}>{s.title || s.url}</span>
                    <span className={styles.pickerSource}>{s.source || domainOf(s.url)}</span>
                  </button>
                ))}
                {refs.length < MAX_REFS && refSuggestions.length === 0 && (
                  <span className={styles.pickerEmpty}>
                    {refTerm.length < 2
                      ? 'Type part of a headline…'
                      : 'Nothing saved or subscribed matches that.'}
                  </span>
                )}
              </div>
            )}

            <AttachedRefs refs={refs} onRemove={detachRef} />

            <form className={styles.composer} onSubmit={handleSubmit}>
              <div className={styles.inputWrap}>
                {/* The field's height comes from this wrapper's ::after, which
                    holds the same text with the same metrics — see .grow in the
                    stylesheet. `data-value` is the whole mechanism: React keeps
                    it in step with the textarea, and CSS does the rest. */}
                <div className={styles.grow} data-value={draft}>
                  <textarea
                    ref={inputRef}
                    className={styles.input}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    placeholder={active ? 'Ask a follow-up…' : 'How is AI changing health care?'}
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  className={styles.attachBtn}
                  // Appended, not assigned: the button types the command for
                  // you, and typing it should no more discard a half-written
                  // question than typing it yourself would.
                  onClick={() => {
                    setDraft(prev => (prev.trim() ? `${prev.trimEnd()} /reference ` : '/reference '));
                    inputRef.current?.focus();
                  }}
                  disabled={busy || refs.length >= MAX_REFS}
                  title="Reference an article (/reference)"
                  aria-label="Reference an article"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              </div>
              {streaming ? (
                <button
                  type="button"
                  className={styles.stopBtn}
                  onClick={() => { cancelRef.current?.(); cancelRef.current = null; setStreaming(null); }}
                >
                  Stop
                </button>
              ) : (
                <button type="submit" className={styles.sendBtn} disabled={busy || !draft.trim()}>
                  {refTerm === null ? 'Ask' : 'Attach'}
                </button>
              )}
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
