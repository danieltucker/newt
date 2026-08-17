# Build prompt — the Newt browser extension

A brief you can hand to an agent (or a person) to build the extension in
`extension/`. It assumes the reader has the repo and can read the server's route
layer; it does not restate what the code already says.

Read [extension-concerns.md](extension-concerns.md) first. It holds the four
findings that decide this thing's shape, and building without them produces an
extension that cannot authenticate.

---

## The brief

> Build a Manifest V3 Chrome extension for Newt, as a new npm workspace at
> `extension/` in this repo (alongside `client/` and `server/`).
>
> The extension puts the newt button — the round "n" already in
> `client/src/components/NewtButton.tsx` — into the bottom corner of every page
> the user visits, and offers five things from it: **Ask**, **Notes**, **New
> note**, **Share** and **Save**. It also makes Newt the browser's new tab and
> homepage, and puts the user's Newt bookmarks behind a hover strip on the left
> edge of the screen.
>
> Match `NewtButton.tsx` as it stands after v1.21.0: a vertical menu panel above
> the button, rows separated by hairlines rather than four floating pills, an
> Ask card as its own surface above that, and the button draggable between the
> two bottom corners. That layout was changed *for* this extension — do not
> redesign it, and do not let the two drift.

---

## Ground rules

These are not style preferences. Each one is a constraint the current code
imposes; the reasoning is in `extension-concerns.md`.

1. **Every network call happens in the service worker.** Content scripts are
   subject to CORS and the server's allowlist is `CLIENT_ORIGIN`. The content
   script talks to the worker over `chrome.runtime.sendMessage` and never calls
   `fetch` against the API itself.
2. **Auth is an extension token, not the cookie.** The refresh cookie is
   `sameSite: 'strict'` and will never be sent from `chrome-extension://`. Do
   not relax it. Build the token endpoints described below.
3. **The injected UI lives in a shadow root.** It renders on every site on the
   internet; page CSS must not reach it and its CSS must not reach the page.
4. **Never inject on Newt itself.** The app has its own newt button and its own
   bookmarks. Two would be a bug in the obvious way.
5. **Every row in the menu earns its place.** The rule from `NewtButton.tsx`'s
   header holds here: a way of writing something down, or of keeping, passing
   on, or asking about what you are reading. Nothing else goes in.

---

## Server work, first

Three changes, all in `server/`, all testable with supertest against the
existing route tests before any extension code exists. Do this half first.

### 1. Extension tokens

Copy the shape of the blog feed token (`GET /blogs/feed-token`,
`POST /blogs/feed-token/rotate` in `server/src/routes/blogs.ts`).

- New model `ExtensionToken`: `id`, `userId`, `tokenHash`, `label`,
  `createdAt`, `lastUsedAt`, `revokedAt`. Store a **hash**, not the token —
  see the credential-storage rules already applied elsewhere in this server.
- `POST /api/v1/account/extension-tokens` — mint one, return the plaintext
  **once**. `GET` lists them (label and dates, never the token).
  `DELETE /:id` revokes.
- Accept it in `middleware/auth.ts` as an alternative to the Bearer JWT.
  Keep the ban check: it is the reason `requireAuth` hits the database on
  every request, and a token must not route around it.
- Enrol in SettingsModal, beside the TOTP panel.
- Add a migration by hand — `prisma migrate dev` wants a destructive reset in
  this repo.

### 2. A note append endpoint

`POST /api/v1/settings/notes` — create one note, server-side, and bump
`notesRev`.

The notes tree is written *whole* into the settings blob, guarded by the
`notesRev` merge in `routes/settings.ts`. An extension jotting one line from a
webpage should not have to ship the user's entire notes tree to do it. The merge
protects correctness either way; this is about not sending a megabyte to save a
sentence. Reuse `lib/noteMerge.ts` — do not write a second merge.

### 3. Let Ask see a page Newt has never seen

`articleContextFor` in `server/src/lib/llm/articleContext.ts` returns `null` when
a URL matches no BlogPost, FeedItem or ReadingListItem — so asking about an
arbitrary article resolves to no context at all.

Let it fall through to `articleTextFor` when the caller supplies a title, as the
extension always can (`document.title`). `articleTextFor` already goes through
`safeFetch`, so the SSRF gate is unchanged; what changes is policy, and it is a
policy already reachable by saving an article and then asking about it.

Keep the existing guard for `resolveReferences` — that path takes URLs the user
did not necessarily choose, which is the case the guard was written for.

---

## The extension

### Manifest

MV3. `host_permissions` on the Newt origin (configurable — people self-host).
`storage` for the token. `contextMenus` for right-click → Save. `scripting` and
a content script matching `<all_urls>`, minus the Newt origin.

The new tab is `chrome_url_overrides.newtab` and **must be a local page** — a
remote URL is not allowed, and iframing the hosted app is blocked by the
`X-Frame-Options: DENY` in `client/security-headers.conf`. The homepage is
`chrome_settings_overrides.homepage` (Windows/macOS only, and Chrome prompts the
user), which *can* be remote. `homepage_url` is store metadata and is not this.

Pick the new tab approach deliberately and write down why — the three options
and their costs are in `extension-concerns.md`.

### Build

Vite, as a workspace. Three entry points: service worker, content script, new
tab page. Everything self-contained; MV3 forbids remote code, and shipping any
would fail review.

Check whether `@crxjs/vite-plugin` supports the Vite version this repo is on
(currently Vite 8) before adopting it. If it lags, plain Vite with multiple
entries and a copied manifest is fine and has fewer moving parts.

### What each row does

| Row | Call | Notes |
|---|---|---|
| **Ask** | `POST /api/v1/research/threads` `{question, url, refs}` | Needs server change 3. Opens the thread in a Newt tab. |
| **Notes** | opens Newt on the notes console | Navigation, not an API call. |
| **New note** | `POST /api/v1/settings/notes` | Needs server change 2. |
| **Share** | none | `shareLinkFor` from `client/src/utils/shareLink.ts`. Pure clipboard — port the function, don't call the server. |
| **Save** | `POST /api/v1/reading-list` | Ready as-is. Send `document.title` and the `og:image`; the extension has both for free, so unlike the in-app Save this needs no lookup. |

### The bookmarks rail

`GET /api/v1/bookmarks/all`, cached in `chrome.storage.session`, rendered as a
strip on the left edge that expands on hover.

This is the highest-risk surface in the extension — a fixed-position rail on
every site collides with site chrome, and it is the single most complaint-
generating pattern in extensions. Non-negotiable: a trigger zone no wider than
about 6px, a per-site disable, an off switch, and no rail at all in fullscreen.

Offer `chrome.bookmarks` (read) as a one-time import into Newt. Do not sync
continuously; that is a different feature with a different failure mode.

---

## Build order

Each step is independently verifiable. Do not skip ahead — step 2 proves three
separate assumptions at once, and finding out they were wrong at step 6 is
expensive.

1. Server: the three changes above, with tests.
2. Workspace, service worker, token paste. Prove one round trip: paste the
   token, `GET /api/v1/settings`, show the username. This is the step that
   proves auth, the CORS bypass, and host permissions together.
3. **Save only**, via `contextMenus`. No content script, no injected UI. The
   cheapest possible end-to-end proof.
4. The button, in a shadow root, matching v1.21.0's layout.
5. Ask, Notes, New note, Share.
6. New tab page.
7. The bookmarks rail.

## Before submitting to the store

`<all_urls>` content scripts and settings overrides both draw extra review
scrutiny, and the two together more so. Have ready: a single-purpose
description, a justification per permission, and a privacy policy. The extension
talks only to the user's own Newt instance and no third party — say so plainly,
because it is unusual and it is the thing review is looking for.
