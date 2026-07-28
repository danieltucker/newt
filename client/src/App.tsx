import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import AuthPage from './pages/AuthPage';
import LandingPage from './pages/LandingPage';
import NewTabPage, { ShellView } from './pages/NewTabPage';
import ProfilePage from './pages/ProfilePage';
import PublicArticlePage from './pages/PublicArticlePage';
import BlogPostPage from './pages/BlogPostPage';
import FeaturePage from './pages/FeaturePage';
import SelfHostPage from './pages/SelfHostPage';
import { parseProfilePath, profilePathFor } from './utils/profileUrl';
import { parseArticlePath } from './utils/articleUrl';
import { parseBlogPath, parseBlogEditPath } from './utils/blogUrl';
import { isSelfHostPath, parseFeaturePath } from './utils/marketingUrl';

// The two routes that render the sign-in form. Everything else a signed-out
// visitor asks for is either a public page or the landing page.
const AUTH_PATHS = ['/signin', '/signup'];

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

  // Lightweight client-side routing (no router dep - same pathname approach as
  // the article deep links). `navigate` pushes history and re-renders in place.
  // `path` stays pathname-only so every parse*Path helper can keep matching on
  // it whole; the query string is tracked beside it for pages that read one.
  const [path, setPath] = useState(() => window.location.pathname);
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    const q = to.indexOf('?');
    const toPath = q === -1 ? to : to.slice(0, q);
    const toSearch = q === -1 ? '' : to.slice(q);
    if (toPath !== window.location.pathname || toSearch !== window.location.search) {
      window.history.pushState({}, '', to);
    }
    setPath(toPath);
    setSearch(toSearch);
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

  // Signing in leaves the URL on the auth route. Put it back to the app root so
  // a reload (or the back button) doesn't land on a sign-in form the visitor
  // has already been through.
  useEffect(() => {
    if (accessToken && username && AUTH_PATHS.includes(path)) navigate('/');
  }, [accessToken, username, path, navigate]);

  if (loading) return null;

  // Blog posts are matched ahead of profiles, since /u/<name>/<slug> sits under
  // /u/<name>. (parseProfilePath only matches a single segment, so the two can't
  // both claim a path, but the ordering makes the relationship obvious.)
  const blogRef = parseBlogPath(path);
  const profileUsername = blogRef ? null : parseProfilePath(path);
  // ?tab=<name> deep-links a profile tab. Validated by ProfilePage, which owns
  // the list of tabs and which of them are self-only.
  const profileTab = new URLSearchParams(search).get('tab');

  // The marketing pages are matched before the auth split, because they're the
  // same page either way: a signed-in visitor following a link to
  // /features/notes should read it, not be bounced to their new tab. All they
  // change is the nav, which offers a way back into the app instead of the two
  // sign-in buttons.
  const signedIn = Boolean(accessToken && username);
  const featureSection = parseFeaturePath(path);
  if (featureSection) {
    return <FeaturePage section={featureSection} navigate={navigate} signedIn={signedIn} />;
  }
  if (isSelfHostPath(path)) {
    return <SelfHostPage navigate={navigate} signedIn={signedIn} />;
  }

  // Everything public, for a visitor who isn't signed in: a shared /u/<name>
  // link, a post, or a thread link all open standalone. There is no app shell to
  // put them in - no settings, no bookmarks, no notes - so these keep the
  // self-contained layout they were built with.
  if (!accessToken || !username) {
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
    if (profileUsername) {
      return (
        <ProfilePage
          username={profileUsername}
          accessToken={accessToken}
          currentUsername={username}
          navigate={navigate}
          initialTab={profileTab}
        />
      );
    }
    const articleUrl = parseArticlePath(path);
    if (articleUrl) return <PublicArticlePage url={articleUrl} navigate={navigate} />;

    // The sign-in form is now a destination rather than the default: a visitor
    // who has never been here gets told what this is first.
    if (AUTH_PATHS.includes(path)) {
      return (
        <AuthPage
          initialTab={path === '/signup' ? 'register' : 'login'}
          onLogin={login}
          onRegister={register}
          onTotpVerify={verifyTotp}
          navigate={navigate}
        />
      );
    }

    return <LandingPage navigate={navigate} />;
  }

  // Signed in from here down.
  //
  // Profiles, posts, the blog manager and the composer all render *inside* the
  // shell, so the header, search bar, command console and notes stay available
  // wherever they navigate. Anything else is the new tab itself.
  //
  // '/blog/new' composes a post that doesn't exist yet; '/blog/<id>' edits an
  // existing one. The composer used to stand alone, on the grounds that a
  // writing surface shouldn't share keystrokes - but notes are what you write
  // *from*, and having to leave the post to read one was the worse trade. The
  // bare-letter shortcuts already stand down inside a text field (see
  // isTypingTarget), so they never fire mid-sentence.
  const editId = parseBlogEditPath(path);
  const view: ShellView | null =
    editId ? { kind: 'editor', postId: editId === 'new' ? null : editId }
    : blogRef ? { kind: 'post', username: blogRef.username, slug: blogRef.slug }
    : profileUsername ? { kind: 'profile', username: profileUsername, tab: profileTab }
    : (path === '/blog' || path === '/blog/') ? { kind: 'myblog' }
    : null;

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
      navigate={navigate}
      view={view}
    />
  );
}
