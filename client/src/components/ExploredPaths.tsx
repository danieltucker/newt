import { Suspense, lazy, useEffect, useState } from 'react';
import styles from './ExploredPaths.module.css';
import {
  ExploredPath, SharedExploreMessage, getExploredPaths, getSharedExplore,
} from '../services/llm';
import { apiErrorText } from '../services/api';
import { relTime } from '../utils/notifications';
import { VIS_META } from './VisibilityMeta';

const ExploreTranscript = lazy(() => import('./ExploreTranscript'));

// ── Explored paths ────────────────────────────────────────────────────────
// What was done with this article beyond replying to it, sitting between the
// text and the comment thread.
//
// Two things end up here and they are deliberately one list. An explore is a
// conversation somebody had with a model about the piece; a post is somebody
// writing about it at length. Both are more considered than a comment, both
// were previously invisible to everyone but their author, and to a reader
// arriving at the foot of an article they answer the same question - did anyone
// take this further, and is it worth following them.
//
// Renders nothing at all when the list is empty. A heading over "no explored
// paths yet" would put a permanent empty shelf on every article on the
// instance, most of which will never have one.
//
// ── Why an explore opens here and a post does not ──
// An explore reads as a continuation of the article: somebody asked questions
// about the piece the reader has just read, and the answers only mean anything
// beside it. Sending them to /e/:id threw away the article and their place in
// it, to show them a page whose own header is a link back to where they just
// were. So an explore unfolds in place.
//
// A post is a document with its own author, title and comment thread; it is a
// destination rather than an appendix, and it still opens as one. The chevron
// on an explore row is what tells the two apart before the click.
//
// One open at a time. A transcript is long - whole exchanges, not snippets -
// and three of them unfolded at once would bury the comment thread under the
// shelf that is meant to sit above it.

interface Props {
  articleUrl: string;
  /** Opens a path in the app shell rather than as a document load. */
  navigate?: (to: string) => void;
}

/** A transcript being read inline: fetched on the first expand, then kept. */
interface Loaded {
  status: 'loading' | 'ready' | 'error';
  messages: SharedExploreMessage[];
  error: string;
}

export default function ExploredPaths({ articleUrl, navigate }: Props) {
  const [paths, setPaths] = useState<ExploredPath[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});

  useEffect(() => {
    let cancelled = false;
    // Silent on failure. This is an extra shelf on a page whose main content
    // has already loaded - an error box here would report a problem the reader
    // cannot act on, about something they did not ask for.
    getExploredPaths(articleUrl)
      .then(r => { if (!cancelled) setPaths(r.paths); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [articleUrl]);

  // A different article is a different shelf: whatever was unfolded belonged to
  // the last one. The transcripts go with it rather than lingering as a cache -
  // they are keyed by thread id, but each one holds a whole conversation.
  useEffect(() => { setOpenId(null); setLoaded({}); }, [articleUrl]);

  function toggle(id: string) {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    // Fetched once per article. A collapse keeps what it read, so folding a
    // long thread shut to look at the row under it costs no second round trip,
    // and re-opening it does not flash "Loading…" over text that was there a
    // moment ago.
    if (loaded[id]) return;
    setLoaded(m => ({ ...m, [id]: { status: 'loading', messages: [], error: '' } }));
    getSharedExplore(id).then(
      r => setLoaded(m => ({ ...m, [id]: { status: 'ready', messages: r.messages, error: '' } })),
      e => setLoaded(m => ({
        ...m,
        // Unlike the shelf's own fetch, this one is worth reporting: the reader
        // asked for it by name, and the likeliest reason is that its author put
        // the thread back to private between the list being drawn and the row
        // being opened.
        [id]: {
          status: 'error',
          messages: [],
          error: apiErrorText(e, 'This conversation isn’t available any more.'),
        },
      })),
    );
  }

  if (paths.length === 0) return null;

  return (
    <section className={styles.wrap} aria-label="Explored paths">
      <h3 className={styles.heading}>
        Explored paths
        <span className={styles.count}>{paths.length}</span>
      </h3>

      <ul className={styles.list}>
        {paths.map(p => {
          const expandable = p.kind === 'explore';
          const open = expandable && openId === p.id;
          const panelId = `explored-path-${p.kind}-${p.id}`;
          const state = loaded[p.id];

          return (
            <li key={`${p.kind}-${p.id}`}>
              {/* Still an anchor carrying the real href, even though a plain
                  click now unfolds it: ctrl/cmd-click, middle-click and "copy
                  link address" are how a reader sends a thread on to someone or
                  parks it in a tab, and a <button> would have quietly taken all
                  three away. */}
              <a
                className={styles.item}
                href={p.href}
                data-expandable={expandable || undefined}
                aria-expanded={expandable ? open : undefined}
                aria-controls={open ? panelId : undefined}
                onClick={e => {
                  // A modified click is the reader asking for a new tab or
                  // window. Let the browser have it, expandable or not.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  if (expandable) { e.preventDefault(); toggle(p.id); return; }
                  // In-app where we can - a post lands on a page the shell can
                  // draw, and a document load would drop the reader out of the
                  // article they are standing in.
                  if (navigate) { e.preventDefault(); navigate(p.href); }
                }}
              >
                <span className={styles.kind} data-kind={p.kind}>
                  {p.kind === 'explore' ? <ExploreGlyph /> : <PostGlyph />}
                  {p.kind === 'explore' ? 'Explore' : 'Post'}
                </span>

                <span className={styles.main}>
                  <span className={styles.title}>{p.title}</span>
                  {/* The preview is what the row has instead of the thread.
                      Once the thread itself is open it is the same words twice,
                      so it steps aside. */}
                  {p.snippet && !open && <span className={styles.snippet}>{p.snippet}</span>}
                  <span className={styles.meta}>
                    {/* Whose it is comes first: on a page about somebody else's
                        article, who took it further is the useful part.

                        A generated explore is named for the instance rather than
                        falling through to "Someone". That fallback was written for
                        a deleted account — a person who was there and now is not —
                        and reusing it here would present a machine-written page as
                        an anonymous human one, which is the single thing the
                        labelling rules across this app exist to prevent. `origin`
                        is what decides it, not the absence of an author. */}
                    <span className={styles.who}>
                      {p.origin === 'auto'
                        ? 'Newt'
                        : p.own ? 'You' : p.author?.displayName || 'Someone'}
                    </span>
                    {/* Said out loud, not left to be inferred from the name. Sits
                        in the same meta row as the "Friends" marker and works the
                        same way: only the case that needs stating is stated. */}
                    {p.origin === 'auto' && (
                      <>
                        <span className={styles.dot}>·</span>
                        <span className={styles.generated} title="Written by this instance's own model, not by a person">
                          generated
                        </span>
                      </>
                    )}
                    {p.turns != null && (
                      <>
                        <span className={styles.dot}>·</span>
                        {/* Exchanges rather than messages - a question and its
                            answer are one turn, and counting rows would make
                            every thread look twice as long as it is. */}
                        <span>{p.turns} exchange{p.turns === 1 ? '' : 's'}</span>
                      </>
                    )}
                    {p.at && (
                      <>
                        <span className={styles.dot}>·</span>
                        <span>{relTime(p.at)}</span>
                      </>
                    )}
                    {/* Only the narrower tier is marked. "Public" on a page you
                        are already reading says nothing; "Friends" tells the
                        author who else is seeing this, which is the thing worth
                        knowing. */}
                    {p.visibility === 'friends' && (
                      <>
                        <span className={styles.dot}>·</span>
                        <span className={styles.tier}>
                          {VIS_META.friends.icon}
                          {VIS_META.friends.tag}
                        </span>
                      </>
                    )}
                  </span>
                </span>

                {/* The one mark that says this row behaves differently from the
                    Post row under it. Placed absolutely so it survives the
                    narrow layout, where the card stacks into a column. */}
                {expandable && (
                  <span className={styles.chev} aria-hidden><ChevronGlyph /></span>
                )}
              </a>

              {open && (
                <div className={styles.panel} id={panelId}>
                  {state?.status === 'error' ? (
                    <p className={styles.panelNote}>{state.error}</p>
                  ) : state?.status === 'ready' ? (
                    <>
                      {/* Fallback null rather than a second "Loading…": the
                          chunk is small and the request beside it is usually
                          slower, and a spinner that flashes and leaves reads as
                          a glitch. */}
                      <Suspense fallback={null}>
                        <ExploreTranscript messages={state.messages} />
                      </Suspense>
                      <div className={styles.panelFoot}>
                        {/* Closing from the top of a long thread means scrolling
                            back past all of it, so the way out is also at the
                            bottom, where the reader finishes. */}
                        <button
                          type="button"
                          className={styles.panelBtn}
                          onClick={() => setOpenId(null)}
                        >
                          Collapse
                        </button>
                        {/* The thread still has a page of its own, and that is
                            the thing you send to somebody who is not standing
                            in this article. */}
                        <a
                          className={styles.panelLink}
                          href={p.href}
                          onClick={e => {
                            if (navigate && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                              e.preventDefault();
                              navigate(p.href);
                            }
                          }}
                        >
                          Open its own page
                        </a>
                      </div>
                    </>
                  ) : (
                    <p className={styles.panelNote}>Loading the conversation…</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ExploreGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PostGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <polyline points="14 4 14 10 20 10" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
