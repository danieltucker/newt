import { useCallback, useEffect, useRef, useState } from 'react';
import RichEditor from '../components/RichEditor';
import { POST_VIS_META, VIS_ORDER } from '../components/VisibilityMeta';
import { BlogPost, CommentVisibility } from '../types';
import { createPost, updatePost, loadOwnPost } from '../hooks/useBlog';
import { blogPathFor } from '../utils/blogUrl';
import { uploadImage } from '../utils/imageUpload';
import styles from './BlogEditorPage.module.css';

// Full-page composer for a blog post. `postId` is null for a new post.
//
// The body lives in a ref, not state: RichEditor is uncontrolled (it reads
// initialHtml once on mount and never again), so re-rendering on every keystroke
// would buy nothing — the same arrangement CommentsPanel's composer uses. Only
// the empty/non-empty flip needs a render, to enable Save.

interface Props {
  postId: string | null;
  username: string;
  navigate: (to: string) => void;
}

// Mirrors the server's blank check so Save can't submit an editor holding only
// markup like "<p><br></p>".
function htmlIsBlank(html: string): boolean {
  if (/<(hr|table|img)\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0;
}

// Keep in step with MAX_BLOG_TEXT in server/src/lib/blog.ts. Enforced server-
// side; this just warns before the server would reject the save.
const MAX_BLOG_TEXT = 50_000;
function textLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().length;
}

type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

export default function BlogEditorPage({ postId, username, navigate }: Props) {
  const isNew = postId === null;
  const [state, setState] = useState<LoadState>(isNew ? 'ready' : 'loading');
  const [post, setPost] = useState<BlogPost | null>(null);

  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('private');
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const bodyRef = useRef('');
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const [textLen, setTextLen] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Set once the first save of a brand-new post lands, so subsequent saves
  // update that post rather than creating another.
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    setState('loading');
    loadOwnPost(postId!)
      .then(p => {
        if (cancelled) return;
        setPost(p);
        setTitle(p.title);
        setVisibility(p.visibility);
        setCommentsEnabled(p.commentsEnabled);
        bodyRef.current = p.body;
        setBodyEmpty(htmlIsBlank(p.body));
        setTextLen(textLength(p.body));
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('notfound'); });
    return () => { cancelled = true; };
  }, [postId, isNew]);

  useEffect(() => {
    document.title = isNew ? 'New post' : 'Edit post';
    return () => { document.title = 'New Tab'; };
  }, [isNew]);

  const handleBody = useCallback((html: string) => {
    bodyRef.current = html;
    const blank = htmlIsBlank(html);
    setBodyEmpty(prev => (prev === blank ? prev : blank));
    setTextLen(textLength(html));
  }, []);

  const tooLong = textLen > MAX_BLOG_TEXT;
  const canSave = title.trim().length > 0 && !bodyEmpty && !tooLong && !busy;
  const effectiveId = post?.id ?? createdId;

  async function save(nextVisibility?: CommentVisibility) {
    if (!canSave) return;
    const vis = nextVisibility ?? visibility;
    setBusy(true);
    setError('');
    try {
      const payload = { title: title.trim(), body: bodyRef.current, visibility: vis, commentsEnabled };
      const saved = effectiveId
        ? await updatePost(effectiveId, payload)
        : await createPost(payload);
      setPost(saved);
      setCreatedId(saved.id);
      setVisibility(saved.visibility);
      setSavedAt(new Date().toISOString());
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
          {savedAt && !busy && <span className={styles.savedTag}>Saved</span>}
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

          <button className={styles.saveBtn} disabled={!canSave} onClick={() => save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <div className={styles.wrap}>
        {error && <div className={styles.error}>{error}</div>}

        <input
          className={styles.titleInput}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Post title"
          maxLength={200}
          autoFocus={isNew}
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
            initialHtml={post?.body ?? ''}
            onChange={handleBody}
            onUploadImage={uploadImage}
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
            <button className={styles.publishBtn} disabled={!canSave} onClick={() => save('public')}>
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
    </div>
  );
}
