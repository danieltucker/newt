import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import AuthPage from './pages/AuthPage';
import NewTabPage from './pages/NewTabPage';
import ProfilePage from './pages/ProfilePage';
import PublicArticlePage from './pages/PublicArticlePage';
import BlogPostPage from './pages/BlogPostPage';
import BlogEditorPage from './pages/BlogEditorPage';
import MyBlogPage from './pages/MyBlogPage';
import { parseProfilePath, profilePathFor } from './utils/profileUrl';
import { parseArticlePath } from './utils/articleUrl';
import { parseBlogPath, parseBlogEditPath } from './utils/blogUrl';

export type ThemeSetting = 'dark' | 'light' | 'auto';
export type ResolvedTheme = 'dark' | 'light';

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  return setting === 'auto' ? (prefersDark() ? 'dark' : 'light') : setting;
}

function getInitialSetting(): ThemeSetting {
  return (localStorage.getItem('theme') as ThemeSetting) || 'dark';
}

export default function App() {
  const { accessToken, username, isAdmin, loading, login, register, logout, verifyTotp } = useAuth();
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(getInitialSetting);

  // Lightweight client-side routing (no router dep — same pathname approach as
  // the article deep links). `navigate` pushes history and re-renders in place.
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState({}, '', to);
    setPath(to);
  }, []);
  const viewProfile = useCallback((name: string) => navigate(profilePathFor(name)), [navigate]);

  useEffect(() => {
    const resolved = resolveTheme(themeSetting);
    document.documentElement.setAttribute('data-theme', resolved);
    localStorage.setItem('theme', themeSetting);

    // When in auto mode, track OS preference changes live
    if (themeSetting !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeSetting]);

  if (loading) return null;

  // Blog posts are public — routed ahead of the login wall, and ahead of the
  // profile route, since /u/<name>/<slug> sits under /u/<name>. (parseProfilePath
  // only matches a single segment, so the two can't both claim a path, but the
  // ordering makes the relationship obvious.)
  const blogRef = parseBlogPath(path);
  if (blogRef) {
    return (
      <BlogPostPage
        username={blogRef.username}
        slug={blogRef.slug}
        accessToken={accessToken}
        navigate={navigate}
      />
    );
  }

  // Profiles are public — routed ahead of the login wall so a shared /u/<name>
  // link works for logged-out visitors too.
  const profileUsername = parseProfilePath(path);
  if (profileUsername) {
    return (
      <ProfilePage
        username={profileUsername}
        accessToken={accessToken}
        currentUsername={username}
        navigate={navigate}
      />
    );
  }

  // Shared thread links (/a/<id>) are public too: a logged-out visitor gets a
  // read-only reader. Signed-in users fall through to the app shell, which opens
  // the same reader over their tabs from the same path.
  const articleUrl = parseArticlePath(path);
  if (articleUrl && (!accessToken || !username)) {
    return <PublicArticlePage url={articleUrl} navigate={navigate} />;
  }

  if (!accessToken || !username) {
    return <AuthPage onLogin={login} onRegister={register} onTotpVerify={verifyTotp} />;
  }

  // Authoring your own blog requires being signed in, so these sit below the
  // login wall. '/blog/new' is a composer for a post that doesn't exist yet;
  // '/blog/<id>' edits an existing one.
  if (path === '/blog' || path === '/blog/') {
    return <MyBlogPage accessToken={accessToken} username={username} navigate={navigate} />;
  }
  const editId = parseBlogEditPath(path);
  if (editId) {
    return (
      <BlogEditorPage
        postId={editId === 'new' ? null : editId}
        username={username}
        navigate={navigate}
      />
    );
  }

  return (
    <NewTabPage
      accessToken={accessToken}
      username={username}
      isAdmin={isAdmin}
      themeSetting={themeSetting}
      resolvedTheme={resolveTheme(themeSetting)}
      onSetTheme={setThemeSetting}
      onLogout={logout}
      onViewProfile={viewProfile}
    />
  );
}
