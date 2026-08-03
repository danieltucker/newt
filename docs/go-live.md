# Go-live: first production deploy

End-to-end steps to get newTab running on TrueNAS with the existing dev data.
Read once before starting — step 5 has an ordering rule that is annoying to undo.

Assumes: TrueNAS SCALE 24.10+ (ships Docker), a domain, and something that can
terminate HTTPS in front of the app.

---

## 0. What changed to make this possible

The image builds were broken before this: both Dockerfiles ran `npm ci` from
their own directory, but this is an npm-workspaces monorepo whose only lockfile
is at the repo root. `npm ci` refuses to run without a lockfile in context, so
neither image had ever built.

Fixed by building both images from the repo root and installing with
`npm ci --workspace=<name>`, which reads the root lockfile. That matters beyond
mere convenience: the root lockfile resolves a *nested* tree — vite 7.3.6 at the
root (the only range `@vitejs/plugin-react@4.7.0` accepts) with vite 8.1.3
nested under `client/` and `server/`. Installing either package standalone
resolves a different tree that has never been tested, and for the client it
fails outright with `ERESOLVE`.

---

## 1. Push the build fixes and the workflow

```powershell
cd C:\Users\danie\dev\newTab
git checkout -b deploy/ci-and-docker
git add .dockerignore .github/workflows/publish.yml server/Dockerfile `
        client/Dockerfile docker-compose.yml scripts/deploy/build-and-push.sh docs/go-live.md
git commit -m "Fix workspace-aware Docker builds and add GHCR publish workflow"
git push -u origin deploy/ci-and-docker
```

Open a PR and merge to `master`, or push straight to `master` if you prefer —
the workflow triggers on `master` and on `v*` tags.

> **Never commit `newtab-launch.dump`.** It holds password hashes and TOTP
> secrets. It lives in `C:\Users\danie\dev\newtab-launch\`, outside the repo,
> deliberately.

## 2. Let the workflow build the images

GitHub Actions is the right tool here, not a local build: your dev machine has
no Docker installed and is arm64 while TrueNAS is amd64, so building locally
would mean QEMU emulation. Runners are amd64 natively, and `GITHUB_TOKEN`
authenticates to GHCR with no PAT to create or rotate.

- Watch it at **Actions → Publish images**.
- It builds `server` and `client` in parallel and pushes to
  `ghcr.io/danieltucker/newtab-server` and `.../newtab-client`,
  tagged `latest` plus a short SHA.
- **This is the first real test of the Dockerfiles.** They are verified as far as
  is possible without Docker locally — every `COPY` source exists, and
  `npm run build` for both workspaces passes on this machine — but the image
  layers themselves have only ever been built by this workflow. Expect to read
  the log on the first run.

## 3. Make the images pullable from TrueNAS (remote handling)

New GHCR packages are **private by default**, and a private package cannot be
pulled anonymously.

**If your GitHub repo is public** — simplest path, nothing to store on the NAS:
GitHub → your profile → **Packages** → `newtab-server` → *Package settings* →
**Change visibility → Public**. Repeat for `newtab-client`.

**If your repo is private** — keep the packages private and give the NAS a
read-only credential:

1. GitHub → Settings → Developer settings → **Personal access tokens (classic)**
   → Generate, scope **`read:packages`** only.
2. On the NAS:
   ```bash
   echo '<TOKEN>' | docker login ghcr.io -u danieltucker --password-stdin
   ```
   This writes `~/.docker/config.json` and persists across reboots.

## 4. Prepare TrueNAS

1. **Create datasets** (Storage → Datasets), e.g.
   `/mnt/tank/apps/newtab/pgdata` — a real dataset, so Postgres is covered by
   snapshots and replication.
2. **Copy the deploy files** to the NAS:
   ```powershell
   scp docker-compose.truenas.yml admin@truenas:/mnt/tank/apps/newtab/
   scp C:\Users\danie\dev\newtab-launch\newtab-launch.dump admin@truenas:/mnt/tank/apps/newtab/
   ```
3. **Write the `.env`** next to the compose file (from `.env.truenas.example`).
   Generate fresh secrets — do not reuse dev values:
   ```bash
   openssl rand -hex 24        # POSTGRES_PASSWORD
   openssl rand -hex 32        # JWT_ACCESS_SECRET
   openssl rand -hex 32        # JWT_REFRESH_SECRET  (must differ)
   ```
   Set `PGDATA_HOST_PATH=/mnt/tank/apps/newtab/pgdata`, `GHCR_OWNER=danieltucker`,
   and `CLIENT_ORIGIN=https://your.domain` — exact scheme and host, **no trailing
   slash**, or CORS and auth cookies break.

   You do **not** need `ADMIN_SETUP_TOKEN`: `samwichgamgee` arrives already admin
   in the restored data.

4. **HTTPS.** The client container publishes plain HTTP on `APP_PORT` (default
   `30080`); never use 80/443, those belong to the TrueNAS UI. Point a reverse
   proxy (Nginx Proxy Manager, Caddy, Traefik, or a Cloudflare Tunnel) at
   `http://<truenas-ip>:30080`. `TRUST_PROXY=2` assumes your proxy plus the
   client's nginx — raise it if your edge adds a hop, or rate limiting will key
   on the wrong IP.

## 5. Restore the database — order matters

The server container runs `prisma migrate deploy` on boot. If it starts first it
creates an empty schema and the restore then collides with the tables it made.
**Bring up Postgres alone, restore, then start the rest.**

```bash
cd /mnt/tank/apps/newtab

# 1. Postgres only
docker compose -f docker-compose.truenas.yml up -d postgres
docker compose -f docker-compose.truenas.yml ps        # wait for healthy

# 2. Confirm it is empty — expect "Did not find any relations"
docker compose -f docker-compose.truenas.yml exec -T postgres \
  psql -U newtab -d newtab -c '\dt'

# 3. Restore
docker compose -f docker-compose.truenas.yml exec -T postgres \
  pg_restore -U newtab -d newtab --no-owner --no-privileges --exit-on-error \
  < newtab-launch.dump

# 4. Verify — expect 19
docker compose -f docker-compose.truenas.yml exec -T postgres \
  psql -U newtab -d newtab -c 'select count(*) from "User";'

# 5. Start everything
docker compose -f docker-compose.truenas.yml up -d
```

If step 2 shows tables, the server already booted. Reset and retry:
```bash
docker compose -f docker-compose.truenas.yml stop server client
docker compose -f docker-compose.truenas.yml exec -T postgres \
  psql -U newtab -d postgres -c 'drop database newtab;' -c 'create database newtab owner newtab;'
```

Full detail on what the dump contains and how it was pruned:
`C:\Users\danie\dev\newtab-launch\RUNBOOK.md`.

## 6. Verify

```bash
docker compose -f docker-compose.truenas.yml logs -f server
```

- Expect `migrate deploy` to report **no pending migrations**. Rehearsed
  locally against a copy: `Database schema is up to date!` It will not try to
  alter the restored schema, and the repo's known checksum drift on
  `20260709160746_add_feed_article_image` cannot bite, because `migrate deploy`
  never re-verifies checksums of migrations that already ran.
- Load `https://your.domain`, sign in as `samwichgamgee` with your **existing
  password** — hashes carried over untouched, and your TOTP authenticator entry
  still works.
- Feeds start empty and fill on first sync; every feed was reset so the source
  is re-fetched in full rather than answering `304` with no body.
- Then set `REGISTRATION_ENABLED=false` if you want signups closed, and keep
  `CONSOLE_ENABLED=false` on anything internet-facing.

## 7. Shipping updates afterwards

Push to `master` → the workflow republishes `latest`. On the NAS:

```bash
cd /mnt/tank/apps/newtab
docker compose -f docker-compose.truenas.yml pull
docker compose -f docker-compose.truenas.yml up -d
```

Schema changes ride along: the server runs `migrate deploy` on every boot, so a
new migration applies as the container starts. Add migrations by hand rather
than with `migrate dev` — see the note in the repo about the checksum drift that
makes `migrate dev` demand a destructive reset.

**Rollback.** Every build is also tagged with its short commit SHA, so pin the
previous one in `.env` and redeploy:
```bash
IMAGE_TAG=sha-abc1234 docker compose -f docker-compose.truenas.yml up -d
```

**Back up** before any risky change:
```bash
docker compose -f docker-compose.truenas.yml exec -T postgres \
  pg_dump -U newtab -d newtab -Fc > backup-$(date +%F).dump
```
