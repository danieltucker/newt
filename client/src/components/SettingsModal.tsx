import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import styles from './SettingsModal.module.css';
import { UserSettings } from '../hooks/useSettings';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { tagKey, hasFavorite } from '../utils/favoriteTags';
import { apiFetch, apiGet, apiPatch, apiPost } from '../services/api';
import { COVER_AUTO, COVER_THEMES, coverStyle } from '../utils/coverGradient';
import {
  LINK_PLATFORMS, MAX_PROFILE_LINKS, WEBSITE_PLATFORM,
  guessPlatform, linkIcon, linkLabel, normalizeLinkUrl,
  type ProfileLink,
} from '../utils/profileLinks';
import { uploadImage, ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';

export interface UserProfile {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  // The profile banner: an uploaded image path, a named gradient, or neither -
  // see utils/coverGradient.
  coverImage: string | null;
  coverTheme: string | null;
  profileLinks: ProfileLink[];
}

interface Props {
  settings: UserSettings;
  onUpdate: (patch: Partial<UserSettings>) => Promise<void>;
  onClose: () => void;
  onImport?: () => void;
  initialSection?: Section;
  onProfileChange?: (profile: UserProfile) => void;
}

export type Section = 'account' | 'search' | 'appearance' | 'reading' | 'advanced' | 'integrations';

// Downscale the chosen image to a small square data URL client-side -
// keeps uploads tiny and avoids any server-side image processing.
const AVATAR_SIZE = 128;
function fileToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      // cover-crop to a square from the centre
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

const ENGINES = [
  { id: 'google',     label: 'Google',     url: 'google.com' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'duckduckgo.com' },
  { id: 'bing',       label: 'Bing',        url: 'bing.com' },
  { id: 'brave',      label: 'Brave',       url: 'search.brave.com' },
] as const;

const BookOpenIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <path d="M8 13.5C6.5 13 4 12.5 2 13V3.5C4 3 6.5 3.5 8 4.5" />
    <path d="M8 13.5C9.5 13 12 12.5 14 13V3.5C12 3 9.5 3.5 8 4.5" />
    <line x1="8" y1="4.5" x2="8" y2="13.5" />
  </svg>
);

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'account',      label: 'Account',      icon: '◍' },
  { id: 'search',       label: 'Search',       icon: '⌕' },
  { id: 'appearance',   label: 'Appearance',   icon: '◑' },
  { id: 'reading',      label: 'Reading',      icon: <BookOpenIcon /> },
  { id: 'advanced',     label: 'Advanced',     icon: '⚙' },
  { id: 'integrations', label: 'Integrations', icon: '⇌' },
];

const sectionLabel = (id: Section) => NAV.find(n => n.id === id)?.label ?? '';

// What the search field can find. Every entry names a `data-setting` anchor on
// a real control below, so a hit lands on the switch itself rather than the
// section that happens to contain it - which for Reading is a long scroll.
// `terms` carries the words people actually type that the label doesn't say:
// "2fa" for the authenticator, "dark" for the theme, "opml" for the feeds.
const SEARCH_INDEX: { anchor: string; section: Section; label: string; terms: string }[] = [
  { anchor: 'profile',        section: 'account',      label: 'Profile',                      terms: 'name first last email avatar photo picture display' },
  { anchor: 'cover',          section: 'account',      label: 'Profile cover',                terms: 'banner header gradient image background' },
  { anchor: 'links',          section: 'account',      label: 'Profile links',                terms: 'social website mastodon github bluesky url' },
  { anchor: 'password',       section: 'account',      label: 'Change password',              terms: 'security credentials sign in login' },
  { anchor: 'totp',           section: 'account',      label: 'Two-factor authentication',    terms: '2fa totp authenticator security code mfa' },
  { anchor: 'search-engine',  section: 'search',       label: 'Search engine',                terms: 'google duckduckgo bing brave default query' },
  { anchor: 'search-new-tab', section: 'search',       label: 'Open results in new tab',      terms: 'window target blank' },
  { anchor: 'theme',          section: 'appearance',   label: 'Theme',                        terms: 'dark light auto system colour color mode' },
  { anchor: 'bookmark-layout',section: 'appearance',   label: 'Bookmark layout',              terms: 'panel inline sidebar folders arc grid' },
  { anchor: 'background',     section: 'appearance',   label: 'Background',                   terms: 'gradient wallpaper page colour color' },
  { anchor: 'favorite-tags',  section: 'reading',      label: 'Favorite tags',                terms: 'favourite star topics keywords highlight' },
  { anchor: 'rss',            section: 'reading',      label: 'RSS feeds',                    terms: 'feed subscriptions articles atom syndication' },
  { anchor: 'mark-read',      section: 'reading',      label: 'Mark articles read as you scroll', terms: 'unread badge seen scrolling' },
  { anchor: 'comments-public',section: 'reading',      label: 'Show public comments',         terms: 'comments threads others replies' },
  { anchor: 'comments-visibility', section: 'reading', label: 'Default visibility for new comments', terms: 'comments public friends private personal note' },
  { anchor: 'comments-expand',section: 'reading',      label: 'Open comment threads automatically', terms: 'comments expand collapse' },
  { anchor: 'comments-sort',  section: 'reading',      label: 'Comment order',                terms: 'comments sort newest oldest first' },
  { anchor: 'save-article',   section: 'reading',      label: 'Saving articles',              terms: 'reading list save dialog instant review tags' },
  { anchor: 'reading-list-open', section: 'reading',   label: 'How the reading list opens articles', terms: 'reader overlay new tab same window' },
  { anchor: 'bookmark-open',  section: 'reading',      label: 'How bookmarks open',           terms: 'new tab same window links' },
  { anchor: 'page-size',      section: 'reading',      label: 'Articles per page',            terms: 'feed page size load more count' },
  { anchor: 'console',        section: 'advanced',     label: 'Console',                      terms: 'backtick commands power user notes' },
  { anchor: 'import',         section: 'advanced',     label: 'Import bookmarks',             terms: 'html json browser export migrate' },
  { anchor: 'personal-feed',  section: 'integrations', label: 'Your friends’ post feed',      terms: 'rss private token blog url rotate' },
  { anchor: 'bookmarklets',   section: 'integrations', label: 'Browser bookmarklets',         terms: 'save article add bookmark drag toolbar' },
];

function BookmarkletRow({ label, href }: { label: string; href: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try { await navigator.clipboard.writeText(href); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className={styles.bookmarkletRow}>
      {/* eslint-disable-next-line react/jsx-no-script-url */}
      <a href={href} className={styles.bookmarkletLink} onClick={e => e.preventDefault()} draggable>
        {label}
      </a>
      <button className={styles.copyBtn} onClick={handleCopy}>
        {copied ? 'Copied!' : 'Copy URL'}
      </button>
    </div>
  );
}

// Your personal blog feed: one URL that aggregates your friends' posts,
// including the friends-only ones. Because it carries content narrower than
// public, the URL itself is the credential - hence the warning and the rotate.
function PersonalFeedPanel() {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ url: string }>('/api/v1/blogs/feed-token')
      .then(d => { if (!cancelled) setUrl(d.url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function copy() {
    navigator.clipboard?.writeText(url).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => {},
    );
  }

  async function rotate() {
    setBusy(true);
    try {
      const d = await apiPost<{ url: string }>('/api/v1/blogs/feed-token/rotate', {});
      setUrl(d.url);
    } catch { /* keep the old URL on screen */ }
    setBusy(false);
  }

  if (!url) return null;

  return (
    <div className={styles.sectionBlock} data-setting="personal-feed">
      <div className={styles.blockTitle}>Your friends’ post feed</div>
      <div className={styles.rowHint} style={{ marginBottom: 12 }}>
        A private RSS feed of posts from you and your friends, including
        friends-only posts. Add it to a folder’s feeds, or any RSS reader.
        <br />
        <strong>Treat this link like a password</strong> - anyone who has it can
        read your friends’ friends-only posts. Rotate it to revoke a link you’ve shared.
      </div>
      <div className={styles.row}>
        <input
          className={styles.input}
          readOnly
          value={revealed ? url : url.replace(/\/feed\/[^.]+\.xml$/, '/feed/••••••••.xml')}
          onFocus={e => e.currentTarget.select()}
          style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
        />
      </div>
      <div className={styles.row} style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className={styles.enableBtn} onClick={() => setRevealed(r => !r)}>
          {revealed ? 'Hide' : 'Reveal'}
        </button>
        <button className={styles.enableBtn} onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
        <button className={styles.enableBtn} disabled={busy} onClick={rotate}>
          {busy ? 'Rotating…' : 'Rotate'}
        </button>
      </div>
    </div>
  );
}

// The favorites list, for review and removal. Adding is possible here but isn't
// the main way in - starring a real tag in the feed or reading list is, since
// that guarantees the stored label is one that actually occurs. This is where
// you come when a favorite turns out to be too broad and is lighting up half
// the feed.
function FavoriteTagsBlock({ favorites, onChange }: {
  favorites: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  function add() {
    const tag = draft.trim();
    if (!tag || !tagKey(tag)) { setDraft(''); return; }
    if (hasFavorite(favorites, tag)) { setDraft(''); return; }
    onChange([...favorites, tag]);
    setDraft('');
  }

  return (
    <div className={styles.sectionBlock} data-setting="favorite-tags">
      <div className={styles.rowLabel}>Favorite tags</div>
      <div className={styles.rowHint}>
        Articles tagged with one of these get a marker so they stand out. Matching is
        by whole word, so “Apple” also catches “Apple News” and “apple-tv” - but not
        “Snapple”. Star a tag on any article to add it here.
      </div>

      <div className={styles.favTagList}>
        {favorites.length === 0 && (
          <span className={styles.favTagEmpty}>No favorites yet.</span>
        )}
        {favorites.map(t => (
          <span key={t} className={styles.favTagItem}>
            {t}
            <button
              className={styles.favTagRemove}
              onClick={() => onChange(favorites.filter(f => f !== t))}
              title={`Remove “${t}”`}
              aria-label={`Remove ${t}`}
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M1 1l10 10M11 1L1 11" />
              </svg>
            </button>
          </span>
        ))}
      </div>

      <div className={styles.favTagAdd}>
        <input
          className={styles.favTagInput}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Add a tag…"
          spellCheck={false}
          aria-label="Add a favorite tag"
        />
        <button className={styles.favTagAddBtn} onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

// A link's site mark, with its first letter as the fallback. Same treatment the
// profile page gives it - a favicon through our own proxy, and a letter when the
// site has none - so the row here previews what the profile will actually show.
function LinkFavicon({ link }: { link: ProfileLink }) {
  const [failed, setFailed] = useState(false);
  const icon = linkIcon(link);
  if (!icon || failed) {
    return <span className={styles.linkFallback} aria-hidden>{linkLabel(link).charAt(0).toUpperCase()}</span>;
  }
  return <img className={styles.linkFavicon} src={icon} alt="" onError={() => setFailed(true)} />;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`${styles.toggle} ${checked ? styles.toggleOn : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

export default function SettingsModal({ settings, onUpdate, onClose, onImport, initialSection, onProfileChange }: Props) {
  // Below this width the two columns don't fit side by side, so the panel
  // becomes a drill-down: the section list, then one section at a time with a
  // back button. Driven from JS rather than CSS alone because the two modes are
  // different trees - the list and the panel are never on screen together.
  const compact = useMediaQuery('(max-width: 720px)');

  // First tab by default. A caller that names a section (the profile's "Edit
  // profile") means it, so that one opens straight into the panel even when
  // compact, where the list would otherwise come first.
  const [section, setSection] = useState<Section>(initialSection ?? NAV[0].id);
  const [showList, setShowList] = useState(!initialSection);
  const [query, setQuery] = useState('');
  const panelVisible = !compact || !showList;

  const bodyRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    return SEARCH_INDEX.filter(e => {
      const hay = `${e.label} ${e.terms} ${sectionLabel(e.section)}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }, [query]);

  // Picking a search result has to survive the section swap: the anchor only
  // exists once the new section has rendered, so the scroll waits for the
  // effect below. The counter makes a second click on the same result a new
  // value, which is what re-runs it.
  const targetSeq = useRef(0);
  const [target, setTarget] = useState<{ anchor: string; n: number } | null>(null);

  const goTo = useCallback((next: Section, anchor?: string) => {
    setSection(next);
    setShowList(false);
    if (anchor) setTarget({ anchor, n: ++targetSeq.current });
  }, []);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let found: HTMLElement | null = null;
    let clear: ReturnType<typeof setTimeout> | undefined;

    // A couple of sections fill themselves in from a fetch - the friends' feed
    // panel renders nothing at all until its URL arrives - so the anchor gets a
    // moment to turn up rather than the jump quietly doing nothing.
    function land(attempt: number) {
      if (cancelled) return;
      found = bodyRef.current?.querySelector<HTMLElement>(`[data-setting="${target!.anchor}"]`) ?? null;
      if (!found) {
        if (attempt < 6) setTimeout(() => land(attempt + 1), 120);
        return;
      }
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      found.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      found.classList.add(styles.flash);
      clear = setTimeout(() => found?.classList.remove(styles.flash), 1500);
    }
    land(0);

    return () => {
      cancelled = true;
      clearTimeout(clear);
      found?.classList.remove(styles.flash);
    };
  }, [target]);

  // Escape closes, and the page behind must not scroll while the panel is up -
  // otherwise the wheel over the modal, or a flick past the end of a section,
  // moves the feed underneath instead. Same contract as the article reader.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCloseRef.current(); }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // ── Profile state ─────────────────────────────────────────────────────────────
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!panelVisible || section !== 'account' || profile) return;
    apiGet<UserProfile>('/api/v1/account').then(p => {
      setProfile(p);
      setFirstName(p.firstName ?? '');
      setLastName(p.lastName ?? '');
      setEmail(p.email ?? '');
    }).catch(() => setProfileError('Could not load profile'));
  }, [panelVisible, section, profile]);

  // Every successful save lands here. Besides the local state and the shell's
  // top-bar avatar, it announces on the window - the profile page renders
  // *underneath* this modal, and would otherwise keep showing the old photo,
  // cover and links until something navigated. ArticleModal signals the same
  // way when its reader closes.
  const applyProfile = useCallback((p: UserProfile) => {
    setProfile(p);
    onProfileChange?.(p);
    window.dispatchEvent(new Event('profile-updated'));
  }, [onProfileChange]);

  async function saveNames() {
    setProfileSaving(true); setProfileError(''); setProfileSaved(false);
    try {
      const p = await apiPatch<UserProfile>('/api/v1/account', {
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        email: email.trim() || null,
      });
      applyProfile(p);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (e) {
      // apiPatch throws with the raw response body - surface the server's message
      let msg = 'Could not save profile';
      if (e instanceof Error) { try { msg = JSON.parse(e.message).error ?? msg; } catch {} }
      setProfileError(msg);
    }
    finally { setProfileSaving(false); }
  }

  // ── First-admin claim (only offered while the instance has no admins) ────────
  const [adminClaimable, setAdminClaimable] = useState(false);
  const [claimToken, setClaimToken] = useState('');
  const [claimError, setClaimError] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  useEffect(() => {
    if (!panelVisible || section !== 'account') return;
    apiGet<{ claimable: boolean }>('/api/v1/account/admin-claim')
      .then(d => setAdminClaimable(d.claimable))
      .catch(() => {});
  }, [panelVisible, section]);

  async function claimAdmin() {
    setClaimBusy(true); setClaimError('');
    try {
      const r = await apiFetch('/api/v1/account/admin-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: claimToken.trim() }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      // Reload so the refreshed session carries the admin flag (shield button appears)
      window.location.reload();
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : 'Could not claim admin');
      setClaimBusy(false);
    }
  }

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    setProfileError('');
    try {
      const avatar = await fileToAvatar(file);
      const p = await apiPatch<UserProfile>('/api/v1/account', { avatar });
      applyProfile(p);
    } catch { setProfileError('Could not update image'); }
  }

  async function removeAvatar() {
    setProfileError('');
    try {
      const p = await apiPatch<UserProfile>('/api/v1/account', { avatar: null });
      applyProfile(p);
    } catch { setProfileError('Could not remove image'); }
  }

  // ── Profile cover ─────────────────────────────────────────────────────────
  // Each of these saves on the spot rather than waiting for "Save profile":
  // picking a gradient or an image is a choice you make by *looking* at the
  // result, so there is nothing for a second confirming click to add.
  const [coverBusy, setCoverBusy] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  async function patchProfile(patch: Record<string, unknown>, failure: string) {
    setProfileError('');
    setCoverBusy(true);
    try {
      applyProfile(await apiPatch<UserProfile>('/api/v1/account', patch));
    } catch (e) {
      let msg = failure;
      if (e instanceof Error) { try { msg = JSON.parse(e.message).error ?? msg; } catch { /* not JSON */ } }
      setProfileError(msg);
    } finally {
      setCoverBusy(false);
    }
  }

  // The cover goes through the ordinary image upload - downscaled in the
  // browser, stored once, referenced by path - rather than the inline data URL
  // an avatar uses. A banner is far too large to carry inside every copy of the
  // profile payload.
  async function handleCoverFile(file: File | undefined) {
    if (!file) return;
    setProfileError('');
    setCoverBusy(true);
    try {
      const { url } = await uploadImage(file);
      applyProfile(await apiPatch<UserProfile>('/api/v1/account', { coverImage: url }));
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : 'Could not update the cover');
    } finally {
      setCoverBusy(false);
    }
  }

  // ── Profile links ─────────────────────────────────────────────────────────
  const [linkPlatform, setLinkPlatform] = useState<string>(LINK_PLATFORMS[0].id);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  const [linksBusy, setLinksBusy] = useState(false);

  // The whole list is sent every time. It is at most eight entries and its order
  // is part of what the owner chose, so there is no sensible per-item endpoint.
  async function saveLinks(next: ProfileLink[]) {
    setLinkError('');
    setLinksBusy(true);
    try {
      applyProfile(await apiPatch<UserProfile>('/api/v1/account', { profileLinks: next }));
      return true;
    } catch (e) {
      let msg = 'Could not save your links';
      if (e instanceof Error) { try { msg = JSON.parse(e.message).error ?? msg; } catch { /* not JSON */ } }
      setLinkError(msg);
      return false;
    } finally {
      setLinksBusy(false);
    }
  }

  async function addLink() {
    const links = profile?.profileLinks ?? [];
    const url = normalizeLinkUrl(linkUrl);
    if (!url) { setLinkError('That doesn’t look like a web address'); return; }
    if (links.some(l => l.url === url)) { setLinkError('That link is already on your profile'); return; }
    if (await saveLinks([...links, { platform: linkPlatform, url }])) {
      setLinkUrl('');
      setLinkPlatform(LINK_PLATFORMS[0].id);
    }
  }

  // Typing or pasting a recognised address picks the service for you - the
  // dropdown is then a correction, not a step.
  function onLinkUrlChange(value: string) {
    setLinkUrl(value);
    setLinkError('');
    const url = normalizeLinkUrl(value);
    if (!url) return;
    const guess = guessPlatform(url);
    if (guess !== WEBSITE_PLATFORM) setLinkPlatform(guess);
  }

  // ── Password state ────────────────────────────────────────────────────────────
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  async function changePassword() {
    setPwError(''); setPwSuccess(false);
    if (newPw.length < 8) { setPwError('New password must be at least 8 characters'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match'); return; }
    setPwSaving(true);
    try {
      const r = await apiFetch('/api/v1/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      setPwSuccess(true);
      setCurPw(''); setNewPw(''); setConfirmPw('');
    } catch (e) { setPwError(e instanceof Error ? e.message : 'Could not change password'); }
    finally { setPwSaving(false); }
  }

  // ── TOTP state ────────────────────────────────────────────────────────────────
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpStep, setTotpStep] = useState<'idle' | 'enrolling' | 'confirming' | 'disabling'>('idle');
  const [enrollData, setEnrollData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);

  useEffect(() => {
    if (!panelVisible || section !== 'account') return;
    apiFetch('/api/v1/totp/status').then(r => r.json()).then(d => setTotpEnabled(d.enabled));
  }, [panelVisible, section]);

  async function handleEnroll() {
    setTotpLoading(true); setTotpError('');
    try {
      const r = await apiFetch('/api/v1/totp/enroll', { method: 'POST' });
      const d = await r.json();
      setEnrollData(d);
      setTotpStep('confirming');
    } catch { setTotpError('Failed to start enrolment'); }
    finally { setTotpLoading(false); }
  }

  async function handleConfirm() {
    if (!enrollData || totpCode.length !== 6) return;
    setTotpLoading(true); setTotpError('');
    try {
      const r = await apiFetch('/api/v1/totp/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      setTotpEnabled(true); setTotpStep('idle'); setEnrollData(null); setTotpCode('');
    } catch (e) { setTotpError(e instanceof Error ? e.message : 'Failed'); }
    finally { setTotpLoading(false); }
  }

  async function handleDisable() {
    if (totpCode.length !== 6) return;
    setTotpLoading(true); setTotpError('');
    try {
      const r = await apiFetch('/api/v1/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: totpCode }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      setTotpEnabled(false); setTotpStep('idle'); setTotpCode('');
    } catch (e) { setTotpError(e instanceof Error ? e.message : 'Failed'); }
    finally { setTotpLoading(false); }
  }

  function cancelTotp() { setTotpStep('idle'); setTotpCode(''); setTotpError(''); setEnrollData(null); }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div
        className={`${styles.panel} ${compact ? styles.compact : ''}`}
        onClick={e => e.stopPropagation()}
      >

        {/* The section list: a rail on the left when there's room, the whole
            panel when there isn't. */}
        {(!compact || showList) && (
          <nav className={styles.nav}>
            <div className={styles.navTop}>
              <div className={styles.navHeader}>Settings</div>
              {compact && (
                <button className={styles.iconBtn} onClick={onClose} aria-label="Close settings">✕</button>
              )}
            </div>

            <div className={styles.searchWrap}>
              <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              <input
                className={styles.searchInput}
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                spellCheck={false}
                autoFocus={!compact}
              />
              {query && (
                <button className={styles.searchClear} onClick={() => setQuery('')} aria-label="Clear search">✕</button>
              )}
            </div>

            <div className={styles.navScroll}>
              {query
                ? (results.length === 0
                    ? <div className={styles.navEmpty}>Nothing here matches “{query.trim()}”.</div>
                    : results.map(r => (
                        <button
                          key={r.anchor}
                          className={styles.resultItem}
                          onClick={() => goTo(r.section, r.anchor)}
                        >
                          <span className={styles.resultLabel}>{r.label}</span>
                          <span className={styles.resultSection}>{sectionLabel(r.section)}</span>
                        </button>
                      )))
                : NAV.map(n => (
                    <button
                      key={n.id}
                      className={`${styles.navItem} ${!compact && section === n.id ? styles.navActive : ''}`}
                      onClick={() => goTo(n.id)}
                    >
                      <span className={styles.navIcon}>{n.icon}</span>
                      <span className={styles.navLabel}>{n.label}</span>
                      {compact && <span className={styles.navChevron} aria-hidden>›</span>}
                    </button>
                  ))}
            </div>
          </nav>
        )}

        {/* The chosen section */}
        {panelVisible && (
        <div className={styles.content}>
          <div className={styles.contentHeader}>
            {compact && (
              <button className={styles.backBtn} onClick={() => setShowList(true)}>
                <span aria-hidden>‹</span> Back
              </button>
            )}
            <div className={styles.contentTitle}>
              {sectionLabel(section)}
            </div>
            <button className={styles.closeBtn} onClick={onClose}>
              ✕<span className={styles.closeLabel}>&nbsp;Close</span>
            </button>
          </div>

          <div className={styles.contentBody} ref={bodyRef}>

            {section === 'search' && (
              <>
                <div className={styles.sectionBlock} data-setting="search-engine">
                  <div className={styles.blockTitle}>Search engine</div>
                  <div className={styles.engineGrid}>
                    {ENGINES.map(e => (
                      <button
                        key={e.id}
                        className={`${styles.engineCard} ${settings.searchEngine === e.id ? styles.engineSelected : ''}`}
                        onClick={() => onUpdate({ searchEngine: e.id })}
                      >
                        <img
                          className={styles.engineFavicon}
                          src={`https://www.google.com/s2/favicons?domain=${e.url}&sz=32`}
                          alt=""
                        />
                        <span className={styles.engineLabel}>{e.label}</span>
                        {settings.searchEngine === e.id && (
                          <span className={styles.engineCheck}>✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="search-new-tab">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Open results in new tab</div>
                      <div className={styles.rowHint}>Search results open in a new browser tab instead of the current one</div>
                    </div>
                    <Toggle
                      checked={settings.searchNewTab}
                      onChange={v => onUpdate({ searchNewTab: v })}
                    />
                  </div>
                </div>
              </>
            )}

            {section === 'appearance' && (
              <>
                <div className={styles.sectionBlock} data-setting="theme">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Theme</div>
                      <div className={styles.rowHint}>Dark, light, or follow your system setting</div>
                    </div>
                    <div className={styles.themePicker}>
                      {(['dark', 'auto', 'light'] as const).map(t => (
                        <button
                          key={t}
                          className={`${styles.themeOption} ${settings.theme === t ? styles.themeOptionActive : ''}`}
                          onClick={() => onUpdate({ theme: t })}
                        >
                          {t === 'dark' ? '🌙 Dark' : t === 'auto' ? '⚙ Auto' : '☀ Light'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="bookmark-layout">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Bookmark layout</div>
                      <div className={styles.rowHint}>Panel shows a folder’s bookmarks in the grid on the right. Inline expands folders in the sidebar, Arc-style.</div>
                    </div>
                    <div className={styles.themePicker}>
                      {(['panel', 'inline'] as const).map(l => (
                        <button
                          key={l}
                          className={`${styles.themeOption} ${(settings.bookmarkLayout ?? 'panel') === l ? styles.themeOptionActive : ''}`}
                          onClick={() => onUpdate({ bookmarkLayout: l })}
                        >
                          {l === 'panel' ? 'Panel' : 'Inline'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="background">
                  <div className={styles.blockTitle}>Background</div>
                  <div className={styles.gradientGrid}>
                    {([
                      { key: 'none',    label: 'None',       swatch: '' },
                      { key: 'default', label: 'Background', swatch: 'radial-gradient(ellipse 90% 70% at 50% 0%, rgba(139,145,255,0.22) 0%, transparent 65%), linear-gradient(180deg, #0b0c13 0%, #08090d 100%)' },
                    ] as const).map(g => {
                      const active = (settings.backgroundGradient ?? 'default') !== 'none'
                        ? g.key === 'default'
                        : g.key === 'none';
                      return (
                        <button key={g.key} className={`${styles.gradientOption} ${active ? styles.gradientActive : ''}`} onClick={() => onUpdate({ backgroundGradient: g.key })}>
                          <div
                            className={styles.gradientSwatch}
                            style={{
                              backgroundColor: 'var(--bg)',
                              backgroundImage: g.swatch || undefined,
                            }}
                          />
                          <span className={styles.gradientLabel}>{g.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {section === 'reading' && (
              <>
                <FavoriteTagsBlock
                  favorites={settings.favoriteTags ?? []}
                  onChange={favoriteTags => onUpdate({ favoriteTags })}
                />

                <div className={styles.sectionBlock} data-setting="rss">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>RSS feeds</div>
                      <div className={styles.rowHint}>
                        Show your feed and auto-detect feeds when you add a bookmark.
                        Turning this off hides all feed content.
                      </div>
                    </div>
                    <Toggle
                      checked={settings.rssEnabled !== false}
                      onChange={v => onUpdate({ rssEnabled: v })}
                    />
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="mark-read">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Mark articles read as you scroll</div>
                      <div className={styles.rowHint}>
                        Unread articles carry a highlighted outline. Scrolling one past the top of
                        the screen marks it read and takes it off its site’s unread badge. Opening
                        an article always marks it read, whether this is on or not.
                      </div>
                    </div>
                    <Toggle
                      checked={settings.markReadOnScroll !== false}
                      onChange={v => onUpdate({ markReadOnScroll: v })}
                    />
                  </div>
                </div>

                <div className={styles.sectionBlock}>
                  <div className={styles.blockTitle}>Comments</div>
                  <div className={styles.row} data-setting="comments-public">
                    <div>
                      <div className={styles.rowLabel}>Show public comments</div>
                      <div className={styles.rowHint}>
                        Include comments other people have made public in your article threads.
                        Turn this off to see only your own private comments.
                      </div>
                    </div>
                    <Toggle
                      checked={settings.commentsShowPublic !== false}
                      onChange={v => onUpdate({ commentsShowPublic: v })}
                    />
                  </div>
                  <div className={styles.row} data-setting="comments-visibility">
                    <div>
                      <div className={styles.rowLabel}>Default visibility for new comments</div>
                      <div className={styles.rowHint}>
                        What each new comment starts as. You can always change a single
                        comment before posting it.
                      </div>
                    </div>
                  </div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'public',  label: 'Public',        hint: 'Anyone using this app can read it' },
                      { value: 'friends', label: 'Friends',       hint: 'Only your accepted friends can read it' },
                      { value: 'private', label: 'Personal Note', hint: 'Only you can read it - a private note' },
                    ] as const).map(opt => {
                      const cur = settings.commentsDefaultVisibility
                        ?? (settings.commentsDefaultPublic ? 'public' : 'private');
                      const active = cur === opt.value;
                      return (
                        <button
                          key={opt.value}
                          className={`${styles.openModeOption} ${active ? styles.openModeSelected : ''}`}
                          onClick={() => onUpdate({ commentsDefaultVisibility: opt.value })}
                        >
                          <div className={styles.openModeRadio}>
                            <span className={active ? styles.radioFilled : styles.radioEmpty} />
                          </div>
                          <div>
                            <div className={styles.openModeLabel}>{opt.label}</div>
                            <div className={styles.rowHint}>{opt.hint}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className={styles.row} data-setting="comments-expand">
                    <div>
                      <div className={styles.rowLabel}>Open threads automatically</div>
                      <div className={styles.rowHint}>
                        Expand the comment thread on every article instead of waiting for a click.
                      </div>
                    </div>
                    <Toggle
                      checked={settings.commentsAutoExpand === true}
                      onChange={v => onUpdate({ commentsAutoExpand: v })}
                    />
                  </div>
                  <div className={styles.openModeList} data-setting="comments-sort">
                    {([
                      { value: 'newest', label: 'Newest first', hint: 'Most recent conversations lead the thread' },
                      { value: 'oldest', label: 'Oldest first',  hint: 'Reads in the order the conversation happened' },
                    ] as const).map(opt => {
                      const active = (settings.commentsSort ?? 'newest') === opt.value;
                      return (
                        <button
                          key={opt.value}
                          className={`${styles.openModeOption} ${active ? styles.openModeSelected : ''}`}
                          onClick={() => onUpdate({ commentsSort: opt.value })}
                        >
                          <div className={styles.openModeRadio}>
                            <span className={active ? styles.radioFilled : styles.radioEmpty} />
                          </div>
                          <div>
                            <div className={styles.openModeLabel}>{opt.label}</div>
                            <div className={styles.rowHint}>{opt.hint}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="save-article">
                  <div className={styles.blockTitle}>Saving articles</div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'dialog',  label: 'Review before saving', hint: 'Opens a dialog to edit the title, tags, and read time first' },
                      { value: 'instant', label: 'Save instantly',       hint: 'Saves with the article’s own title and tags - you can edit later from the card' },
                    ] as const).map(opt => {
                      const active = (settings.saveArticleMode ?? 'dialog') === opt.value;
                      return (
                        <button
                          key={opt.value}
                          className={`${styles.openModeOption} ${active ? styles.openModeSelected : ''}`}
                          onClick={() => onUpdate({ saveArticleMode: opt.value })}
                        >
                          <div className={styles.openModeRadio}>
                            <span className={active ? styles.radioFilled : styles.radioEmpty} />
                          </div>
                          <div>
                            <div className={styles.openModeLabel}>{opt.label}</div>
                            <div className={styles.rowHint}>{opt.hint}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="reading-list-open">
                  <div className={styles.blockTitle}>Reading list</div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'same-tab', label: 'Same tab',       hint: 'Opens saved articles in the current tab' },
                      { value: 'new-tab',  label: 'New tab',        hint: 'Opens saved articles in a new browser tab' },
                      { value: 'reader',   label: 'Reader overlay', hint: 'Shows a 90% overlay - close to come back. Sites that block embedding open in a new tab.' },
                    ] as const).map(opt => {
                      const cur = settings.readingListOpenMode ?? settings.articleOpenMode;
                      const active = cur === opt.value || (opt.value === 'reader' && cur === 'iframe');
                      return (
                        <button
                          key={opt.value}
                          className={`${styles.openModeOption} ${active ? styles.openModeSelected : ''}`}
                          onClick={() => onUpdate({ readingListOpenMode: opt.value === 'reader' ? 'reader' : opt.value })}
                        >
                          <div className={styles.openModeRadio}>
                            <span className={active ? styles.radioFilled : styles.radioEmpty} />
                          </div>
                          <div>
                            <div className={styles.openModeLabel}>{opt.label}</div>
                            <div className={styles.rowHint}>{opt.hint}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="bookmark-open">
                  <div className={styles.blockTitle}>Bookmarks</div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'same-tab', label: 'Same tab', hint: 'Navigate to the bookmarked site in the current tab' },
                      { value: 'new-tab',  label: 'New tab',  hint: 'Open bookmarks in a new browser tab' },
                    ] as const).map(opt => {
                      const active = (settings.bookmarkOpenMode ?? 'same-tab') === opt.value;
                      return (
                        <button
                          key={opt.value}
                          className={`${styles.openModeOption} ${active ? styles.openModeSelected : ''}`}
                          onClick={() => onUpdate({ bookmarkOpenMode: opt.value })}
                        >
                          <div className={styles.openModeRadio}>
                            <span className={active ? styles.radioFilled : styles.radioEmpty} />
                          </div>
                          <div>
                            <div className={styles.openModeLabel}>{opt.label}</div>
                            <div className={styles.rowHint}>{opt.hint}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="page-size">
                  <div className={styles.blockTitle}>Articles per page</div>
                  <div className={styles.pageSizeRow}>
                    {([5, 10, 20, 50] as const).map(n => (
                      <button
                        key={n}
                        className={`${styles.pageSizeBtn} ${(settings.rssFeedPageSize ?? 10) === n ? styles.pageSizeBtnActive : ''}`}
                        onClick={() => onUpdate({ rssFeedPageSize: n })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className={styles.rowHint} style={{ marginTop: 8 }}>
                    How many articles load at once when viewing a feed folder. Use "Load more" to fetch additional articles.
                  </div>
                </div>
              </>
            )}

            {section === 'account' && (
              <>
                <div className={styles.sectionBlock} data-setting="profile">
                  <div className={styles.blockTitle}>Profile</div>

                  <div className={styles.avatarRow}>
                    {profile?.avatar
                      ? <img src={profile.avatar} alt="" className={styles.avatarPreview} />
                      : <div className={styles.avatarFallback}>{(profile?.username ?? '?').charAt(0).toUpperCase()}</div>}
                    <div className={styles.avatarActions}>
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        style={{ display: 'none' }}
                        onChange={e => { handleAvatarFile(e.target.files?.[0]); e.target.value = ''; }}
                      />
                      <button className={styles.enableBtn} onClick={() => avatarInputRef.current?.click()}>
                        {profile?.avatar ? 'Change image' : 'Upload image'}
                      </button>
                      {profile?.avatar && (
                        <button className={styles.cancelBtn} onClick={removeAvatar}>Remove</button>
                      )}
                    </div>
                  </div>

                  <div className={styles.nameGrid}>
                    <div>
                      <div className={styles.fieldLabel}>First name</div>
                      <input className={styles.textInput} type="text" value={firstName} maxLength={100}
                        onChange={e => setFirstName(e.target.value)} placeholder="First name" />
                    </div>
                    <div>
                      <div className={styles.fieldLabel}>Last name</div>
                      <input className={styles.textInput} type="text" value={lastName} maxLength={100}
                        onChange={e => setLastName(e.target.value)} placeholder="Last name" />
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <div className={styles.fieldLabel}>Email</div>
                    <input className={styles.textInput} type="email" value={email} maxLength={254}
                      onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
                  </div>
                  <div className={styles.saveRow}>
                    {profileSaved && <span className={styles.successMsg}>Saved</span>}
                    <button className={styles.enableBtn} onClick={saveNames} disabled={profileSaving}>
                      {profileSaving ? 'Saving…' : 'Save profile'}
                    </button>
                  </div>
                  {profileError && <div className={styles.totpError}>{profileError}</div>}
                </div>

                <div className={styles.sectionBlock} data-setting="cover">
                  <div className={styles.blockTitle}>Profile cover</div>
                  <div className={styles.rowHint} style={{ marginBottom: 12 }}>
                    The banner behind your photo on your profile page. Pick a gradient, or
                    put a picture up there instead.
                  </div>

                  {/* Shown at the profile's own proportions, with the avatar on
                      it, because that is the only question worth answering here:
                      does your face read against this. */}
                  <div
                    className={styles.coverPreview}
                    style={coverStyle(
                      profile?.username ?? '',
                      profile?.coverTheme,
                      profile?.coverImage,
                    )}
                  >
                    <div className={styles.coverPreviewScrim} aria-hidden />
                    {profile?.avatar
                      ? <img src={profile.avatar} alt="" className={styles.coverPreviewAvatar} />
                      : <div className={`${styles.coverPreviewAvatar} ${styles.coverPreviewInitial}`}>
                          {/* The same letter the profile shows: your name where you
                              have one, your handle where you don't - matching
                              displayNameOf on the server. */}
                          {(([firstName, lastName].filter(Boolean).join(' ').trim()
                            || profile?.username || '?').trim()[0] ?? '?').toUpperCase()}
                        </div>}
                  </div>

                  {profile?.coverImage && (
                    <div className={styles.rowHint} style={{ margin: '10px 0 0' }}>
                      Your picture is showing. The gradient underneath it is what you’ll
                      see again if you remove it.
                    </div>
                  )}

                  <div className={styles.coverSwatches}>
                    {COVER_THEMES.map(t => {
                      const active = (profile?.coverTheme ?? COVER_AUTO) === t.id;
                      return (
                        <button
                          key={t.id}
                          className={`${styles.coverSwatch} ${active ? styles.coverSwatchActive : ''}`}
                          disabled={coverBusy}
                          onClick={() => patchProfile(
                            { coverTheme: t.id === COVER_AUTO ? null : t.id },
                            'Could not change the cover',
                          )}
                          title={t.label}
                        >
                          <span
                            className={styles.coverSwatchChip}
                            style={{ background: t.gradient ?? coverStyle(profile?.username ?? '').background }}
                          />
                          <span className={styles.coverSwatchLabel}>{t.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <input
                    ref={coverInputRef}
                    type="file"
                    accept={ACCEPTED_IMAGE_TYPES}
                    style={{ display: 'none' }}
                    onChange={e => { handleCoverFile(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <div className={styles.saveRow}>
                    <button
                      className={styles.enableBtn}
                      disabled={coverBusy}
                      onClick={() => coverInputRef.current?.click()}
                    >
                      {coverBusy ? 'Working…' : profile?.coverImage ? 'Change picture' : 'Use a picture'}
                    </button>
                    {profile?.coverImage && (
                      <button
                        className={styles.cancelBtn}
                        disabled={coverBusy}
                        onClick={() => patchProfile({ coverImage: null }, 'Could not remove the picture')}
                      >
                        Remove picture
                      </button>
                    )}
                  </div>
                </div>

                <div className={styles.sectionBlock} data-setting="links">
                  <div className={styles.blockTitle}>Links</div>
                  <div className={styles.rowHint} style={{ marginBottom: 12 }}>
                    Where else to find you. These show under your name on your profile,
                    for anyone who can see it - up to {MAX_PROFILE_LINKS}.
                  </div>

                  <div className={styles.linkList}>
                    {(profile?.profileLinks ?? []).length === 0 && (
                      <span className={styles.favTagEmpty}>No links yet.</span>
                    )}
                    {(profile?.profileLinks ?? []).map(link => (
                      <div key={link.url} className={styles.linkRow}>
                        <LinkFavicon link={link} />
                        <div className={styles.linkText}>
                          <div className={styles.linkName}>{linkLabel(link)}</div>
                          <a
                            className={styles.linkHref}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {link.url}
                          </a>
                        </div>
                        <button
                          className={styles.cancelBtn}
                          disabled={linksBusy}
                          onClick={() => saveLinks(
                            (profile?.profileLinks ?? []).filter(l => l.url !== link.url),
                          )}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>

                  {(profile?.profileLinks ?? []).length < MAX_PROFILE_LINKS && (
                    <div className={styles.linkAdd}>
                      <select
                        className={styles.linkSelect}
                        value={linkPlatform}
                        onChange={e => setLinkPlatform(e.target.value)}
                        aria-label="Which service"
                      >
                        {LINK_PLATFORMS.map(p => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                      <input
                        className={styles.textInput}
                        type="url"
                        inputMode="url"
                        value={linkUrl}
                        maxLength={300}
                        spellCheck={false}
                        placeholder={LINK_PLATFORMS.find(p => p.id === linkPlatform)?.example}
                        onChange={e => onLinkUrlChange(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
                        aria-label="Link address"
                      />
                      <button
                        className={styles.enableBtn}
                        onClick={addLink}
                        disabled={linksBusy || !linkUrl.trim()}
                      >
                        {linksBusy ? 'Saving…' : 'Add'}
                      </button>
                    </div>
                  )}
                  {linkError && <div className={styles.totpError}>{linkError}</div>}
                </div>

                <div className={styles.sectionBlock} data-setting="password">
                  <div className={styles.blockTitle}>Change password</div>
                  <div className={styles.pwForm}>
                    <input className={styles.textInput} type="password" autoComplete="current-password"
                      placeholder="Current password" value={curPw} onChange={e => setCurPw(e.target.value)} />
                    <input className={styles.textInput} type="password" autoComplete="new-password"
                      placeholder="New password (min. 8 characters)" value={newPw} onChange={e => setNewPw(e.target.value)} />
                    <input className={styles.textInput} type="password" autoComplete="new-password"
                      placeholder="Confirm new password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
                  </div>
                  <div className={styles.saveRow}>
                    {pwSuccess && <span className={styles.successMsg}>Password updated - other devices were signed out</span>}
                    <button
                      className={styles.enableBtn}
                      onClick={changePassword}
                      disabled={pwSaving || !curPw || !newPw || !confirmPw}
                    >
                      {pwSaving ? 'Updating…' : 'Update password'}
                    </button>
                  </div>
                  {pwError && <div className={styles.totpError}>{pwError}</div>}
                </div>

                {adminClaimable && (
                  <div className={styles.sectionBlock}>
                    <div className={styles.blockTitle}>Admin setup</div>
                    <div className={styles.rowHint} style={{ marginBottom: 10 }}>
                      This instance has no administrator yet. Enter the setup token from your
                      server configuration (ADMIN_SETUP_TOKEN) to become the first admin.
                    </div>
                    <div className={styles.totpRow}>
                      <input
                        className={styles.textInput}
                        type="password"
                        placeholder="Setup token"
                        value={claimToken}
                        onChange={e => { setClaimToken(e.target.value); setClaimError(''); }}
                        style={{ maxWidth: 280 }}
                      />
                      <button className={styles.enableBtn} onClick={claimAdmin} disabled={claimBusy || !claimToken.trim()}>
                        {claimBusy ? 'Claiming…' : 'Claim admin'}
                      </button>
                    </div>
                    {claimError && <div className={styles.totpError}>{claimError}</div>}
                  </div>
                )}

              <div className={styles.sectionBlock} data-setting="totp">
                <div className={styles.blockTitle}>Two-factor authentication</div>

                {totpStep === 'idle' && (
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Authenticator app</div>
                      <div className={styles.rowHint}>
                        {totpEnabled
                          ? 'Your account is protected with an authenticator app.'
                          : 'Add a second layer of security using Google Authenticator, Authy, or any TOTP app.'}
                      </div>
                    </div>
                    {totpEnabled
                      ? <button className={styles.dangerBtn} onClick={() => { setTotpStep('disabling'); setTotpError(''); }}>Disable</button>
                      : <button className={styles.enableBtn} onClick={handleEnroll} disabled={totpLoading}>Enable</button>
                    }
                  </div>
                )}

                {totpStep === 'confirming' && enrollData && (
                  <div className={styles.totpEnroll}>
                    <p className={styles.rowHint}>Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.</p>
                    <img src={enrollData.qrDataUrl} alt="QR code" className={styles.qrCode} />
                    <div className={styles.totpSecret}>
                      <span className={styles.rowHint}>Manual entry:&nbsp;</span>
                      <code className={styles.secretCode}>{enrollData.secret}</code>
                    </div>
                    <div className={styles.totpRow}>
                      <input
                        className={`${styles.totpInput}`}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={totpCode}
                        onChange={e => { setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setTotpError(''); }}
                        autoFocus
                      />
                      <button className={styles.enableBtn} onClick={handleConfirm} disabled={totpLoading || totpCode.length !== 6}>
                        {totpLoading ? 'Saving…' : 'Confirm'}
                      </button>
                      <button className={styles.cancelBtn} onClick={cancelTotp}>Cancel</button>
                    </div>
                    {totpError && <div className={styles.totpError}>{totpError}</div>}
                  </div>
                )}

                {totpStep === 'disabling' && (
                  <div className={styles.totpEnroll}>
                    <p className={styles.rowHint}>Enter your current authenticator code to disable 2FA.</p>
                    <div className={styles.totpRow}>
                      <input
                        className={styles.totpInput}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={totpCode}
                        onChange={e => { setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setTotpError(''); }}
                        autoFocus
                      />
                      <button className={styles.dangerBtn} onClick={handleDisable} disabled={totpLoading || totpCode.length !== 6}>
                        {totpLoading ? 'Disabling…' : 'Disable 2FA'}
                      </button>
                      <button className={styles.cancelBtn} onClick={cancelTotp}>Cancel</button>
                    </div>
                    {totpError && <div className={styles.totpError}>{totpError}</div>}
                  </div>
                )}
              </div>
              </>
            )}

            {section === 'advanced' && (
              <>
                <div className={styles.sectionBlock} data-setting="console">
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Console</div>
                      <div className={styles.rowHint}>Enable the backtick (`) console for power-user commands</div>
                    </div>
                    <Toggle
                      checked={settings.consoleEnabled}
                      onChange={v => onUpdate({ consoleEnabled: v })}
                    />
                  </div>
                </div>
                {onImport && (
                  <div className={styles.sectionBlock} data-setting="import">
                    <div className={styles.row}>
                      <div>
                        <div className={styles.rowLabel}>Import bookmarks</div>
                        <div className={styles.rowHint}>Import bookmarks from a browser HTML export or JSON file</div>
                      </div>
                      <button className={styles.enableBtn} onClick={() => { onImport(); onClose(); }}>
                        Import
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {section === 'integrations' && <PersonalFeedPanel />}

            {section === 'integrations' && (() => {
              const origin = typeof window !== 'undefined' ? window.location.origin : '';
              const saveHref = `javascript:(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);window.open('${origin}/?intent=save-article&url='+u+'&title='+t,'_blank','width=500,height=480,popup=1');})();`;
              const bmHref = `javascript:(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);window.open('${origin}/?intent=add-bookmark&url='+u+'&title='+t,'_blank','width=500,height=500,popup=1');})();`;
              return (
                <div className={styles.sectionBlock} data-setting="bookmarklets">
                  <div className={styles.blockTitle}>Browser bookmarklets</div>
                  <div className={styles.rowHint} style={{ marginBottom: 18 }}>
                    Drag these links to your bookmarks bar for one-click saving from any page.
                    Can't drag? Use "Copy URL" then create a bookmark manually and paste into the URL field.
                  </div>
                  <BookmarkletRow label="Save to Reading List" href={saveHref} />
                  <BookmarkletRow label="Add Bookmark" href={bmHref} />
                </div>
              );
            })()}

          </div>
        </div>
        )}
      </div>
    </div>
  );
}
