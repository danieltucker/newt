import { useMemo, useRef, useState, ReactNode } from 'react';
import { useMyPosts } from '../hooks/useBlog';
import { useRailMarker, useKeepActiveVisible } from '../hooks/useRailMarker';
import { POST_VIS_META } from '../components/VisibilityMeta';
import PostTags from '../components/PostTags';
import { BlogPostSummary } from '../types';
import { blogPathFor, blogEditPathFor } from '../utils/blogUrl';
import { relTime } from '../utils/notifications';
import styles from './MyBlogPage.module.css';

// The author's own view of their blog: every post including drafts, newest
// first. Public listings live on the profile page instead.
//
// Laid out as a console - the shared card, sticky nav and wordmark eyebrow in
// styles/pageConsole.module.css - because it is the same kind of screen as
// Settings and Admin and had no business being a third design. See the head of
// MyBlogPage.module.css.

interface Props {
  accessToken: string;
  username: string;
  navigate: (to: string) => void;
  // Rendered inside the app shell (NewTabPage) rather than as its own page -
  // see ShellView. Drops the full-height background and the "← Newt" bar.
  embedded?: boolean;
}

// The screen's mark. Stacked pages, because the word beside it is doing the
// naming and the glyph only has to do the recognising. Not a pen: the drafts
// pill four inches to the right wears one, and that is the one place in this
// nav where the confusion would have somewhere to land.
const PagesIcon = () => (
  <svg
    className={styles.wordmarkIcon}
    width="15" height="15" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden
  >
    <path d="M4.75 2.25h4L11.75 5.25v8.5h-7z" />
    <path d="M8.5 2.5v3h3" />
    <path d="M3.25 4.75v8.75c0 .55.45 1 1 1h6" opacity="0.55" />
  </svg>
);

// 'private' is the draft state - see POST_VIS_META.
const isDraftPost = (p: BlogPostSummary) => p.visibility === 'private';

type Filter = 'all' | 'published' | 'drafts';

// The counts the old header stated in prose, turned into the thing you were
// going to do with them. Order runs widest to narrowest, so the pills read as
// one list being narrowed rather than three unrelated views.
const FILTERS: { id: Filter; label: string; icon: ReactNode }[] = [
  {
    id: 'all',
    label: 'All',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        <path d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h10.5" />
      </svg>
    ),
  },
  {
    id: 'published',
    label: 'Published',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="8" cy="8" r="5.75" />
        <path d="M2.5 8h11M8 2.25c1.5 1.6 2.25 3.5 2.25 5.75S9.5 12.15 8 13.75C6.5 12.15 5.75 10.25 5.75 8S6.5 3.85 8 2.25Z" />
      </svg>
    ),
  },
  {
    id: 'drafts',
    label: 'Drafts',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11.25 2.75 13.25 4.75 6 12H4v-2z" />
        <path d="M2.75 14.25h10.5" opacity="0.55" />
      </svg>
    ),
  },
];

export default function MyBlogPage({ accessToken, username, navigate, embedded }: Props) {
  const { posts, loading, error, remove } = useMyPosts(accessToken);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const drafts = posts.filter(isDraftPost).length;
  const published = posts.length - drafts;
  const countFor = (f: Filter) => (f === 'all' ? posts.length : f === 'drafts' ? drafts : published);

  const shown = useMemo(() => (
    filter === 'all' ? posts : posts.filter(p => isDraftPost(p) === (filter === 'drafts'))
  ), [posts, filter]);

  // The lozenge under the lit pill, measured rather than stepped - the same
  // highlight the rail and the other two consoles use. `posts.length` is a
  // dependency because the counts appear inside the pills and change their
  // widths as the list loads.
  const navRef = useRef<HTMLElement>(null);
  const pillRefs = useRef(new Map<Filter, HTMLElement>());
  const marker = useRailMarker({
    activeId: filter,
    elementFor: id => pillRefs.current.get(id as Filter) ?? null,
    containerRef: navRef,
    deps: [posts.length],
  });
  useKeepActiveVisible({
    activeId: filter,
    elementFor: id => pillRefs.current.get(id as Filter) ?? null,
  });

  async function handleDelete(post: BlogPostSummary) {
    setBusyId(post.id);
    try {
      await remove(post.id);
    } catch { /* the row stays; the user can retry */ }
    setBusyId(null);
    setConfirming(null);
  }

  const body = (
    <div className={styles.page}>
      <div className={styles.console}>
        {/* One row: the screen's name, the filters, and the one verb this page
            has. No sub-nav - there is no second axis to cut a list of your own
            posts along - so the nav carries its own bottom padding. */}
        <nav
          className={`${styles.nav} ${styles.navBare}`}
          ref={navRef}
          aria-label="Post filters"
        >
          <div className={styles.navRow}>
            {/* Says which screen this is, which the pills never do - they name
                the filter, not the page. h1 rather than a decorative span: it
                is the page's heading whatever size it is set in, and a screen
                with no h1 hands a screen reader a document that starts at the
                nav. */}
            <h1 className={styles.wordmark}>
              <PagesIcon />
              Posts
            </h1>
            <div className={styles.sectionRow}>
              <span
                className={`${styles.lozenge} ${marker ? styles.lozengeOn : ''}`}
                style={marker ? { transform: `translateX(${marker.left}px)`, width: marker.width } : undefined}
                aria-hidden
              />
              {FILTERS.map(f => {
                const count = countFor(f.id);
                return (
                  <button
                    key={f.id}
                    ref={el => { if (el) pillRefs.current.set(f.id, el); else pillRefs.current.delete(f.id); }}
                    className={`${styles.sectionItem} ${filter === f.id ? styles.sectionActive : ''}`}
                    aria-current={filter === f.id ? 'page' : undefined}
                    onClick={() => setFilter(f.id)}
                  >
                    <span className={styles.sectionIcon} aria-hidden>{f.icon}</span>
                    {f.label}
                    {/* Nothing at zero. An empty count is a badge saying there
                        is nothing to badge, and on Drafts it would be an amber
                        pill drawing the eye to no work at all. */}
                    {count > 0 && (
                      <span className={`${styles.filterCount} ${f.id === 'drafts' ? styles.filterCountDraft : ''}`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* In the nav rather than over the list, so it is as reachable at
                the bottom of forty posts as at the top. */}
            <button className={styles.navAction} onClick={() => navigate('/blog/new')}>
              New post
            </button>
          </div>
        </nav>

        <div className={styles.content}>
          <div className={styles.body}>
            {error && <div className={styles.error}>{error}</div>}

            {loading ? (
              <div className={styles.centered}>Loading…</div>
            ) : posts.length === 0 ? (
              <div className={styles.centered}>
                <div className={styles.big}>Write your first post</div>
                <p className={styles.hint}>
                  Posts start as drafts that only you can read. Publish when you’re ready.
                </p>
                <button className={styles.primaryBtn} onClick={() => navigate('/blog/new')}>New post</button>
              </div>
            ) : shown.length === 0 ? (
              // Posts exist, this filter holds none of them. Says which filter
              // rather than "nothing here", so it reads as a narrowed list and
              // not as a blog that emptied itself.
              <div className={styles.centered}>
                <p className={styles.hint}>
                  {filter === 'drafts'
                    ? 'Nothing unpublished. Every post you have written is live.'
                    : 'Nothing published yet — everything here is still a draft.'}
                </p>
                <button className={styles.ghostBtn} onClick={() => setFilter('all')}>Show all posts</button>
              </div>
            ) : (
              <div className={styles.list}>
                {shown.map(p => {
                  const vis = POST_VIS_META[p.visibility];
                  const isDraft = isDraftPost(p);
                  return (
                    <div key={p.id} className={`${styles.row} ${isDraft ? styles.rowDraft : ''}`}>
                      {p.heroImage && <img className={styles.rowThumb} src={p.heroImage} alt="" />}
                      {/* The row opens the post, it doesn't open the editor. A
                          list of things you wrote should hand you the thing you
                          wrote; dropping straight into a composer meant every
                          glance at an old post risked editing it. Editing is
                          the button below, and the reader carries its own
                          "Edit post" too.

                          Drafts open here as well - the post route serves a
                          private post to its own author (see canSeePost), so
                          there is no post in this list without a page to
                          open. */}
                      <button className={styles.rowMain} onClick={() => navigate(blogPathFor(username, p.slug))}>
                        <div className={styles.rowTop}>
                          <span className={styles.rowTitle}>{p.title}</span>
                          {/* A draft is the one state worth spotting from
                              across the list: it is the reason this page
                              exists, and it is the only thing here that nobody
                              else can see. It gets the icon, the amber and the
                              row's dashed edge; the published tiers stay
                              quiet. */}
                          <span className={`${styles.chip} ${isDraft ? styles.chipDraft : ''}`}>
                            {isDraft && vis.icon}
                            {vis.tag}
                          </span>
                          {!p.commentsEnabled && <span className={styles.mutedChip}>Comments off</span>}
                        </div>
                        {p.excerpt && <div className={styles.excerpt}>{p.excerpt}</div>}
                        {/* Display only. The row is already one big button, and
                            a tag inside it that filtered something would be a
                            second destination hidden in the first. */}
                        <PostTags tags={p.tags} className={styles.rowTags} />
                        <div className={styles.rowMeta}>
                          {isDraft
                            ? <>Not published · edited {relTime(p.updatedAt)}</>
                            : relTime(p.publishedAt)}
                        </div>
                      </button>

                      <div className={styles.rowActions}>
                        {/* Was "View", on published posts only - the row itself
                            is the way in now, so this is the door the row used
                            to be. */}
                        <button
                          className={styles.ghostBtn}
                          onClick={() => navigate(blogEditPathFor(p.id))}
                        >
                          Edit
                        </button>
                        {confirming === p.id ? (
                          <>
                            <button
                              className={styles.dangerBtn}
                              disabled={busyId === p.id}
                              onClick={() => handleDelete(p)}
                            >
                              {busyId === p.id ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button className={styles.ghostBtn} onClick={() => setConfirming(null)}>Cancel</button>
                          </>
                        ) : (
                          <button className={styles.ghostBtn} onClick={() => setConfirming(p.id)}>Delete</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (embedded) return body;

  // Standalone: the shell isn't here, so this supplies the page background and
  // the way back that it would otherwise be holding.
  return (
    <div className={styles.standalone}>
      <div className={styles.topbar}>
        <button className={styles.backBtn} onClick={() => navigate('/')}>← Newt</button>
      </div>
      {body}
    </div>
  );
}
