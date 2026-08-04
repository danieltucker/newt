# newt

A browser new tab replacement that turns your new tab page into a personal productivity dashboard. Manage bookmarks, read RSS feeds, save articles, and keep notes — all in one place.

**Just want to use it? [newt.page](https://newt.page) is the hosted version — sign up and point your new tab at it, nothing to install.** The rest of this README is for running your own instance.

![Tech Stack](https://img.shields.io/badge/React-18-blue) ![Node](https://img.shields.io/badge/Node.js-20-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue) ![Docker](https://img.shields.io/badge/Docker-ready-2496ED)

## Features

- **Bookmarks** — Organize into color-coded folders with drag-and-drop reordering. Import from an HTML bookmark file.
- **Feeds** — One combined feed of everything you follow, newest first. Paste a site address and Newt finds its feed; group feeds into your own categories and filter by category, site or topic. Feeds on bookmarked sites are auto-discovered and offered for import.
- **Reading List** — Save articles with tags, notes, and estimated read time.
- **Favorite Tags** — Star a tag to have matching articles flagged in the feed and reading list. Matching is by whole word, so "Apple" catches "Apple News" and "apple-tv" but not "Snapple".
- **Notes** — A notes console with folders, rich text, and recently deleted.
- **Search** — Quick search bar supporting Google, DuckDuckGo, Bing, and Brave.
- **Themes** — Dark, light, and auto (system) modes.
- **2FA** — TOTP-based two-factor authentication with QR code enrollment.
- **Console** — Backtick (`` ` ``) toggles a power-user command palette (`ip`, `speedtest`, `theme`, and more).

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, CSS Modules |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 17 via Prisma ORM |
| Auth | JWT (access + refresh token rotation), bcryptjs, TOTP |
| Deployment | Docker + Docker Compose, nginx |

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

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_ACCESS_SECRET=replace-with-random-64-char-hex
JWT_REFRESH_SECRET=replace-with-different-random-64-char-hex

# URL users access the app at — must match exactly for CORS
CLIENT_ORIGIN=http://localhost

# Port to expose the web UI on
APP_PORT=80

# Use false for plain HTTP (local), true when behind an HTTPS proxy
COOKIE_SECURE=false

# Set to false once you've created your account(s)
REGISTRATION_ENABLED=true
```

### 2. Run with Docker

```bash
docker-compose up --build
```

This starts three services: PostgreSQL, the Express API, and the nginx-served React frontend. Open `http://localhost` (or your configured `APP_PORT`) to access the app.

### 3. Create your account

Register on first launch. Once done, set `REGISTRATION_ENABLED=false` in `.env` and restart to close sign-ups.

---

## Development

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

### Database scripts

```bash
npm run db:migrate    # Apply Prisma migrations
npm run db:generate   # Regenerate Prisma client
npm run db:studio     # Open Prisma Studio at localhost:5555
```

## Project Structure

```
newt/
├── client/               # React frontend (Vite)
│   ├── src/
│   │   ├── components/   # UI components
│   │   ├── pages/        # AuthPage, NewTabPage
│   │   ├── hooks/        # useAuth, useFolders, useBookmarks, etc.
│   │   └── services/     # API service layer
│   └── Dockerfile
│
├── server/               # Express backend
│   ├── src/
│   │   ├── routes/       # auth, folders, feeds, bookmarks, reading-list, totp...
│   │   ├── middleware/   # Auth guards
│   │   └── lib/          # Logger, DB client
│   ├── prisma/
│   │   └── schema.prisma
│   └── Dockerfile
│
├── docker-compose.yml
├── .env.example
└── package.json          # npm workspaces root
```

## Security Notes

- JWT access tokens are short-lived (15 min); refresh tokens are stored in httpOnly cookies.
- Auth endpoints are rate-limited to 20 requests per 15 minutes.
- Set `COOKIE_SECURE=true` and serve over HTTPS in production.
- Disable registration (`REGISTRATION_ENABLED=false`) after setup on public-facing deployments.

## License

MIT
