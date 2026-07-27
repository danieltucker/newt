import { useState, useRef, useEffect } from 'react';
import styles from './AuthPage.module.css';
import SiteFooter from '../components/SiteFooter';
import NewtMark from '../components/NewtMark';

interface Props {
  onLogin: (username: string, password: string) => Promise<{ requiresTotp: true; totpToken: string; username: string } | void>;
  onRegister: (username: string, password: string) => Promise<void>;
  onTotpVerify: (totpToken: string, code: string) => Promise<void>;
  /** Which form to open on - /signin lands on one, /signup on the other. */
  initialTab?: 'login' | 'register';
  /** Absent when this page has nowhere to go back to. */
  navigate?: (to: string) => void;
}

export default function AuthPage({
  onLogin, onRegister, onTotpVerify, initialTab = 'login', navigate,
}: Props) {
  const [tab, setTab] = useState<'login' | 'register'>(initialTab);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // TOTP step
  const [totpPending, setTotpPending] = useState<{ token: string; username: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const totpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (totpPending) totpRef.current?.focus();
  }, [totpPending]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (tab === 'login') {
        const result = await onLogin(username, password);
        if (result?.requiresTotp) {
          setTotpPending({ token: result.totpToken, username: result.username });
        }
      } else {
        await onRegister(username, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!totpPending || totpCode.length !== 6) return;
    setError('');
    setLoading(true);
    try {
      await onTotpVerify(totpPending.token, totpCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setTotpCode('');
      totpRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  // Auto-submit when 6 digits are entered
  function handleTotpChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    setTotpCode(v);
    if (v.length === 6) {
      setError('');
      setLoading(true);
      onTotpVerify(totpPending!.token, v)
        .catch(err => {
          setError(err instanceof Error ? err.message : 'Verification failed');
          setTotpCode('');
          totpRef.current?.focus();
        })
        .finally(() => setLoading(false));
    }
  }

  if (totpPending) {
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <div className={styles.logo}>New Tab</div>
          <div className={styles.subtitle}>Enter the 6-digit code from your authenticator app.</div>
          <form onSubmit={handleTotpSubmit}>
            <div className={styles.field}>
              <label className={styles.label}>Authentication code</label>
              <input
                ref={totpRef}
                className={`${styles.input} ${styles.totpInput}`}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="000 000"
                value={totpCode}
                onChange={handleTotpChange}
                autoComplete="one-time-code"
              />
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <button className={styles.submit} type="submit" disabled={loading || totpCode.length !== 6}>
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <p className={styles.switchHint}>
              <button
                type="button"
                className={styles.switchLink}
                onClick={() => { setTotpPending(null); setTotpCode(''); setError(''); }}
              >
                Back to sign in
              </button>
            </p>
          </form>
        </div>
        <SiteFooter />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {navigate && (
        <a className={styles.home} href="/" onClick={e => { e.preventDefault(); navigate('/'); }}>
          <NewtMark className={styles.homeMark} />
          What is newt?
        </a>
      )}
      <div className={styles.card}>
        <div className={styles.logo}>New Tab</div>
        <div className={styles.subtitle}>Your bookmarks and reading list, anywhere.</div>

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'login' ? styles.active : ''}`}
            onClick={() => { setTab('login'); setError(''); }}
          >
            Sign in
          </button>
          <button
            className={`${styles.tab} ${tab === 'register' ? styles.active : ''}`}
            onClick={() => { setTab('register'); setError(''); }}
          >
            Create account
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label}>Username</label>
            <input
              className={styles.input}
              type="text"
              placeholder="yourname"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              required
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input
              className={styles.input}
              type="password"
              placeholder={tab === 'register' ? 'At least 8 characters' : '••••••••'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </div>
          {error && <div className={styles.error}>{error}</div>}
          <button className={styles.submit} type="submit" disabled={loading}>
            {loading ? 'Please wait…' : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <p className={styles.switchHint}>
            {tab === 'login' ? (
              <>Don't have an account?{' '}
                <button type="button" className={styles.switchLink} onClick={() => { setTab('register'); setError(''); }}>
                  Create one
                </button>
              </>
            ) : (
              <>Already have an account?{' '}
                <button type="button" className={styles.switchLink} onClick={() => { setTab('login'); setError(''); }}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </form>
      </div>
      <SiteFooter />
    </div>
  );
}
