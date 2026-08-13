import { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import { useAuth } from './hooks/useAuth';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import AuthPage from './pages/AuthPage';
import LandingPage from './pages/LandingPage';
import NewTabPage, { ShellView } from './pages/NewTabPage';
import ProfilePage from './pages/ProfilePage';
import PublicArticlePage from './pages/PublicArticlePage';
import BlogPostPage from './pages/BlogPostPage';

// ── Split out of the main bundle ──────────────────────────────────────────
// The marketing pages and the cross-author hubs. Nobody reaches these by using
// the app - they are arrived at from a link or a search result, one at a time -
// so shipping all four to every visitor who opens a new tab was paying for
// pages that particular visitor will almost certainly never see.
//
// LandingPage, AuthPage and NewTabPage stay eager on purpose: between them they
// are the first thing every visitor sees, signed in or out, and putting a
// network round trip in front of a first paint is the opposite of the point.
const FeaturePage = lazy(() => import('./pages/FeaturePage'));
const HubPage = lazy(() => import('./pages/HubPage'));
const SelfHostPage = lazy(() => import('./pages/SelfHostPage'));

// These render as the whole page rather than over one, so unlike the in-shell
// splits there is nothing already on screen to leave alone. Still nothing
// rather than a spinner: the document has a server-rendered shell behind it
// (see lib/htmlShell), and a flash of chrome-less loader over that is worse
// than a beat of the shell the visitor is already reading.
const PAGE_FALLBACK = null;
import { parseProfilePath, profilePathFor } from './utils/profileUrl';
import { parseArticlePath } from './utils/articleUrl';
import { parseSitePath } from './utils/siteUrl';
import { parseBlogPath, parseBlogEditPath } from './utils/blogUrl';
import { isSelfHostPath, parseFeaturePath } from './utils/marketingUrl';
import { parseTagPath, isRecentPath } from './utils/hubUrl';
import {
  isExplorePath, parseExplorePath, isLegacyResearchPath, explorePathFromLegacy,
} from './utils/researchUrl';

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

// --bg for each theme, duplicated here because a <meta> can't read a custom
// property. Keep in step with styles/tokens.css (and with the pre-hydration
// copies in index.html).
const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#08090F',
  light: '#F2F3F9',
};

/**
 * Paint the browser's own chrome - the iOS status bar strip, Android's toolbar -
 * in the app's background colour. Without this it defaults to black, which is
 * the black bar that sits above the app on a phone whatever theme you're in.
 *
 * index.html ships two of these tags, keyed to prefers-color-scheme, to cover
 * the frame before React mounts. Both get overwritten rather than one: theme is
 * a setting here, so the OS preference the media attributes test is often not
 * the theme on screen, and whichever tag matches has to carry the right colour.
 */
function applyThemeColor(theme: ResolvedTheme) {
  const tags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  tags.forEach(tag => { tag.content = THEME_COLOR[theme]; });
}

export default function App() {
  const { accessToken, username, isAdmin, loading, login, register, logout, verifyTotp } = useAuth();
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(getInitialSetting);

  // Publishes --kb-inset for the full-screen surfaces that have to get out of
  // the keyboard's way on a phone. Mounted here so there is exactly one
  // subscription to the visual viewport for the whole app.
  useKeyboardInset();

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
  /**
   * `replace` swaps the current history entry instead of adding one.
   *
   * For an address that was an instruction rather than a place. `/explore?q=…`
   * tells the page to start a thread; once it has, the thread has its own URL
   * and the instruction is spent. Leaving it in history means Back re-issues it
   * and starts the same thread a second time, which is a worse answer than Back
   * simply going where the reader came from.
   */
  const navigate = useCallback((to: string, replace = false) => {
    const q = to.indexOf('?');
    const toPath = q === -1 ? to : to.slice(0, q);
    const toSearch = q === -1 ? '' : to.slice(q);
    if (replace) {
      window.history.replaceState({}, '', to);
    } else if (toPath !== window.location.pathname || toSearch !== window.location.search) {
      window.history.pushState({}, '', to);
    }
    setPath(toPath);
    setSearch(toSearch);
  }, []);
  const viewProfile = useCallback((name: string) => navigate(profilePathFor(name)), [navigate]);

  // Research became Explore in v1.17.0. Thread links get pasted into notes and
  // messages, so the old address redirects instead of 404ing. `replaceState`
  // rather than a push: the reader never chose to visit /research, so it has no
  // business sitting in their back history.
  useEffect(() => {
    if (!isLegacyResearchPath(path)) return;
    const to = explorePathFromLegacy(path, search);
    window.history.replaceState({}, '', to);
    setPath(to.split('?')[0]);
  }, [path, search]);

  useEffect(() => {
    const resolved = resolveTheme(themeSetting);
    document.documentElement.setAttribute('data-theme', resolved);
    applyThemeColor(resolved);
    localStorage.setItem('theme', themeSetting);

    // When in auto mode, track OS preference changes live
    if (themeSetting !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      const next: ResolvedTheme = e.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      applyThemeColor(next);
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
  // ?tag=<tag> narrows the profile's Posts tab - what a tag on a post links to.
  // Unknown tags are harmless: they simply match nothing.
  const profileTag = new URLSearchParams(search).get('tag');

  // The marketing pages are matched before the auth split, because they're the
  // same page either way: a signed-in visitor following a link to
  // /features/notes should read it, not be bounced to their new tab. All they
  // change is the nav, which offers a way back into the app instead of the two
  // sign-in buttons.
  const signedIn = Boolean(accessToken && username);
  const featureSection = parseFeaturePath(path);
  if (featureSection) {
    return (
      <Suspense fallback={PAGE_FALLBACK}>
        <FeaturePage section={featureSection} navigate={navigate} signedIn={signedIn} />
      </Suspense>
    );
  }
  if (isSelfHostPath(path)) {
    return (
      <Suspense fallback={PAGE_FALLBACK}>
        <SelfHostPage navigate={navigate} signedIn={signedIn} />
      </Suspense>
    );
  }

  // The cross-author hubs, matched here for the same reason the marketing pages
  // are: they read identically signed in or out. A visitor arriving from a
  // search result must land on the page they clicked, and bouncing a signed-in
  // reader to their new tab would break every link the crawlable copy emits.
  const hubTag = parseTagPath(path);
  if (hubTag) {
    return (
      <Suspense fallback={PAGE_FALLBACK}>
        <HubPage hub={{ kind: 'tag', tag: hubTag }} signedIn={signedIn} navigate={navigate} />
      </Suspense>
    );
  }
  if (isRecentPath(path)) {
    return (
      <Suspense fallback={PAGE_FALLBACK}>
        <HubPage hub={{ kind: 'recent' }} signedIn={signedIn} navigate={navigate} />
      </Suspense>
    );
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
          initialTag={profileTag}
        />
      );
    }
    // ?c=<id> aims the thread at one comment - what a comment card on a shared
    // profile links to. Unknown ids are harmless: the reader just opens at the
    // top, which is where it opened before this existed.
    const articleUrl = parseArticlePath(path);
    if (articleUrl) {
      return (
        <PublicArticlePage
          url={articleUrl}
          focusCommentId={new URLSearchParams(search).get('c')}
          navigate={navigate}
        />
      );
    }

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
  //
  // A site page (/s/<domain>) is signed-in only and has no public counterpart:
  // everything on it - which feed deals this publisher, what you saved from it -
  // is one account's own record. For a signed-out visitor the path falls through
  // to the landing page above, which is the honest answer rather than an empty
  // page behind a sign-in wall.
  const editId = parseBlogEditPath(path);
  const siteDomain = parseSitePath(path);
  // Explore is signed-in only and has no public counterpart — a thread is one
  // person's working notes. For a signed-out visitor /explore falls through to
  // the landing page above rather than a sign-in wall, the same way /s/ does.
  //
  // ?url= and ?title= are how an article's Explore button hands the article
  // over: the page starts a thread about it once, on mount.
  const exploreParams = new URLSearchParams(search);
  const view: ShellView | null =
    editId ? { kind: 'editor', postId: editId === 'new' ? null : editId }
    : isExplorePath(path) ? {
        kind: 'explore',
        threadId: parseExplorePath(path),
        seedUrl: exploreParams.get('url'),
        seedQuestion: exploreParams.get('q'),
        seedTitle: exploreParams.get('title'),
      }
    : blogRef ? { kind: 'post', username: blogRef.username, slug: blogRef.slug }
    : profileUsername ? { kind: 'profile', username: profileUsername, tab: profileTab, tag: profileTag }
    : siteDomain ? { kind: 'site', domain: siteDomain }
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
