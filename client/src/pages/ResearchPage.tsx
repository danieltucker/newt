import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ResearchThread, ResearchMessage, ResearchSource,
  listThreads, getThread, startThread, renameThread, deleteThread, condenseThread,
  streamResearchReply, apiErrorText,
} from '../services/llm';
import { blogEditPathFor } from '../utils/blogUrl';
import { relTime } from '../utils/notifications';
import styles from './ResearchPage.module.css';

/**
 * Research: a conversation with your own model, kept.
 *
 * Threads are the unit. One starts from a question typed here or from a
 * Research button on an article, and it lives in the sidebar until deleted —
 * which is the whole point of it being a page rather than a panel. Research you
 * cannot come back to is a chat window, and there are plenty of those.
 *
 * The condense button turns a thread into a private draft post and drops the
 * author into the composer with it. It is the reason the transcript is worth
 * keeping: the conversation is the working-out, and the post is what comes of
 * it.
 */

interface Props {
  navigate: (to: string) => void;
  /** Deep link: open this thread on mount. */
  threadId?: string | null;
  /**
   * Start a new thread about this article, once, on mount. What the Research
   * button on an article sends. Consumed immediately so a re-render can't fire
   * a second thread.
   */
  seed?: { question: string; url?: string } | null;
  /** False while the account has no model connected — the page says so instead. */
  hasModel: boolean;
  onOpenSettings: () => void;
}

/** A turn that is still arriving. Not a ResearchMessage until the server saves it. */
interface Streaming {
  text: string;
  error: string | null;
  /** Articles from the reader's own feed that were pulled in for this answer. */
  sources: ResearchSource[];
}

export default function ResearchPage({ navigate, threadId, seed, hasModel, onOpenSettings }: Props) {
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // What the last answer cost, in dollars. Null when the model has no known
  // price — a self-hosted endpoint, or one Newt doesn't have in its catalogue.
  const [lastCost, setLastCost] = useState<number | null>(null);

  // The live stream's cancel function. Held in a ref rather than state because
  // nothing renders from it and replacing it must not schedule a render.
  const cancelRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seededRef = useRef(false);

  const active = threads.find(t => t.id === activeId) ?? null;

  // ── Loading ───────────────────────────────────────────────────────────────

  const loadThreads = useCallback(async () => {
    try {
      const { threads: list } = await listThreads();
      setThreads(list);
      return list;
    } catch {
      setError('Could not load your research.');
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
    setError(null);
    setSidebarOpen(false);
    try {
      const { messages: msgs } = await getThread(id);
      setMessages(msgs);
    } catch {
      setError('Could not open that thread.');
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    if (threadId && threadId !== activeId) openThread(threadId);
    // activeId is deliberately not a dependency: this reacts to the URL
    // changing, not to the page opening a thread of its own accord.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, openThread]);

  // ── Asking ────────────────────────────────────────────────────────────────

  /** Stream the next assistant turn into `streaming`, then fold it into the list. */
  const runReply = useCallback((id: string, question?: string) => {
    setStreaming({ text: '', error: null, sources: [] });
    cancelRef.current = streamResearchReply(id, question, {
      onDelta: (text) => setStreaming(prev => (
        prev ? { ...prev, text: prev.text + text } : { text, error: null, sources: [] }
      )),
      onSources: (sources) => setStreaming(prev => (
        prev ? { ...prev, sources } : { text: '', error: null, sources }
      )),
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

  const ask = useCallback(async (question: string, url?: string) => {
    const text = question.trim();
    if (!text || busy || streaming) return;
    setError(null);
    setBusy(true);

    try {
      if (activeId) {
        // Show the question immediately with a placeholder id. The server sends
        // the real one back on `meta`, but nothing here needs it — the message
        // is replaced wholesale when the thread reloads.
        setMessages(prev => [...prev, {
          id: `pending-${Date.now()}`,
          role: 'user',
          body: text,
          suggestions: [],
          createdAt: new Date().toISOString(),
        }]);
        setDraft('');
        runReply(activeId, text);
      } else {
        const { thread, messages: msgs } = await startThread(text, url);
        setThreads(prev => [thread, ...prev]);
        setActiveId(thread.id);
        setMessages(msgs);
        setDraft('');
        // The opening question is already stored, so the reply is asked for
        // without re-sending it.
        runReply(thread.id);
      }
    } catch (err) {
      setError(apiErrorText(err, 'Could not start that.'));
    } finally {
      setBusy(false);
    }
  }, [activeId, busy, streaming, runReply]);

  // A thread started from an article's Research button. Guarded by a ref rather
  // than by dependencies: this must happen exactly once per mount, whatever
  // else re-renders.
  useEffect(() => {
    if (!seed || seededRef.current || !hasModel) return;
    seededRef.current = true;
    ask(seed.question, seed.url);
  }, [seed, hasModel, ask]);

  // Keep the newest turn in view while it writes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streaming?.text]);

  // Stop the upstream call if the page goes away mid-answer.
  useEffect(() => () => cancelRef.current?.(), []);

  // ── Thread actions ────────────────────────────────────────────────────────

  function newThread() {
    cancelRef.current?.();
    cancelRef.current = null;
    setStreaming(null);
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setError(null);
    setSidebarOpen(false);
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
    if (id === activeId) newThread();
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(draft);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line — the convention every
    // conversation surface uses, and the one people try first.
    if (e.key === 'Enter' && !e.shiftKey) {
      if ((e.nativeEvent as KeyboardEvent).isComposing) return;
      e.preventDefault();
      ask(draft);
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
          <h1 className={styles.emptyHeading}>Research needs a model</h1>
          <p className={styles.emptyBody}>
            Research runs on your own AI provider, using your own API key. Nothing is
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
      <div className={`${styles.layout} ${sidebarOpen ? styles.layoutOpen : ''}`}>
        {/* ── Threads ── */}
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>Research</span>
            <button className={styles.newBtn} onClick={newThread}>New</button>
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
            <button
              className={styles.sidebarToggle}
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Show research threads"
            >
              ☰
            </button>
            <div className={styles.headText}>
              <h1 className={styles.heading}>{active ? active.title : 'New research'}</h1>
              {active?.sourceUrl && (
                <a className={styles.sourceLink} href={active.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {active.sourceTitle || active.sourceUrl}
                </a>
              )}
            </div>
            {canCondense && (
              <button className={styles.primaryBtn} onClick={handleCondense} disabled={condensing}>
                {condensing ? 'Condensing…' : 'Condense into a post'}
              </button>
            )}
          </header>

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.transcript}>
            {messages.length === 0 && !streaming && (
              <div className={styles.blank}>
                <p className={styles.blankLead}>What are you looking into?</p>
                <p className={styles.blankSub}>
                  Ask a question and Newt will keep the whole conversation. When you have
                  what you need, condense it into a post.
                </p>
              </div>
            )}

            {messages.map(m => (
              <article key={m.id} className={m.role === 'user' ? styles.turnUser : styles.turnAssistant}>
                <div className={styles.turnRole}>{m.role === 'user' ? 'You' : 'Research'}</div>
                <div className={styles.turnBody}>
                  {m.role === 'user'
                    ? <p className={styles.userText}>{m.body}</p>
                    : <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>}
                </div>
              </article>
            ))}

            {streaming && (
              <article className={styles.turnAssistant}>
                <div className={styles.turnRole}>Research</div>
                {/* Shown as soon as the feed search comes back, before the
                    answer starts. It explains the pause, and it is the part
                    that makes a claim about last week checkable. */}
                {streaming.sources.length > 0 && (
                  <div className={styles.sources}>
                    <span className={styles.sourcesLabel}>
                      Read {streaming.sources.length} article{streaming.sources.length === 1 ? '' : 's'} from your feed
                    </span>
                    <div className={styles.sourceList}>
                      {streaming.sources.map(s => (
                        <a
                          key={s.url}
                          className={styles.sourceChip}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={s.title}
                        >
                          {s.title}
                          {s.source && <span className={styles.sourceFrom}> · {s.source}</span>}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                <div className={styles.turnBody}>
                  {streaming.text
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming.text}</ReactMarkdown>
                    : <p className={styles.thinking}><span className={styles.dots} aria-hidden />Thinking…</p>}
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

          {/* The follow-up directions from the last answer. They are the model's
              own suggestions for where to go next, so they fill the composer
              rather than sending straight off — the reader gets to edit one. */}
          {latestSuggestions.length > 0 && (
            <div className={styles.suggestions}>
              {latestSuggestions.map((s, i) => (
                <button key={i} className={styles.suggestion} onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className={styles.composer} onSubmit={handleSubmit}>
            <textarea
              className={styles.input}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={active ? 'Ask a follow-up…' : 'Research ways AI is changing health…'}
              disabled={busy}
            />
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
                Ask
              </button>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}
