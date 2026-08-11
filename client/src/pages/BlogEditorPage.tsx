import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RichEditor from '../components/RichEditor';
import TagChipInput from '../components/TagChipInput';
import { POST_VIS_META, VIS_ORDER } from '../components/VisibilityMeta';
import { BlogPost, CommentVisibility } from '../types';
import { createPost, updatePost, loadOwnPost, deletePost } from '../hooks/useBlog';
import { blogPathFor } from '../utils/blogUrl';
import { uploadImage, ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';
import { fetchPageMeta } from '../utils/pageMeta';
import { articleEmbed, embeddedUrls } from '../utils/noteEmbed';
import { takeSeed, clearSeed } from '../utils/composerSeed';
import { relTime } from '../utils/notifications';
import ProofreadPanel from '../components/ProofreadPanel';
import { useReadingList } from '../hooks/useReadingList';
import { useCommentCounts } from '../hooks/useCommentCounts';
import useSlidingThumb from '../hooks/useSlidingThumb';
import styles from './BlogEditorPage.module.css';

// The composer for a blog post. `postId` is null for a new post.
//
// This renders inside the app shell (see NewTabPage's ShellView), so the header,
// the search bar, the command console and the notes console are all above and
// around it - there is no page chrome to build here, only the controls that act
// on the post itself.
//
// The body lives in a ref, not state: RichEditor is uncontrolled (it reads
// initialHtml once on mount and never again), so re-rendering on every keystroke
// would buy nothing - the same arrangement CommentsPanel's composer uses. Only
// the empty/non-empty flip needs a render, to enable Save.

interface Props {
  postId: string | null;
  username: string;
  /**
   * Whether the account has an AI model connected. False hides the Proofread
   * button entirely — the composer is not the place to advertise a feature that
   * needs a trip to settings before it can do anything.
   */
  hasModel?: boolean;
  // Only so the reading list can be loaded for /reference - the editor is never
  // reached signed out (see App), so this is always present in practice.
  accessToken: string | null;
  navigate: (to: string) => void;
}

// Autosave pacing. The idle delay is the debounce - a save goes out once typing
// pauses. The minimum gap is the floor between two of them, so holding a long
// session at a steady clip can't outrun the server's hourly write limit (see
// blogWriteLimiter in server/src/routes/blogs.ts).
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MIN_GAP_MS = 15_000;

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

// Keep in step with MAX_POST_TAGS in server/src/lib/blog.ts. Enforced there;
// this stops the field accepting a ninth tag the save would then bounce.
const MAX_POST_TAGS = 8;

// How long typing has to pause before htmlIsBlank/textLength are run over the
// post again. Short enough that the counter feels live, long enough that a
// burst of typing costs one pass rather than one per character.
const MEASURE_IDLE_MS = 250;

// Everything a save sends. Taken again after each load and each save, so Save
// can be greyed out while the editor still matches what the server holds.
//
// Compared field by field rather than serialized to one string. It used to be a
// JSON.stringify of the whole payload, rebuilt on every keystroke - which meant
// escaping and copying the entire post per character typed, on top of the full
// string comparison that followed. The body check here is usually a pointer
// comparison (a save stores the very string the ref is holding) and otherwise
// fails on the length, so the common cases cost nothing.
interface Snapshot {
  title: string;
  body: string;
  visibility: CommentVisibility;
  commentsEnabled: boolean;
  heroImage: string;
  tags: string[];
}

function snapshotOf(
  title: string, body: string,
  visibility: CommentVisibility, commentsEnabled: boolean, heroImage: string,
  tags: string[],
): Snapshot {
  return { title: title.trim(), body, visibility, commentsEnabled, heroImage, tags };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.title === b.title
    && a.visibility === b.visibility
    && a.commentsEnabled === b.commentsEnabled
    && a.heroImage === b.heroImage
    && sameTags(a.tags, b.tags)
    && a.body === b.body;
}

// Order counts: the author chose it, and reordering is an edit worth saving.
function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
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

// The one line telling an author whether their words are safe yet. It says less
// than it could on purpose: a draft that autosaves only needs to admit when it
// hasn't caught up, whereas a published post - where Save is a deliberate act -
// has to say plainly that there is something waiting.
function SaveState({ busy, dirty, savedAt, autosaves, hasContent }: {
  busy: boolean; dirty: boolean; savedAt: string | null;
  autosaves: boolean; hasContent: boolean;
}) {
  // "2m ago" would otherwise freeze at whatever it read when typing stopped -
  // which is exactly when someone looks at it to decide whether to close the tab.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!savedAt) return;
    const t = setInterval(() => tick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [savedAt]);

  if (busy) return <span className={styles.savedTag}>Saving…</span>;
  if (dirty && hasContent) {
    return (
      <span className={`${styles.savedTag} ${autosaves ? '' : styles.savedTagWarn}`}>
        {autosaves ? 'Saving shortly…' : 'Unsaved changes'}
      </span>
    );
  }
  if (savedAt) {
    return <span className={styles.savedTag}>Saved {relTime(savedAt)}</span>;
  }
  return null;
}

export default function BlogEditorPage({ postId, username, accessToken, navigate, hasModel }: Props) {
  const isNew = postId === null;

  // A seed is a repost's reference card, or a note the author chose to publish -
  // either way it was stashed by wherever they started from (see composerSeed),
  // so the composer opens already holding it and all that is left is to say
  // something about it.
  //
  // Captured during the first render rather than in an effect: RichEditor is
  // uncontrolled and reads initialHtml on mount, so a seed arriving afterwards
  // would never reach it. takeSeed is idempotent for exactly this reason -
  // StrictMode runs this initialiser twice and keeps one of the two answers.
  // The formatting toolbar sticks directly under this bar, which itself sticks
  // under the shell bar, so it needs this one's height. Measured and published
  // rather than assumed - the bar wraps to two rows on a narrow window, and a
  // constant would leave the toolbar overlapping it exactly when there is least
  // room to spare. Same arrangement ShellBar uses for --shellbar-h.
  const actionBarRef = useRef<HTMLDivElement>(null);

  const [seed] = useState(() => (isNew ? takeSeed() : null));
  // Once this composer has the seed, nothing else should get it: without this,
  // leaving and choosing "New post" again would reopen the same draft.
  useEffect(() => clearSeed, []);

  const [state, setState] = useState<LoadState>(isNew ? 'ready' : 'loading');
  const [post, setPost] = useState<BlogPost | null>(null);

  // The formatting toolbar sticks directly under the action bar, which itself
  // sticks under the shell bar, so it needs this one's height. Measured and
  // published rather than assumed - the bar wraps to two rows on a narrow
  // window, and a constant would leave the toolbar overlapping it exactly when
  // there is least room to spare. Same arrangement ShellBar uses for
  // --shellbar-h, scoped to .wrap rather than the document root because it is a
  // fact about this page and shouldn't outlive it.
  useEffect(() => {
    const el = actionBarRef.current;
    const scope = el?.parentElement;
    if (!el || !scope) return;
    const publish = () => scope.style.setProperty('--composer-bar-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  const [title, setTitle] = useState(seed?.title ?? '');
  const [heroImage, setHeroImage] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  // TagChipInput keeps the half-typed tag out here so the surface can decide
  // what to do with it - see the note beside the field.
  const [tagInput, setTagInput] = useState('');
  const [visibility, setVisibility] = useState<CommentVisibility>('private');
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  // Seeded rather than empty for a repost: the card is real content the author
  // never typed, so Save has to be live before they touch anything.
  const bodyRef = useRef(seed?.body ?? '');
  const [bodyEmpty, setBodyEmpty] = useState(() => htmlIsBlank(bodyRef.current));
  const [textLen, setTextLen] = useState(() => textLength(bodyRef.current));

  // The sliding highlight on the visibility switch. Up here with the rest of
  // the hooks rather than beside the switch it belongs to: the render below it
  // returns early while the post is loading.
  const {
    trackRef: visTrackRef, setItem: setVisOption, thumbProps: visThumbProps,
  } = useSlidingThumb(visibility);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Set once the first save of a brand-new post lands, so subsequent saves
  // update that post rather than creating another.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // Snapshot of what the server holds, so Save knows whether there is anything
  // to send. Null while a new post has never been saved.
  const savedRef = useRef<Snapshot | null>(null);
  const [bodyRev, setBodyRev] = useState(0);
  const measureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setTags(p.tags);
        setVisibility(p.visibility);
        setCommentsEnabled(p.commentsEnabled);
        bodyRef.current = p.body;
        setBodyEmpty(htmlIsBlank(p.body));
        setTextLen(textLength(p.body));
        setEmbedUrls(embeddedUrls(p.body));
        savedRef.current = snapshotOf(
          p.title, p.body, p.visibility, p.commentsEnabled, p.heroImage, p.tags,
        );
        setState('ready');
      })
      .catch(() => { if (!cancelled) setState('notfound'); });
    return () => { cancelled = true; };
  }, [postId, isNew]);

  useEffect(() => {
    document.title = isNew ? 'New post' : 'Edit post';
    return () => { document.title = 'Newt'; };
  }, [isNew, seed]);

  // Recompute what has to be read out of the body itself. Both helpers run a
  // string replace across the whole post, so this is the expensive part of an
  // edit and it is kept off the keystroke path - see handleBody.
  const measureBody = useCallback(() => {
    if (measureTimer.current) { clearTimeout(measureTimer.current); measureTimer.current = null; }
    const html = bodyRef.current;
    const blank = htmlIsBlank(html);
    const len = textLength(html);
    setBodyEmpty(prev => (prev === blank ? prev : blank));
    setTextLen(prev => (prev === len ? prev : len));
  }, []);

  const handleBody = useCallback((html: string) => {
    bodyRef.current = html;
    // The body lives in a ref, so editing it alone would not re-render this
    // component - and `dirty` below, which Save reads, would go stale.
    setBodyRev(r => r + 1);
    // The character count and the blank check are display and validation, and
    // neither has to be right *this* character. Running them per keystroke put
    // five full passes over the post between the key going down and the letter
    // appearing, which on a phone with a long draft is a visible stall. They
    // settle when typing pauses; save() measures for itself before it commits.
    if (measureTimer.current) clearTimeout(measureTimer.current);
    measureTimer.current = setTimeout(measureBody, MEASURE_IDLE_MS);
  }, [measureBody]);

  useEffect(() => () => { if (measureTimer.current) clearTimeout(measureTimer.current); }, []);

  const tooLong = textLen > MAX_BLOG_TEXT;
  const effectiveId = post?.id ?? createdId;

  // A brand-new post gets created exactly once, whatever asks for it. Three
  // things can want to save at the same instant - the debounced autosave, the
  // Save button, and the flush on the way out - and while `busy` keeps them
  // apart for the most part, it only turns true a render *after* the request
  // goes out. Two POSTs inside that window would leave the author with two
  // posts and the composer pointed at one of them. This claims the create
  // before anything is sent, and only lets go if it fails.
  const creatingRef = useRef(false);
  function claimCreate(): boolean {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    return true;
  }

  // Everything the save payload carries. Compared against the snapshot taken at
  // load/save time so Save can be greyed out when there is nothing new to send.
  // `bodyRev` is not read here - it is what causes the render that recomputes
  // it, since a dependency array can't watch a ref.
  const current = snapshotOf(title, bodyRef.current, visibility, commentsEnabled, heroImage, tags);
  // A brand-new post has no server copy yet, so anything in it counts as unsaved.
  const dirty = savedRef.current === null || !sameSnapshot(current, savedRef.current);

  const valid = title.trim().length > 0 && !bodyEmpty && !tooLong && !busy;
  const canSave = valid && dirty;
  // Something worth not losing, whether or not it is saveable yet - a title with
  // no body still counts, which is what the leave-the-tab warning keys off.
  const hasContent = title.trim().length > 0 || !bodyEmpty;

  async function save(nextVisibility?: CommentVisibility) {
    // Measure the body for real before deciding. `bodyEmpty` and `tooLong` are
    // settled a moment after typing stops, so a save fired inside that moment -
    // the first character of a new post, then straight to Save - would be
    // judged against the state before it was typed.
    const html = bodyRef.current;
    const blank = htmlIsBlank(html);
    const over = textLength(html) > MAX_BLOG_TEXT;
    measureBody();
    const canSaveNow = title.trim().length > 0 && !blank && !over && !busy;
    // Publishing always changes the visibility, so it stays available on a post
    // with no other edits pending.
    if (!canSaveNow || (!dirty && !nextVisibility)) return;
    if (!effectiveId && !claimCreate()) return;
    const vis = nextVisibility ?? visibility;
    setBusy(true);
    setError('');
    try {
      const payload = { title: title.trim(), body: bodyRef.current, visibility: vis, commentsEnabled, heroImage, tags };
      const saved = effectiveId
        ? await updatePost(effectiveId, payload)
        : await createPost(payload);
      setPost(saved);
      setCreatedId(saved.id);
      setHeroImage(saved.heroImage);
      // The server lowercases and dedupes, so what it stored may differ from
      // what was typed - taking its answer back is what stops the next
      // comparison reading as an unsaved edit forever.
      setTags(saved.tags);
      setVisibility(saved.visibility);
      setSavedAt(new Date().toISOString());
      // Snapshot the state the next render will see - the server echoes back
      // visibility, heroImage and tags, but the body stays as typed (RichEditor
      // is uncontrolled, so a server-sanitized copy would never reach the editor).
      savedRef.current = snapshotOf(
        title, bodyRef.current, saved.visibility, commentsEnabled, saved.heroImage, saved.tags,
      );
      // Reflect a server-side re-slug (a renamed draft) without a reload
      if (!effectiveId) window.history.replaceState({}, '', `/blog/${saved.id}`);
    } catch (e) {
      // The post was never created, so the next attempt has to be allowed to
      // try again. Harmless when this was an update - the claim was never taken.
      if (!effectiveId) creatingRef.current = false;
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t save this post');
    } finally {
      setBusy(false);
    }
  }

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Autosave ───────────────────────────────────────────────────────────────
  // Drafts only. A draft has no reader to disturb, so writing it out as you go
  // is pure upside: close the tab, come back, it's on the blog page waiting.
  // A post that is already public or friends-only is a different matter - a save
  // is a publish, and half a sentence is not something a reader should meet - so
  // those keep the explicit Save button and nothing else.
  //
  // A delete in flight stands the whole thing down: re-creating the post the
  // author just asked to be rid of is the one outcome worse than losing an edit.
  const autosaves = visibility === 'private' && !deleting;

  // The last render's save(), so the timer below can reach the current closure
  // without restarting every time one of its inputs changes.
  const saveRef = useRef(save);
  saveRef.current = save;
  const lastAutosaveRef = useRef(0);

  useEffect(() => {
    if (!autosaves || !canSave) return;
    // Debounce from the last keystroke, but never closer than the floor to the
    // previous autosave - whichever of the two is further out wins.
    const wait = Math.max(
      AUTOSAVE_IDLE_MS,
      lastAutosaveRef.current + AUTOSAVE_MIN_GAP_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      lastAutosaveRef.current = Date.now();
      saveRef.current();
    }, wait);
    return () => clearTimeout(timer);
    // Restart on any edit. `current` is a fresh object every render and can't be
    // a dependency; these are the things it is built from, with bodyRev
    // standing in for the body itself.
  }, [autosaves, canSave, bodyRev, title, visibility, commentsEnabled, heroImage, tags]);

  // What the debounce still owes, sent on the way out. Rebuilt each render
  // because the cleanup that calls it runs once, long after this render's
  // closure would have gone stale. Null when there is nothing outstanding.
  //
  // Deliberately not save(): that sets state, and by the time this runs the
  // component is gone. Nothing here waits on the answer either - navigating away
  // is the user's decision, not something to block on a round-trip.
  const flushRef = useRef<(() => void) | null>(null);
  flushRef.current = autosaves && canSave
    ? () => {
        if (!effectiveId && !claimCreate()) return;
        const payload = { title: title.trim(), body: bodyRef.current, visibility, commentsEnabled, heroImage, tags };
        const p = effectiveId ? updatePost(effectiveId, payload) : createPost(payload);
        p.catch(() => {});
      }
    : null;

  useEffect(() => () => flushRef.current?.(), []);

  // Closing the tab outright gets no flush - an in-flight request dies with the
  // page - so warn instead. Covers the published-post case too, which has no
  // autosave to fall back on.
  useEffect(() => {
    if (!dirty || !hasContent) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, hasContent]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!effectiveId) return;
    setDeleting(true);
    setError('');
    try {
      await deletePost(effectiveId);
      // The post this would have written to no longer exists - unmounting must
      // not recreate it.
      flushRef.current = null;
      navigate('/blog');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t delete this post');
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  if (state === 'loading') {
    return <div className={styles.centered}>Loading…</div>;
  }
  if (state !== 'ready') {
    return (
      <div className={styles.centered}>
        <div className={styles.big}>Couldn’t open this post</div>
        <button className={styles.ghostBtn} onClick={() => navigate('/blog')}>Back to my posts</button>
      </div>
    );
  }

  const vis = POST_VIS_META[visibility];

  return (
    <div className={styles.wrap}>
      {/* Not a page header - the shell bar above already is one. This is the row
          of controls that act on the post: who gets to see it, and whether it
          has been written down yet. */}
      <div className={styles.actionBar} ref={actionBarRef}>
        <div className={styles.actionLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/blog')}>← My posts</button>
          <SaveState
            busy={busy}
            dirty={dirty}
            savedAt={savedAt}
            autosaves={autosaves}
            hasContent={hasContent}
          />
        </div>

        <div className={styles.actionRight}>
          <label className={styles.toggle} title="Let others reply to this post">
            <input
              type="checkbox"
              checked={commentsEnabled}
              onChange={e => setCommentsEnabled(e.target.checked)}
            />
            <span>Allow comments</span>
          </label>

          <div className={styles.visSwitch} role="radiogroup" aria-label="Who can see this post" ref={visTrackRef}>
            {/* Who can see the post is the most consequential thing on this bar,
                and it used to change by repainting two segments at once. One box
                that slides from Public to Friends to Draft is the same fact with
                the movement left in - see useSlidingThumb. */}
            <span className={styles.visThumb} {...visThumbProps} />
            {VIS_ORDER.map(v => (
              <button
                key={v}
                ref={setVisOption(v)}
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
      </div>

      <div className={styles.body}>
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

        {/* Under the title, above the link: a tag is a fact about the post,
            not a formatting decision, so it belongs with the other things that
            describe it rather than beside the Save button.

            The half-typed tag lives in tagInput and is committed by Tab, comma,
            Enter or blur - so clicking Save (which blurs first) picks up a word
            still sitting in the box, rather than dropping it. */}
        <div className={styles.tagsBlock}>
          <TagChipInput
            tags={tags}
            onChange={next => setTags(next.slice(0, MAX_POST_TAGS))}
            inputValue={tagInput}
            onInputChange={setTagInput}
            placeholder="Tags - Tab or comma to add"
          />
          {tags.length >= MAX_POST_TAGS && (
            <div className={styles.tagsHint}>That’s the {MAX_POST_TAGS}-tag limit.</div>
          )}
        </div>

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
            onFetchPageMeta={fetchPageMeta}
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
          {/* Before Publish, because it is the thing worth doing first — and
              because the draft it reads is whatever is in the editor right now,
              saved or not. */}
          {hasModel && !bodyEmpty && (
            <ProofreadPanel getDraft={() => ({ title, body: bodyRef.current })} />
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

          {/* Only once the post exists on the server - there is nothing to
              delete before that, and the composer's own Cancel is the back
              button. Two-step, like the manage list's, because a post is the
              longest thing anyone writes here and there is no undo. */}
          {effectiveId && (
            confirmingDelete ? (
              <span className={styles.confirmRow}>
                <span className={styles.confirmText}>Delete this post?</span>
                <button className={styles.dangerBtn} disabled={deleting} onClick={handleDelete}>
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
                <button
                  className={styles.ghostBtn}
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button className={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
