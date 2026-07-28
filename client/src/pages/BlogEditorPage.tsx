import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RichEditor from '../components/RichEditor';
import { POST_VIS_META, VIS_ORDER } from '../components/VisibilityMeta';
import { BlogPost, CommentVisibility } from '../types';
import { createPost, updatePost, loadOwnPost } from '../hooks/useBlog';
import { blogPathFor } from '../utils/blogUrl';
import { uploadImage, ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';
import { articleEmbed, embeddedUrls } from '../utils/noteEmbed';
import { takeRepost, clearRepost, repostBody } from '../utils/repost';
import { useReadingList } from '../hooks/useReadingList';
import { useCommentCounts } from '../hooks/useCommentCounts';
import SiteFooter from '../components/SiteFooter';
import styles from './BlogEditorPage.module.css';

// Full-page composer for a blog post. `postId` is null for a new post.
//
// The body lives in a ref, not state: RichEditor is uncontrolled (it reads
// initialHtml once on mount and never again), so re-rendering on every keystroke
// would buy nothing - the same arrangement CommentsPanel's composer uses. Only
// the empty/non-empty flip needs a render, to enable Save.

interface Props {
  postId: string | null;
  username: string;
  // Only so the reading list can be loaded for /reference - the editor page is
  // never reached signed out (see App), so this is always present in practice.
  accessToken: string | null;
  navigate: (to: string) => void;
}

// Mirrors the server's blank check so Save can't submit an editor holding only
// markup like "<p><br></p>". Keep in step with isBlankHtml in
// server/src/lib/comments.ts - a reference counts as content even though it can
// carry no text of its own.
function htmlIsBlank(html: string): boolean {
  if (/<(hr|table|img)\b/i.test(html) || /\bnote-embed\b/.test(html)) return false;
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0;
}

// Keep in step with MAX_BLOG_TEXT in server/src/lib/blog.ts. Enforced server-
// side; this just warns before the server would reject the save.
const MAX_BLOG_TEXT = 50_000;
function textLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().length;
}

// Everything a save sends, as one comparable string. Taken again after each
// load and each save, so Save can be greyed out while the editor still matches
// what the server holds.
function snapshotOf(
  title: string, body: string,
  visibility: CommentVisibility, commentsEnabled: boolean, heroImage: string,
): string {
  return JSON.stringify([title.trim(), body, visibility, commentsEnabled, heroImage]);
}

type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

// The post's cover image, chosen explicitly rather than lifted from the body:
// the first image in a post is often a diagram or a screenshot that reads badly
// as a banner, and an author who wants one as the hero can pick the same file.
//
// It uploads through the same route the body's images use, so a hero costs the
// same storage quota and is served from the same immutable image URL. The value
// held here is that site-relative path, which is exactly what the server stores.
function HeroPicker({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      onChange((await uploadImage(file)).url);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'Couldn’t upload that image');
    } finally {
      setBusy(false);
      // Clearing the input lets the same file be re-picked after a failure -
      // otherwise choosing it again fires no change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className={styles.heroBlock}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        className={styles.heroInput}
        onChange={e => pick(e.target.files?.[0])}
      />
      {value ? (
        <div className={styles.heroPreview}>
          <img src={value} alt="" className={styles.heroImg} />
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.heroBtn}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? 'Uploading…' : 'Replace'}
            </button>
            <button
              type="button"
              className={styles.heroBtn}
              disabled={busy}
              onClick={() => { setErr(''); onChange(''); }}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.heroEmpty}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Uploading…' : '+ Add a cover image'}
        </button>
      )}
      {err && <div className={styles.error}>{err}</div>}
    </div>
  );
}

export default function BlogEditorPage({ postId, username, accessToken, navigate }: Props) {
  const isNew = postId === null;

  // A repost arrives as a reference stashed by whichever reader the author was
  // in (see startRepost), so the composer opens already holding the card and
  // the source's title, and all that is left to do is say something about it.
  //
  // Captured during the first render rather than in an effect: RichEditor is
  // uncontrolled and reads initialHtml on mount, so a seed arriving afterwards
  // would never reach it. takeRepost is idempotent for exactly this reason -
  // StrictMode runs this initialiser twice and keeps one of the two answers.
  const [seed] = useState(() => {
    const draft = isNew ? takeRepost() : null;
    return draft && { title: draft.title, body: repostBody(draft.embed) };
  });
  // Once this composer has the draft, nothing else should get it: without this,
  // leaving and choosing "New post" again would reopen the same repost.
  useEffect(() => clearRepost, []);

  const [state, setState] = useState<LoadState>(isNew ? 'ready' : 'loading');
  const [post, setPost] = useState<BlogPost | null>(null);

  const [title, setTitle] = useState(seed?.title ?? '');
  const [heroImage, setHeroImage] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('private');
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  // Seeded rather than empty for a repost: the card is real content the author
  // never typed, so Save has to be live before they touch anything.
  const bodyRef = useRef(seed?.body ?? '');
  const [bodyEmpty, setBodyEmpty] = useState(() => htmlIsBlank(bodyRef.current));
  const [textLen, setTextLen] = useState(() => textLength(bodyRef.current));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Set once the first save of a brand-new post lands, so subsequent saves
  // update that post rather than creating another.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // Snapshot of what the server holds, so Save knows whether there is anything
  // to send. Null while a new post has never been saved.
  const savedRef = useRef<string | null>(null);
  const [bodyRev, setBodyRev] = useState(0);

  // /reference offers the same saved articles a note does - one reading list,
  // cited from wherever you happen to be writing.
  const { items: readingList } = useReadingList(accessToken);
  const references = useMemo(() => readingList.map(articleEmbed), [readingList]);
  // Live comment counts for the references already in the post, seeded from the
  // loaded body and topped up as more are added.
  const [embedUrls, setEmbedUrls] = useState<string[]>(() => embeddedUrls(bodyRef.current));
  const { counts: commentCounts } = useCommentCounts(embedUrls);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setState('loading');
    loadOwnPost(postId!)
      .then(p => {
        if (cancelled) return;
        setPost(p);
        setTitle(p.title);
        setHeroImage(p.heroImage);
        setVisibility(p.visibility);
        setCommentsEnabled(p.commentsEnabled);
        bodyRef.current = p.body;
        setBodyEmpty(htmlIsBlank(p.body));
        setTextLen(textLength(p.body));
        setEmbedUrls(embeddedUrls(p.body));
        savedRef.current = snapshotOf(p.title, p.body, p.visibility, p.commentsEnabled, p.heroImage);
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('notfound'); });
    return () => { cancelled = true; };
  }, [postId, isNew]);

  useEffect(() => {
    document.title = isNew ? (seed ? 'Repost' : 'New post') : 'Edit post';
    return () => { document.title = 'New Tab'; };
  }, [isNew, seed]);

  const handleBody = useCallback((html: string) => {
    bodyRef.current = html;
    const blank = htmlIsBlank(html);
    setBodyEmpty(prev => (prev === blank ? prev : blank));
    setTextLen(textLength(html));
    // The body lives in a ref, so editing it alone would not re-render this
    // component - and `dirty` below, which Save reads, would go stale.
    setBodyRev(r => r + 1);
  }, []);

  const tooLong = textLen > MAX_BLOG_TEXT;
  const effectiveId = post?.id ?? createdId;

  // Everything the save payload carries, as one comparable string. Compared
  // against the snapshot taken at load/save time so Save can be greyed out when
  // there is nothing new to send.
  const current = useMemo(
    () => snapshotOf(title, bodyRef.current, visibility, commentsEnabled, heroImage),
    // bodyRev stands in for bodyRef.current, which a dependency array can't watch
    [title, visibility, commentsEnabled, heroImage, bodyRev],
  );
  // A brand-new post has no server copy yet, so anything in it counts as unsaved.
  const dirty = savedRef.current === null || current !== savedRef.current;

  const valid = title.trim().length > 0 && !bodyEmpty && !tooLong && !busy;
  const canSave = valid && dirty;

  async function save(nextVisibility?: CommentVisibility) {
    // Publishing always changes the visibility, so it stays available on a post
    // with no other edits pending.
    if (!valid || (!dirty && !nextVisibility)) return;
    const vis = nextVisibility ?? visibility;
    setBusy(true);
    setError('');
    try {
      const payload = { title: title.trim(), body: bodyRef.current, visibility: vis, commentsEnabled, heroImage };
      const saved = effectiveId
        ? await updatePost(effectiveId, payload)
        : await createPost(payload);
      setPost(saved);
      setCreatedId(saved.id);
      setHeroImage(saved.heroImage);
      setVisibility(saved.visibility);
      setSavedAt(new Date().toISOString());
      // Snapshot the state the next render will see - the server echoes back
      // visibility and heroImage, but the body stays as typed (RichEditor is
      // uncontrolled, so a server-sanitized copy would never reach the editor).
      savedRef.current = snapshotOf(
        title, bodyRef.current, saved.visibility, commentsEnabled, saved.heroImage,
      );
      // Reflect a server-side re-slug (a renamed draft) without a reload
      if (!effectiveId) window.history.replaceState({}, '', `/blog/${saved.id}`);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t save this post');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') {
    return <div className={styles.page}><div className={styles.centered}>Loading…</div></div>;
  }
  if (state !== 'ready') {
    return (
      <div className={styles.page}>
        <div className={styles.centered}>
          <div className={styles.big}>Couldn’t open this post</div>
          <button className={styles.ghostBtn} onClick={() => navigate('/blog')}>Back to my blog</button>
        </div>
      </div>
    );
  }

  const vis = POST_VIS_META[visibility];

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/blog')}>← My blog</button>
          {savedAt && !busy && !dirty && <span className={styles.savedTag}>Saved</span>}
        </div>

        <div className={styles.toolbarRight}>
          <label className={styles.toggle} title="Let others reply to this post">
            <input
              type="checkbox"
              checked={commentsEnabled}
              onChange={e => setCommentsEnabled(e.target.checked)}
            />
            <span>Allow comments</span>
          </label>

          <div className={styles.visSwitch} role="radiogroup" aria-label="Who can see this post">
            {VIS_ORDER.map(v => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={visibility === v}
                className={`${styles.visOption} ${visibility === v ? styles.visOptionActive : ''}`}
                onClick={() => setVisibility(v)}
                title={POST_VIS_META[v].hint}
              >
                {POST_VIS_META[v].icon}
                <span className={styles.visOptionLabel}>{POST_VIS_META[v].label}</span>
              </button>
            ))}
          </div>

          <button
            className={styles.saveBtn}
            disabled={!canSave}
            title={valid && !dirty ? 'No changes to save' : undefined}
            onClick={() => save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <div className={styles.wrap}>
        {error && <div className={styles.error}>{error}</div>}

        <HeroPicker value={heroImage} onChange={setHeroImage} />

        <input
          className={styles.titleInput}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Post title"
          maxLength={200}
          // A repost lands with the title already filled from the source, so
          // the cursor belongs where the author still has something to add.
          autoFocus={isNew && !seed}
        />

        <div className={styles.urlLine}>
          {post?.slug
            ? <>Published at <code>{blogPathFor(username, post.slug)}</code></>
            : <>The link is generated from the title when you first save.</>}
          {post && visibility !== 'private' && (
            <span className={styles.urlNote}> · the link is fixed now that it’s shared</span>
          )}
        </div>

        <div className={styles.editorShell}>
          {/* Uncontrolled: keyed so loading a different post remounts it with
              that post's HTML, since initialHtml is only read on mount. */}
          <RichEditor
            key={postId ?? 'new'}
            initialHtml={post?.body ?? seed?.body ?? ''}
            onChange={handleBody}
            onUploadImage={uploadImage}
            references={references}
            commentCounts={commentCounts}
            onEmbedsChange={setEmbedUrls}
            findable
          />
        </div>

        <div className={styles.foot}>
          <span className={styles.hint} title={vis.hint}>{vis.tag} · {vis.hint}</span>
          {textLen > MAX_BLOG_TEXT * 0.8 && (
            <span className={`${styles.charCount} ${tooLong ? styles.charCountOver : ''}`}>
              {textLen.toLocaleString()} / {MAX_BLOG_TEXT.toLocaleString()}
            </span>
          )}
          {post && visibility === 'private' && (
            <button className={styles.publishBtn} disabled={!valid} onClick={() => save('public')}>
              Publish publicly
            </button>
          )}
          {post && visibility !== 'private' && (
            <a
              className={styles.viewLink}
              href={blogPathFor(username, post.slug)}
              onClick={e => { e.preventDefault(); navigate(blogPathFor(username, post.slug)); }}
            >
              View post →
            </a>
          )}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
