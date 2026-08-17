# The Newt extension — concerns, and what the code already decides

Findings from reading the server route layer, the auth middleware and the client
against the proposed extension. Written before any extension code exists, so the
things that would have been discovered late are on the table early.

Each item says what is true today, where, and what it costs to change. Nothing
here is speculative; every claim points at a file.

---

## 1. Auth: the refresh cookie can never reach the extension

**Blocker. Decides the whole auth design.**

`server/src/routes/auth.ts:18` sets the refresh cookie `sameSite: 'strict'`. A
`chrome-extension://` origin is cross-site to the Newt origin, so the browser
will not send it — ever, under any fetch options. The extension therefore cannot
use the SPA's auth flow at all.

Three ways out, and only one is acceptable:

| Option | Verdict |
|---|---|
| Relax the cookie to `sameSite: 'none'` | **No.** Opens CSRF across the entire app to serve one client. The 15-minute access token in memory and the strict cookie are a pair; breaking one to reach the other trades the app's security for the extension's convenience. |
| Have a Newt tab hand the extension its access token via `externally_connectable` | Works, but the token lives 15 minutes and the handshake needs a Newt tab open. The extension would be signed out whenever the user isn't already using Newt — which is most of the time it is meant to be useful. |
| **A device-scoped extension token** | **Yes.** Generated in Settings, pasted once, stored in `chrome.storage.local`, revocable independently of the password. |

There is already a pattern to copy: `GET /blogs/feed-token` and
`POST /blogs/feed-token/rotate` (`server/src/routes/blogs.ts:411-421`).

Two things not to lose when adding it:

- **Store a hash, not the token.** Consistent with how this server already
  treats credentials.
- **Keep the ban check.** `requireAuth` hits the database on every request
  specifically so a ban takes effect immediately rather than when a token
  expires (`server/src/middleware/auth.ts:32-41`). A token path that skips it
  reintroduces exactly the window that comment was written about.

---

## 2. CORS: all network calls must happen in the service worker

**Constraint, not a preference.**

`server/src/app.ts` sets `cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' })`.
The extension origin is not on that list and should not be added — the list is
what keeps arbitrary sites from calling the API with a user's credentials.

This is survivable because MV3 service workers bypass CORS for hosts declared in
`host_permissions`. Content scripts **do not** — they inherit the host page's
origin and are fully subject to it.

So a `fetch` from the injected button will be blocked, and it will be blocked in
a way that looks like an intermittent network failure rather than a policy
error. All API traffic goes through the worker; the content script sends
messages.

---

## 3. Ask gets no context for a page Newt has never seen

**The one that most affects a feature called out as needed.**

`articleContextFor` (`server/src/lib/llm/articleContext.ts:85`) resolves a URL
through BlogPost → FeedItem → ReadingListItem, and returns `null` at line 131 if
none match. Only *after* a match does it consider fetching the page.

For the extension that is the common case, not the edge case: the user is
reading an article Newt has never heard of. Today that question reaches the
model with `sourceUrl` and `sourceTitle` empty — a bare question, no article,
and no indication to the user that the context they were promised is missing.

**The fix:** let it fall through to `articleTextFor` when the caller supplies a
title. Two things make this smaller than it looks:

- `articleTextFor` already goes through `safeFetch`, so the SSRF gate is
  untouched.
- The capability already exists — save an article, then ask about it, and the
  server fetches the page on your behalf. This removes a step, not a guard.

**Keep the guard on `resolveReferences`.** The comment at
`server/src/routes/research.ts:136-141` explains it: that path takes URLs
attached as `/reference` chips, which is a different trust question from the
page the user is demonstrably looking at.

---

## 4. The new tab page cannot be the hosted app

`chrome_url_overrides.newtab` must point at a page bundled in the extension. A
remote URL is not permitted. And iframing the hosted app does not work either:
nginx sends `X-Frame-Options: DENY` for the SPA
(`client/security-headers.conf`), which is deliberate and documented at length
in `server/src/app.ts`.

Three options, all with a real cost:

| Option | Cost |
|---|---|
| Local page that redirects to hosted Newt | Chrome keeps focus in the page, so new-tab-then-type into the omnibox stops working. This is the single most-used interaction with a new tab. |
| Ship the SPA inside the extension | Best experience, largest change. It would run from `chrome-extension://`, so every API call needs to route through the service worker — which the SPA is not built to do. |
| Relax `frame-ancestors` for the extension origin only | Narrowest change, but it is a genuine loosening of a header that was set on purpose. |

Note also that the browser homepage is `chrome_settings_overrides.homepage`
(Windows and macOS only, and Chrome prompts the user to confirm). `homepage_url`
in the manifest is store metadata and does not do this.

**Not resolved.** Worth deciding before step 6 of the build order, and worth
deciding on evidence — the redirect option is cheap to prototype and its cost is
the kind you only feel by living with it.

---

## 5. Notes: correct today, wasteful

The notes tree lives in the settings blob and is written **whole** on every save
(`server/src/routes/settings.ts:126`), guarded by the `notesRev` version check
and the merge in `lib/noteMerge.ts`.

The good news: an extension is precisely the stale-client case that versioning
was built for, and the merge rule — *only one side has it ⇒ kept* — means a note
written from the extension survives a concurrent write from a tab that never
heard of it. Correctness is not at risk.

The cost is bandwidth and races. Jotting one line from a webpage would ship the
user's entire notes history, and two quick notes in a row would each carry a
full tree. Hence the proposed `POST /api/v1/settings/notes` append endpoint. It
is an optimisation, not a fix — worth doing, but not a blocker, and it must
reuse `lib/noteMerge.ts` rather than growing a second merge. The client and
server merges are already required to stay in step; a third copy is how that
stops being true.

---

## 6. The bookmarks rail is the riskiest thing here

A fixed-position strip injected on every site is the most complaint-generating
pattern in browser extensions, for a reason that has nothing to do with code
quality: it collides with whatever the site has already put on that edge. Docs
sites, editors, chat apps and anything with a left nav all lose.

Minimum bar: shadow DOM, a trigger zone no wider than ~6px, a per-site disable,
a global off switch, nothing in fullscreen, and never on Newt itself.

This is why it is last in the build order. It is also the one feature worth
shipping disabled by default and letting people turn on.

---

## 7. Store review will look hard at two things

`<all_urls>` content scripts and settings overrides (new tab + homepage) each
draw extra scrutiny; together, more. Neither is disqualifying and both are
justified here, but the submission needs a single-purpose description, a
per-permission justification, and a privacy policy.

The strongest thing this extension has to say is that it talks only to the
user's own Newt instance and to no third party. That is unusual, it is exactly
what review is trying to establish, and it should be stated plainly rather than
left to be inferred.

---

## 8. Repo layout: one repo, separate workspace

Recommended: `extension/` as a third npm workspace, **not** a separate
repository.

The extension is a second client of the same API, and it shares more than it
looks: the brand assets in `newt-brand/`, the tokens in
`client/src/styles/tokens.css`, the request and response shapes, and the newt
button's own markup and timings. In a second repo every server route change
becomes a silent cross-repo break with nothing to catch it.

What genuinely differs — manifest, CSP, a tiny self-contained bundle, its own
review process — is satisfied by a workspace with its own Vite config. The store
takes a zip and does not care where it was built.

The real cost being accepted: a `shared/` extraction becomes worth doing, at
minimum for the API types. That work exists in the two-repo version too, just
performed worse and later.

---

## What v1.21.0 already did about all this

The in-app newt button was rebuilt as a vertical menu **because of** this
design, so the two start from one shape rather than converging later:

- Pills-in-a-row became one panel with hairline dividers, stacked above the
  button. Four pills do not fit across a phone, and the row needed a second
  layout at 420px to cope — a column needs none, and is flush with whichever
  corner the button is docked to.
- **Share** and **Save** were added, appearing only when there is a page to
  share or save.
- One accessibility defect was found and fixed on the way: the pills' hover
  state (accent text on an accent-tinted background) measured **4.30:1** in the
  light theme, under AA for 13px text. Rows now tint the background only —
  15.10:1 light, 13.47:1 dark. The focus ring had the same problem at 70%
  accent (2.67:1, under the 3:1 for a control boundary) and is now solid.

That last one is worth carrying into the extension: `color-mix()` computes to
`oklab()`, so contrast in this codebase cannot be checked by reading the CSS.
Render it and sample the pixels.
