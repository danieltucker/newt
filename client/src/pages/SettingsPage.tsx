import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import styles from './SettingsPage.module.css';
import { UserSettings } from '../hooks/useSettings';
import { useRailMarker, useKeepActiveVisible } from '../hooks/useRailMarker';
import { tagKey, hasFavorite } from '../utils/favoriteTags';
import { apiFetch, apiGet, apiPatch, apiPost } from '../services/api';
import { COVER_AUTO, COVER_THEMES, coverStyle } from '../utils/coverGradient';
import {
  LINK_PLATFORMS, MAX_PROFILE_LINKS, WEBSITE_PLATFORM,
  guessPlatform, linkIcon, linkLabel, normalizeLinkUrl,
  type ProfileLink,
} from '../utils/profileLinks';
import { uploadImage, ACCEPTED_IMAGE_TYPES } from '../utils/imageUpload';
import AiSettingsPanel, { type LlmBinding } from '../components/AiSettingsPanel';
import {
  SETTINGS_SECTIONS, SETTINGS_GROUPS, groupForSection, sectionsInGroup,
  settingsPathFor, type SettingsSection, type SettingsGroup,
} from '../utils/settingsUrl';

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
  onImport?: () => void;
  /**
   * The section the address names, or null for the bare /settings index.
   *
   * The URL is the only copy of this - there is no local "which tab" state to
   * disagree with it - so Back between sections works, and every section is a
   * link somebody can send.
   */
  section: SettingsSection | null;
  /** The one setting the address points at, from the #hash. */
  anchor?: string | null;
  navigate: (to: string, replace?: boolean) => void;
  onProfileChange?: (profile: UserProfile) => void;
  // Passed in rather than hooked up here, so the shell and this screen read the
  // same list: connecting a model has to make the Explore button appear
  // immediately, and two independent copies of that state would disagree.
  llm?: LlmBinding;
}

// Re-exported so callers that only want the union don't have to know it is the
// URL helper that owns it. The list lives there because App has to match a path
// against it before this page is loaded at all.
export type Section = SettingsSection;

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

// The mark beside the word. Small enough that the word is still doing the
// naming - the glyph is only there to be recognised, which is what happens in
// peripheral vision on the way past.
//
// Sliders rather than a cog. A cog at 15px is a circle with short spokes, which
// is the brightness icon, and Appearance is one of the five pills six pixels to
// the right of it - the one place in the app where that confusion has somewhere
// to land.
const SlidersIcon = () => (
  <svg
    className={styles.wordmarkIcon}
    width="15" height="15" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden
  >
    <path d="M2.5 4.25h11M2.5 11.75h11" />
    <circle cx="6" cy="4.25" r="1.75" fill="var(--surface)" />
    <circle cx="10.5" cy="11.75" r="1.75" fill="var(--surface)" />
  </svg>
);

// What each section is called, in the sub-nav and in a search result. Only two
// of the six ever reach the sub-nav - the rest are the whole of their group and
// are named by the pill instead - but a result has to say where it lives
// whichever kind of section it is in.
const SECTION_CHROME: Record<Section, { label: string; icon: ReactNode }> = {
  account:      { label: 'Account',      icon: '◍' },
  search:       { label: 'Search',       icon: '⌕' },
  appearance:   { label: 'Appearance',   icon: '◑' },
  reading:      { label: 'Reading',      icon: <BookOpenIcon /> },
  ai:           { label: 'AI',           icon: '✦' },
  advanced:     { label: 'Advanced',     icon: '⚙' },
};

const sectionLabel = (id: Section) => SECTION_CHROME[id]?.label ?? '';

// The pills. Labels come from the URL helper, which is where the grouping is
// decided; only the glyph is chosen here, because it is presentation and the
// helper has no business knowing about it.
const GROUP_ICONS: Record<SettingsGroup, ReactNode> = {
  account:  '◍',
  newtab:   '⊞',
  reading:  <BookOpenIcon />,
  ai:       '✦',
  advanced: '⚙',
};

// The `data-setting` attributes on the blocks below outlived the search field
// that used to read them, and deliberately: the #anchor is a *URL* feature, not
// a search feature. /settings/reading#comments-sort still lands on the switch it
// names rather than on the section that happens to contain it - which for
// Reading is a long scroll - and that address is parsed in App, carried in the
// `anchor` prop, and answered by the effect below. See utils/settingsUrl.
//
// What went with the search field was the index it matched against: a table of
// every anchor with the words people type looking for it ("2fa" for the
// authenticator, "opml" for the feeds). Nothing else read it.

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

/**
 * The two drag-to-your-toolbar links.
 *
 * The origin is asked of the server rather than read off `window.location`,
 * because a bookmarklet outlives the page it was dragged from. Whoever is
 * looking at Settings may be on the dev server, a LAN address or a forwarded
 * port — all of which work perfectly right now and none of which resolve from
 * the laptop where the bookmark will actually be clicked. PUBLIC_ORIGIN is the
 * address that does.
 *
 * `window.location.origin` is still the fallback: an instance whose operator
 * never set PUBLIC_ORIGIN or CLIENT_ORIGIN is better served by a bookmarklet
 * that works from the current domain than by no bookmarklet at all.
 */
function BookmarkletsPanel() {
  const [origin, setOrigin] = useState(() =>
    typeof window !== 'undefined' ? window.location.origin : '');

  useEffect(() => {
    let cancelled = false;
    apiGet<{ origin: string }>('/api/v1/util/instance')
      .then(d => { if (!cancelled && d.origin) setOrigin(d.origin.replace(/\/+$/, '')); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const open = (intent: string, height: number) =>
    `javascript:(function(){var u=encodeURIComponent(location.href),t=encodeURIComponent(document.title);` +
    `window.open('${origin}/?intent=${intent}&url='+u+'&title='+t,'_blank','width=500,height=${height},popup=1');})();`;

  return (
    <div className={styles.sectionBlock} data-setting="bookmarklets">
      <div className={styles.blockTitle}>Browser bookmarklets</div>
      <div className={styles.rowHint} style={{ marginBottom: 18 }}>
        Drag these links to your bookmarks bar for one-click saving from any page.
        Can't drag? Use "Copy URL" then create a bookmark manually and paste into the URL field.
      </div>
      <BookmarkletRow label="Save to Reading List" href={open('save-article', 480)} />
      <BookmarkletRow label="Add Bookmark" href={open('add-bookmark', 500)} />
      <div className={styles.rowHint} style={{ marginTop: 12 }}>
        These open <code>{origin}</code>.
      </div>
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
        {/* .textInput, not .input - there is no .input in this stylesheet and
            never was, so this field has been rendering as a bare browser input
            in the middle of a styled block. It reads as more than a typo now
            that Integrations has moved into Advanced and this is no longer
            behind its own nav row. */}
        <input
          className={styles.textInput}
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

export default function SettingsPage({
  settings, onUpdate, onImport, section: routeSection, anchor, navigate, onProfileChange, llm,
}: Props) {
  // A bare /settings used to mean two different things by width - the section
  // list on a phone, Account on a wide screen - which is why the address was
  // allowed to stay bare. There is one nav at every width now, so there is only
  // one answer: it shows the first section, and an address that showed a
  // section while claiming to show none would make Back out of
  // /settings/account appear to do nothing. Rewriting it (replace, so it adds
  // no history entry) keeps the URL honest about what is being looked at.
  useEffect(() => {
    if (!routeSection) navigate(settingsPathFor(SETTINGS_SECTIONS[0]), true);
  }, [routeSection, navigate]);

  const section: Section = routeSection ?? SETTINGS_SECTIONS[0];
  // Derived, never addressed. See the note on SETTINGS_GROUPS: putting the group
  // in the URL would break every /settings/<section> link that has already been
  // pasted somewhere, for a level of the nav nobody needs to link to.
  const group = groupForSection(section);
  const subSections = sectionsInGroup(group);

  // Says which screen this is, and the half of that which survives the window
  // being one of nine. Reset on unmount the way every other titled page here
  // does.
  useEffect(() => {
    document.title = `${sectionLabel(section)} · Settings · Newt`;
    return () => { document.title = 'Newt'; };
  }, [section]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const groupRefs = useRef(new Map<SettingsGroup, HTMLElement>());

  // The lozenge behind the lit pill. Sharing the hook with the shell rail and
  // the admin console rather than growing a third of these: one painted box
  // that slides is the same idea whichever axis it runs along.
  const marker = useRailMarker({
    activeId: group,
    elementFor: id => groupRefs.current.get(id as SettingsGroup) ?? null,
    containerRef: navRef,
  });

  // Five pills do not fit a phone, so the row scrolls - and a lit pill off the
  // right-hand edge is a nav that has stopped saying where you are.
  useKeepActiveVisible({
    activeId: group,
    elementFor: id => groupRefs.current.get(id as SettingsGroup) ?? null,
  });

  // Going somewhere in settings is navigation, so every group and every sub-tab
  // is an address rather than a piece of local state.
  //
  // No `target` parameter any more. It existed so a search result could name an
  // anchor as well as a section, alongside a counter that re-fired the scroll
  // when the same result was picked twice — and with the search field gone,
  // nothing inside this page produces an anchored address. A pasted one still
  // lands: that arrives as the `anchor` prop and is answered by the effect
  // below.
  const goTo = useCallback((next: Section) => {
    navigate(settingsPathFor(next));
  }, [navigate]);

  useEffect(() => {
    if (!anchor) return;
    let cancelled = false;
    let found: HTMLElement | null = null;
    let clear: ReturnType<typeof setTimeout> | undefined;

    // A couple of sections fill themselves in from a fetch - the friends' feed
    // panel renders nothing at all until its URL arrives - so the anchor gets a
    // moment to turn up rather than the jump quietly doing nothing. This is
    // also what covers arriving cold on a pasted /settings/ai#ai-models.
    function land(attempt: number) {
      if (cancelled) return;
      found = bodyRef.current?.querySelector<HTMLElement>(`[data-setting="${anchor}"]`) ?? null;
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
  }, [anchor, section]);

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
    if (section !== 'account' || profile) return;
    apiGet<UserProfile>('/api/v1/account').then(p => {
      setProfile(p);
      setFirstName(p.firstName ?? '');
      setLastName(p.lastName ?? '');
      setEmail(p.email ?? '');
    }).catch(() => setProfileError('Could not load profile'));
  }, [section, profile]);

  // Every successful save lands here. Besides the local state and the shell's
  // top-bar avatar, it announces on the window - the profile page is one Back
  // away and would otherwise come back showing the old photo, cover and links
  // off whatever it had already fetched. ArticleModal signals the same way when
  // its reader closes.
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
    if (section !== 'account') return;
    apiGet<{ claimable: boolean }>('/api/v1/account/admin-claim')
      .then(d => setAdminClaimable(d.claimable))
      .catch(() => {});
  }, [section]);

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
    if (section !== 'account') return;
    apiFetch('/api/v1/totp/status').then(r => r.json()).then(d => setTotpEnabled(d.enabled));
  }, [section]);

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

  return (
    <div className={styles.page}>
      <div className={styles.console}>
        {/* One row of pills in place of a seven-row rail, and the same nav at
            every width - the drill-down list, the chevrons and the back button
            are gone with it.

            The rail had to go for the reason the admin console's did: ShellRail
            is already down the left of every page, and two columns of navigation
            side by side argue about which one is the navigation. Seven flat rows
            had a second problem - they gave "Open results in a new tab" and the
            whole of Reading identical weight, so the shape of the list said
            nothing about the shape of what was in it.

            Groups answer "which part of the app", the sub-nav answers "which
            view of it". See SETTINGS_GROUPS for what got folded into what. */}
        <nav
          className={`${styles.nav} ${subSections.length > 1 ? '' : styles.navBare}`}
          ref={navRef}
          aria-label="Settings sections"
        >
          <div className={styles.navRow}>
            {/* Says which screen this is, which the pills never did - they name
                the group, not the page. h1 rather than a decorative span: it is
                the page's heading whatever size it is set in, and a screen with
                no h1 hands a screen reader a document that starts at the nav. */}
            <h1 className={styles.wordmark}>
              <SlidersIcon />
              Settings
            </h1>
            <div className={styles.sectionRow}>
              <span
                className={`${styles.lozenge} ${marker ? styles.lozengeOn : ''}`}
                style={marker ? { transform: `translateX(${marker.left}px)`, width: marker.width } : undefined}
                aria-hidden
              />
              {SETTINGS_GROUPS.map(g => (
                <button
                  key={g.id}
                  ref={el => { if (el) groupRefs.current.set(g.id, el); else groupRefs.current.delete(g.id); }}
                  className={`${styles.sectionItem} ${group === g.id ? styles.sectionActive : ''}`}
                  aria-current={group === g.id ? 'page' : undefined}
                  onClick={() => goTo(g.sections[0])}
                >
                  <span className={styles.sectionIcon} aria-hidden>{GROUP_ICONS[g.id]}</span>
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* Only where there is a choice, which today is New tab alone. A
              sub-nav of one is a row that says nothing twice. */}
          {subSections.length > 1 && (
            <div className={styles.subRow}>
              {subSections.map(s => (
                <button
                  key={s}
                  className={`${styles.subItem} ${section === s ? styles.subActive : ''}`}
                  aria-current={section === s ? 'page' : undefined}
                  onClick={() => goTo(s)}
                >
                  {sectionLabel(s)}
                </button>
              ))}
            </div>
          )}
        </nav>

        <div className={styles.content}>
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
                      const active = (settings.saveArticleMode ?? 'instant') === opt.value;
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

            {section === 'ai' && (
              llm
                ? <AiSettingsPanel
                    llm={llm}
                    depth={settings.aiDepth ?? 'balanced'}
                    feedSearch={settings.aiFeedSearch !== false}
                    showCost={settings.aiShowCost !== false}
                    onUpdate={onUpdate}
                  />
                // Only reachable if this page is rendered outside the shell,
                // which nothing does today — but the section is in the nav, so
                // it needs an answer rather than a blank panel.
                : <div className={styles.rowHint}>AI settings aren’t available here.</div>
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
                      {/* The importer is still a dialog, and it opens over
                          this page rather than in place of it - so coming out
                          of it leaves the reader where they were. */}
                      <button className={styles.enableBtn} onClick={onImport}>
                        Import
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* What Integrations used to hold. Two blocks that were a whole
                nav row between them, now the tail of the section they always
                belonged to. */}
            {section === 'advanced' && <PersonalFeedPanel />}

            {section === 'advanced' && <BookmarkletsPanel />}

          </div>
        </div>
      </div>
    </div>
  );
}
