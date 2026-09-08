# newt

A browser new tab replacement that turns your new tab page into a personal
productivity dashboard. Bookmarks, one combined RSS river, a reading list,
notes, a blog of your own, and an AI that reads what you read.

**Just want to use it? [newt.page](https://newt.page) is the hosted version.
Sign up and point your new tab at it, nothing to install.** The rest of this
README is for running your own instance.

![Tech Stack](https://img.shields.io/badge/React-18-blue) ![Node](https://img.shields.io/badge/Node.js-20-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue) ![Prisma](https://img.shields.io/badge/Prisma-7-2D3748) ![Docker](https://img.shields.io/badge/Docker-ready-2496ED)

![The Newt new tab: pinned bookmarks and colour-coded folders in the sidebar, a reading list with cover artwork, and feed articles carrying unread markers](client/public/shots/hero.png)

Current release: **v1.27.2**. [CHANGELOG.md](CHANGELOG.md) has the release notes,
newest first, and is where the reasoning behind each change lives.

## Features

### Bookmarks

Colour-coded folders with drag-and-drop reordering, pinned tiles across the top
of the sidebar, and two layouts (a right-side panel, or folders that expand in
place). Import from an HTML bookmark file exported by any browser. Paste a plain
address and Newt derives the name, the colour and the favicon; type `http://` in
front and it keeps it, which is what makes a bookmark for a NAS or a router on
your own network work.

Every folder row carries a **+** beside its ⋯, which opens the add-bookmark
dialog already filed into that folder — the folder under the pointer is nearly
always the one you meant. On a narrow window the rail folds into the hamburger
and the folder tree scrolls inside it, so a long list of folders stays reachable
at every width.

![Bookmark folders in the light theme, a tile mid-drag with the drop gap open between two others](client/public/shots/bookmarks-light.png)

### Feeds

One combined river of everything you follow, newest first, never ranked. Paste a
site address and Newt finds its feed; YouTube channels, Reddit, GitHub, Bluesky
and Mastodon resolve too. Group feeds into your own categories and filter by
category, site or topic. Bookmarked sites are checked for a feed and offered,
never subscribed behind your back.

Duplicates are folded, so one story that reaches you through two subscriptions
is one card. Nothing is inserted into the page while you are reading it: new
arrivals show up as a pill you can take or ignore.

**Every control is one bar, and it sticks under the shell bar for as long as the
feed is on screen** — Unread and Filters at one end, Mark all read, Manage feeds
and the layout switch at the other. It never wraps to a second line: as it
narrows, the filter chips fold into a Filters menu and the actions into a ⋯ menu,
labels intact. Category and Site narrow the query itself, so the unread count and
"Load more · N remaining" are counted against whatever you have narrowed to;
Topic sifts the page you are holding.

**Three layouts.** List is a 26px table — title, source, pills and date as real
columns that line up down the page, about twenty-six articles to a screen. Cards
is a dense grid, magazine a wider one with feature cards spanning two tracks.
Both grids draw an article's cover art when it has one. Unread is a 3px accent
bar in the gutter rather than a tinted card, which is what stays legible at list
heights.

Each card carries a **Save** pill that says how many *people* have kept the
article, a comment count, and a caret with Explore, Repost and Share behind it.
Share copies this instance's page for the piece —
`newt.page/s/www.example.com/2026/sep/05/the-headline` — which is a link somebody
can read before opening, and which lands where the conversation is rather than at
the bare source.

![The feed article list with unread outlines and gold favourite chips](client/public/shots/feeds.png)

### Reading list and Library

Save articles with tags, notes and an estimated read time. Finished pieces go to
the Library, which is organised with shelves of your own. Folders contain, tags
describe, and the two are deliberately separate systems. Shelves are a group in
the same filter bar the feed uses, so picking one swaps the pile rather than
narrowing it.

Clearing an article off the reading list **archives** it onto a shelf called
Archived rather than deleting it — an ordinary shelf in every respect except that
it cannot be deleted, since deleting a shelf tips its contents into Unsorted and
that would empty the archive in a single press. Un-saving outright lives in the
Save menu.

![The reading list open over the page in the light theme: shelf chips across the top, then a grid of saved articles with cover artwork and read times](client/public/shots/reading-light.png)

### Search

The box in the header searches here first. A plain query opens **`/search`**: six
corpora at once — feed articles, posts, explores, your saved articles, your
bookmarks and your notes — each in its own section with a count, and a tab per
corpus for when you know which one you want. Both the query and the tab are in
the address, so a result set is something you can send to somebody or come back
to.

Results are the feed's own cards, at the feed's own measurements, under the
feed's own control bar, and they carry the feed's Save and Discuss buttons.
Narrowing to one kind of result scrolls, the same way the river does.

The web is one keystroke away rather than gone: `/g`, `/d`, `/b` and `/br` go
straight out to Google, DuckDuckGo, Bing or Brave, the dropdown offers both in
that order, and a typed hostname still goes to the hostname.

Ranking is deliberately blind — it ranks every matching row on the instance — and
the tiers-and-blocks visibility rule the rest of the app runs on is applied
afterwards, in one place. Your own drafts and private explores appear in your own
results, badged as what they are. A post's body and an explore's transcript are
deliberately **not** indexed: the first is sanitized HTML, and the second quotes
your private notes back at you.

### Explore, Proofread and /ask (bring your own model)

Newt can use an AI model, and the model is yours. Paste your own API key into
Settings → AI, and the provider bills you. There is no shared key and no
operator account behind it. Until you connect one, none of these features appear
in the interface at all.

- **Explore** at `/explore` is a saved thread, not a chat window. Ask a
  question, keep asking, come back to it next week. Any article or post has an
  Explore button that opens a thread with that piece as context.
- **The article is actually read.** Most feeds publish a two-sentence teaser, so
  Newt fetches the article's own page when the stored copy is too thin, caches
  the text and shares it between readers. When a paywall or a consent wall
  blocks it, the model is told it only has a summary rather than left to write
  confidently about something it never saw.
- **Your own feed is searchable by the model.** Your model has a training
  cutoff, which makes it weakest exactly where you are most curious. Asking
  about something current searches the articles already in your database, scoped
  to your own subscriptions, and cites them as ordinary links. Nothing is
  fetched for this.
- **Proofread** in the composer reports and does not rewrite. Each finding is a
  quote from your draft, a reason and a suggestion; you make the change.
- **`/ask your question`** from the search bar opens it in Explore instead of
  sending you to a search engine.
- **`/reference`** decides what the model reads. Type it in Explore's composer
  to attach up to four pieces to your next question — from what you have saved,
  what you have written, or the whole archive of your feeds — and they stay with
  the question in the transcript. The search bar takes it too, as the short way
  round: pick an article there and Explore opens with it already attached.
  Nothing is fetched for this either; it points at what you already have.
- **Condense into a post** turns a thread that got somewhere into a private
  draft.
- **A thread can be shared**, on the same three tiers as comments and posts, and
  a shared one gets an address of its own at `/e/<id>` that opens for a reader
  with no account. It is read-only in the strong sense: the route behind it
  cannot call a model at all, so nobody can continue your research on your
  credit. Sharing is a dialog that shows you every message about to become
  visible, because an explore is answered partly with your own writing —
  *including the private tier the interface calls a Personal Note*.
- **Explored paths.** An article page lists what has been *shared* about the
  piece: explores their authors published, and posts written about it. Your own
  private threads are never listed, not even to you.

Three providers work: **Claude**, **ChatGPT**, and anything speaking the OpenAI
format at a URL you supply, which covers Ollama, OpenWebUI, LM Studio, vLLM,
OpenRouter and the rest. Answer length (Brief, Balanced, Thorough) sets how hard
the model thinks as well as how much it writes, because thinking is billed as
output.

One constraint people hit: **a self-hosted endpoint has to be reachable from the
internet.** A LAN address like `192.168.1.50:11434` or `localhost` is refused.
Newt accepts sign-ups, and a server that fetches any URL an account gives it is
a server that maps the network it sits in on that account's behalf. Publish the
box through a tunnel or a reverse proxy with TLS and it works. The single
exception is the instance's own model below, which is configured by whoever has
shell access to the host rather than by an account.

### The instance's own model (optional, admin only)

Separately from the per-user keys above, an operator can give the instance a
model of its own and point **AI tasks** at it, from **Admin → AI**. None of it is
on by default, and the whole subsystem switches off with `AI_QUEUE=false`.

- **Endpoints** live in Admin → AI → Models: add several, mark one default, test
  one, list what a box is serving, and — for Ollama — pull and delete weights
  from the panel. Every generation is logged with tokens, wall-clock duration and
  any error text, and the Usage panel reports medians and p95s over 30 days.
  Percentiles exclude failures, zero tokens means "not reported" rather than
  "free", and an average over no samples is null rather than zero.
- **Tasks** are a kind, a prompt, an endpoint and a trigger. Three kinds exist:
  `explore` writes a thread about an article, `moderate` scores comments, and
  `relate` finds the same story on two different sites and puts a "Related
  coverage" line on both pages.
- **The safety floor is appended after the admin's prompt.** An admin can steer a
  model; they cannot remove the floor.
- **Moderation has no delete verdict and no ban.** The strongest automated action
  is hiding a comment — reversible, and deliberately not the author's own
  tombstone. `enforce` defaults to off, so shadow mode scores everything and acts
  on nothing while the verdicts accumulate.
- **Generated threads are created private** and need an admin to publish them.
- **One job at a time, globally.** A GPU serialises anyway, and two models on one
  card means an unload and reload on every alternation.

The one setting that stays in the environment is `OPERATOR_LLM_PRIVATE_HOSTS`:
which private hosts the site model may reach. Changing which model answers is a
preference and belongs in a UI; letting the server open connections inside your
network is a capability, and that stays gated on shell access to the host. With
the list empty, the panel accepts only public endpoints.

### Notes

A notes console with folders, rich text, slash commands, colours and highlights,
find and replace, references to your own saved articles and posts, and a recently
deleted shelf. The tree is versioned, so a tab you left open all morning cannot
post its stale copy over a day of writing.

![The notes console over the dimmed page, folders on the left and the slash menu open in a note](client/public/shots/notes-light.png)

### Posting and profiles

Write posts with a rich editor that handles image galleries, tags and drafts.
Your posts go out as their own RSS feed, so other people can follow you the same
way they follow anything else. Profiles have followers, friends, comment threads
with nesting, and a public post list at `/u/<name>`. Your own posts are managed
from a console at `/blog`, with All / Published / Drafts pills carrying the
counts.

![A published post: cover image, byline, an article reference card in the body, and the comment thread below](client/public/shots/blog.png)

A profile is a public page. This one is live at
[newt.page/u/samwichgamgee](https://newt.page/u/samwichgamgee):

![A public profile: avatar, post and comment counts, and the Posts tab listing a post built around a saved article](client/public/shots/profile-light.png)

### The rest

- **Site pages.** Click a site name on any card for `/s/<domain>`: everything
  that publisher has put in your feed, everything you have saved from it, and
  where it sits in your folders and categories.
- **Hubs.** `/t/<tag>` gathers everything written under a tag across authors, and
  `/recent` is the instance's latest. Both read identically signed in or out.
- **Favourite tags.** Star a tag to have matching articles flagged in the feed
  and reading list. Matching is by whole word, so "Apple" catches "Apple News"
  and "apple-tv" but not "Snapple". Favourites sit at the head of the Topic
  filter rather than being a filter of their own.
- **Safety.** Blocking is a mutual wall rather than a mute, plus reporting,
  and an admin review queue behind both.
- **Notifications.** An in-app bell for replies, follows and friend requests.
  There is no SMTP anywhere in this server.
- **Admin panel.** Four sections — Overview, Moderation, System, AI. Overview
  answers "what needs me?" before "how big is the database?": open reports,
  failing feeds and errors in the last 24 hours, above the stat cards. Moderation
  holds reports, users, comments and posts; System holds feed health, the refresh
  log, the error log and an audit trail.
- **Themes.** Dark, light and auto. The screenshots above mix the two, which is
  the quickest way to see that neither is an afterthought.
- **2FA.** TOTP with QR enrolment.
- **Console.** Backtick (`` ` ``) toggles a command palette: `ip`, `dns`,
  `speedtest`, `theme`, `folder`, `add`, `version`, and `ping` / `tracert` for
  admins.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, CSS Modules |
| Backend | Node.js 20, Express 4, TypeScript |
| Database | PostgreSQL 17 via Prisma 7 |
| Search | Postgres full-text over stored generated `tsvector` columns |
| Auth | JWT (access plus refresh token rotation), bcryptjs, TOTP |
| AI | Per-user API keys, sealed with AES-256-GCM. Anthropic, OpenAI, or any OpenAI-compatible endpoint |
| Deployment | Docker Compose, nginx |

## Getting Started

### Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose (recommended)
- Or: Node.js 20+ and PostgreSQL 17

### 1. Clone and configure

```bash
git clone https://github.com/danieltucker/newt.git
cd newt
cp .env.example .env
```

Edit `.env` and fill in the required values:

```env
# Strong random password for PostgreSQL
POSTGRES_PASSWORD=changeme

# Generate each with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_ACCESS_SECRET=replace-with-random-64-char-hex
JWT_REFRESH_SECRET=replace-with-different-random-64-char-hex

# Encrypts the AI keys users connect, and their TOTP secrets. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
LLM_KEY_SECRET=replace-with-random-base64-32-bytes

# URL users access the app at. Must match exactly for CORS.
CLIENT_ORIGIN=http://localhost

# Port to expose the web UI on
APP_PORT=80

# Use false for plain HTTP (local), true when behind an HTTPS proxy
COOKIE_SECURE=false

# Set to false once you have created your account(s)
REGISTRATION_ENABLED=true
```

The server refuses to start in production without the three secrets. Back all
three up with your database. `LLM_KEY_SECRET` in particular is worth knowing
about before you touch it: rotating it makes every stored AI key undecryptable
*and* locks every 2FA-enrolled user out until an admin clears their enrolment.

The optional ones, all passed through by both compose files, and all in
`.env.example` bar `SHELL_ORIGIN`, which is commented where it is set:

| Variable | What it does |
|---|---|
| `TRUST_PROXY` | Proxy hops in front of the server, so per-IP rate limiting sees the real client. Leave unset for `npm run dev`, `1` for the local Docker stack, `2` behind your own reverse proxy. |
| `CONSOLE_ENABLED` | `false` turns off the `ping` and `tracert` endpoints entirely. |
| `ADMIN_SETUP_TOKEN` | One-time bootstrap secret. While the instance has zero admins, a signed-in user can claim admin from Settings → Account by entering it. Inert once an admin exists. |
| `AI_CRAWLERS` | `deny` (the default) or `allow`, as `robots.txt` will report it for GPTBot, ClaudeBot, CCBot and the rest. Denying is reversible; allowing is not. |
| `PUBLIC_ORIGIN` | The address strangers type in, when it differs from `CLIENT_ORIGIN`. Used for feed and share URLs. |
| `SHELL_ORIGIN` | Where the server fetches the built `index.html` to wrap its server-rendered pages in. The client service by name; change it only if that service is renamed. |
| `OPERATOR_LLM_PRIVATE_HOSTS` | Comma-separated hosts the instance's own model may reach inside your network. Empty means public endpoints only. |
| `OPERATOR_LLM_BASE_URL` / `_MODEL` / `_KEY` | How the site model was configured before the admin panel existed. Still honoured as a fallback when no endpoint has been added in Admin → AI → Models. |
| `FEED_SCHEDULER` / `AI_QUEUE` | `false` on either switches off the background feed poller or the AI job worker. |

A variable only reaches the server if it is listed under `server.environment` in
the compose file you are running. Both files carry the full set above, so setting
one in `.env` is enough; if you add a new one to the server, add it there too or
it will be silently ignored.

### 2. Run with Docker

```bash
docker compose up --build
```

This starts three services: PostgreSQL, the Express API, and the nginx-served
React frontend. Open `http://localhost` (or your configured `APP_PORT`).

`docker-compose.truenas.yml` is the production variant: pre-built images from
GHCR, a host path for PGDATA, the full environment, and a commented-out Ollama
service for an instance model with the sizing notes to go with it.

### 3. Create your account

Register on first launch. Once done, set `REGISTRATION_ENABLED=false` in `.env`
and restart to close sign-ups.

```bash
npm run make-admin --workspace=server -- <username>
```

gives that account the admin panel. On a deployment where you would rather not
shell in, set `ADMIN_SETUP_TOKEN` before first boot and claim admin from
Settings → Account instead.

## Development

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

### Database scripts

All of these are server-workspace scripts:

```bash
npm run db:deploy   --workspace=server   # apply pending migrations (use this one)
npm run db:generate --workspace=server   # regenerate the Prisma client
npm run db:studio   --workspace=server   # Prisma Studio at localhost:5555
```

`db:migrate` (`prisma migrate dev`) exists but will offer to reset the database
on this schema, because an early migration was edited after it ran and its
checksum no longer matches. Write the migration SQL by hand under
`server/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/` and apply it with
`db:deploy`, which never offers a reset. `prisma migrate status` is safe to run
at any time.

### Tests and checks

```bash
npm test                          # client and server
npm run test --workspace=client
npm run test --workspace=server

npm run check:html                # server-rendered pages parse and stay in shape
node scripts/check-css.mjs        # orphaned custom properties and contrast
node scripts/measure-filter-bar.mjs   # sweeps the feed's control bar across
                                      # eighteen widths, failing on a wrap or an
                                      # overflow; --filtered sweeps with two
                                      # active filter pills showing
```

### Screenshots

The images in this README and on the marketing pages are generated, not
hand-captured, from seeded fictional accounts:

```bash
npm run seed-showcase --workspace=server   # build the accounts and their content
npm run shots                              # capture all of them, dark theme
npm run shots -- --light                   # the same set in light, as <id>-light.png
npm run shots -- feeds notes               # or just the ones you need
npm run marketing:check                    # confirm the pages render them
```

They land in `client/public/shots/`. One of them, `profile`, is taken against
the live site signed out, so it needs neither the dev server nor the database.
See the README in that folder for the per-shot notes.

## Project Structure

```
newt/
├── client/                 # React frontend (Vite)
│   ├── public/shots/       # Generated screenshots
│   └── src/
│       ├── components/     # UI components
│       ├── pages/          # NewTabPage, SearchPage, SitePage, HubPage,
│       │                   # ResearchPage (Explore), SharedExplorePage, Admin...
│       ├── hooks/          # useAuth, useFolders, useBookmarks, useSettings...
│       ├── marketing/      # Landing and feature page copy (sections.ts)
│       ├── services/       # API service layer
│       ├── styles/         # pageConsole.module.css - shared console chrome
│       └── utils/          # Shared pure helpers, unit tested
│
├── server/                 # Express backend
│   ├── src/
│   │   ├── routes/         # auth, folders, feeds, bookmarks, blogs, search,
│   │   │                   # llm, research, adminAi, adminSiteModels...
│   │   ├── middleware/     # Auth guards, error handler
│   │   └── lib/
│   │       ├── ai/         # Tasks, triggers, job queue, explore/moderate/relate
│   │       ├── llm/        # Provider adapters, site models, chat
│   │       └── ...         # Feeds, SSRF gate, search, logger, DB client
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   ├── scripts/            # make-admin, backfills and showcase seeds
│   └── Dockerfile
│
├── scripts/                # shots.mjs, marketing/HTML/CSS checks, filter-bar sweep
├── docs/                   # Go-live notes and design write-ups
├── docker-compose.yml
├── docker-compose.truenas.yml
├── .env.example
└── package.json            # npm workspaces root
```

## Security Notes

- JWT access tokens are short-lived (15 min). Refresh tokens live in httpOnly
  cookies and are stored **hashed**, so a database dump does not hand over live
  sessions.
- TOTP secrets and AI API keys are stored **encrypted** (AES-256-GCM under
  `LLM_KEY_SECRET`), because both have to be read back. Passwords are bcrypt at
  cost 12.
- **Every user-supplied URL the server fetches goes through one SSRF gate**:
  feed discovery, feed polling, favicons, article text and self-hosted AI
  endpoints. Redirects are followed by hand so each hop is re-checked against
  the address that passed, rather than trusting the fetch library.
- **The one address family that gate lets through is the operator's**, named in
  `OPERATOR_LLM_PRIVATE_HOSTS` on the host machine and nowhere else, and
  connected to over an agent pinned to the address just validated. An admin web
  session cannot grant this.
- **A shared explore cannot spend your money.** The public `/e/<id>` route has no
  path to a model at all, rather than a check that it is not being asked for one.
- Auth endpoints are rate-limited to 20 requests per 15 minutes per IP. Writes
  are additionally metered per account, so rotating IPs does not buy more.
- Set `COOKIE_SECURE=true` and serve over HTTPS in production, and set
  `TRUST_PROXY` to match your setup or per-IP limiting sees only the proxy.
- Disable registration (`REGISTRATION_ENABLED=false`) after setup on
  public-facing deployments.

## License

MIT
