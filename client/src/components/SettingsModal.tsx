import { useState, useEffect, useRef, type ReactNode } from 'react';
import styles from './SettingsModal.module.css';
import { UserSettings } from '../hooks/useSettings';
import { apiFetch, apiGet, apiPatch, apiPost } from '../services/api';

export interface UserProfile {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
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

// Downscale the chosen image to a small square data URL client-side —
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
// public, the URL itself is the credential — hence the warning and the rotate.
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
    <div className={styles.sectionBlock}>
      <div className={styles.blockTitle}>Your friends’ blog feed</div>
      <div className={styles.rowHint} style={{ marginBottom: 12 }}>
        A private RSS feed of blog posts from you and your friends, including
        friends-only posts. Add it to a folder’s feeds, or any RSS reader.
        <br />
        <strong>Treat this link like a password</strong> — anyone who has it can
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
  const [section, setSection] = useState<Section>(initialSection ?? 'search');

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

  async function saveNames() {
    setProfileSaving(true); setProfileError(''); setProfileSaved(false);
    try {
      const p = await apiPatch<UserProfile>('/api/v1/account', {
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        email: email.trim() || null,
      });
      setProfile(p);
      onProfileChange?.(p);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (e) {
      // apiPatch throws with the raw response body — surface the server's message
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
      setProfile(p);
      onProfileChange?.(p);
    } catch { setProfileError('Could not update image'); }
  }

  async function removeAvatar() {
    setProfileError('');
    try {
      const p = await apiPatch<UserProfile>('/api/v1/account', { avatar: null });
      setProfile(p);
      onProfileChange?.(p);
    } catch { setProfileError('Could not remove image'); }
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

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>

        {/* Left nav */}
        <nav className={styles.nav}>
          <div className={styles.navHeader}>Settings</div>
          {NAV.map(n => (
            <button
              key={n.id}
              className={`${styles.navItem} ${section === n.id ? styles.navActive : ''}`}
              onClick={() => setSection(n.id)}
            >
              <span className={styles.navIcon}>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className={styles.content}>
          <div className={styles.contentHeader}>
            <div>
              <div className={styles.contentTitle}>
                {NAV.find(n => n.id === section)?.label}
              </div>
            </div>
            <button className={styles.closeBtn} onClick={onClose}>✕ Close</button>
          </div>

          <div className={styles.contentBody}>

            {section === 'search' && (
              <>
                <div className={styles.sectionBlock}>
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

                <div className={styles.sectionBlock}>
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
                <div className={styles.sectionBlock}>
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

                <div className={styles.sectionBlock}>
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Clock format</div>
                      <div className={styles.rowHint}>How the header clock and clock widgets display time</div>
                    </div>
                    <div className={styles.themePicker}>
                      {(['12h', '24h'] as const).map(f => (
                        <button
                          key={f}
                          className={`${styles.themeOption} ${settings.clockFormat === f ? styles.themeOptionActive : ''}`}
                          onClick={() => onUpdate({ clockFormat: f })}
                        >
                          {f === '12h' ? '12h' : '24h'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={styles.sectionBlock}>
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

                <div className={styles.sectionBlock}>
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
                <div className={styles.sectionBlock}>
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>RSS feeds</div>
                      <div className={styles.rowHint}>
                        Show feed articles in folders and auto-detect feeds when you add a bookmark.
                        Turning this off hides all feed content.
                      </div>
                    </div>
                    <Toggle
                      checked={settings.rssEnabled !== false}
                      onChange={v => onUpdate({ rssEnabled: v })}
                    />
                  </div>
                </div>

                <div className={styles.sectionBlock}>
                  <div className={styles.row}>
                    <div>
                      <div className={styles.rowLabel}>Mark articles read as you scroll</div>
                      <div className={styles.rowHint}>
                        Unread articles carry a highlighted outline. Scrolling one past the top of
                        the screen marks it read and takes it off its site’s unread badge.
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
                  <div className={styles.row}>
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
                  <div className={styles.row}>
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
                      { value: 'private', label: 'Personal Note', hint: 'Only you can read it — a private note' },
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
                  <div className={styles.row}>
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
                  <div className={styles.openModeList}>
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

                <div className={styles.sectionBlock}>
                  <div className={styles.blockTitle}>Saving articles</div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'dialog',  label: 'Review before saving', hint: 'Opens a dialog to edit the title, tags, and read time first' },
                      { value: 'instant', label: 'Save instantly',       hint: 'Saves with the article’s own title and tags — you can edit later from the card' },
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

                <div className={styles.sectionBlock}>
                  <div className={styles.blockTitle}>Reading list</div>
                  <div className={styles.openModeList}>
                    {([
                      { value: 'same-tab', label: 'Same tab',       hint: 'Opens saved articles in the current tab' },
                      { value: 'new-tab',  label: 'New tab',        hint: 'Opens saved articles in a new browser tab' },
                      { value: 'reader',   label: 'Reader overlay', hint: 'Shows a 90% overlay — close to come back. Sites that block embedding open in a new tab.' },
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

                <div className={styles.sectionBlock}>
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

                <div className={styles.sectionBlock}>
                  <div className={styles.blockTitle}>Feed articles per page</div>
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
                <div className={styles.sectionBlock}>
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

                <div className={styles.sectionBlock}>
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
                    {pwSuccess && <span className={styles.successMsg}>Password updated — other devices were signed out</span>}
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

              <div className={styles.sectionBlock}>
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
                <div className={styles.sectionBlock}>
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
                  <div className={styles.sectionBlock}>
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
                <div className={styles.sectionBlock}>
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
      </div>
    </div>
  );
}
