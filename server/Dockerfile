# ─────────────────────────────────────────────────────────────────────────────
# Build context is the REPO ROOT, not ./server:
#     docker build -f server/Dockerfile .
#
# This is a npm-workspaces monorepo and the only lockfile is the root one. It
# resolves a nested tree (vite 7 at the root to satisfy @vitejs/plugin-react's
# peer range, vite 8 nested under client/ and server/) that a per-package
# install cannot reproduce — installing server/package.json on its own resolves
# a different, never-tested dependency tree. `npm ci --workspace=server` reads
# the root lockfile and installs exactly the versions that work in dev.
# ─────────────────────────────────────────────────────────────────────────────

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Manifests + lockfile first so the install layer caches until deps change.
# Both workspace manifests are needed: npm validates the whole workspace set
# against the lockfile even when installing only one of them.
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json

# The Prisma schema must exist before install: server's postinstall runs
# `prisma generate`, and prisma.config.ts is what supplies the datasource URL
# (schema.prisma deliberately declares no `url`).
COPY server/prisma server/prisma
COPY server/prisma.config.ts server/prisma.config.ts

RUN npm ci --workspace=server

COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src
RUN npm run build --workspace=server

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Keep the workspace layout intact. Dependencies are split across the hoisted
# root node_modules and server/node_modules (the generated @prisma client lands
# in the nested one), so flattening the tree here would break module resolution.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server

WORKDIR /app/server
EXPOSE 3001

# Apply any pending migrations, then start. `migrate deploy` is a no-op when the
# database is already current — and unlike `migrate dev` it never re-verifies
# checksums of migrations that already ran, so historical checksum drift in this
# repo cannot block a production boot.
CMD ["sh", "-c", "../node_modules/.bin/prisma migrate deploy && node dist/index.js"]
