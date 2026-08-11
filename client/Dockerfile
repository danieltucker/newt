# ─────────────────────────────────────────────────────────────────────────────
# Build context is the REPO ROOT, not ./client:
#     docker build -f client/Dockerfile .
#
# See server/Dockerfile for the full reasoning. Short version: the root
# package-lock.json is the only validated dependency tree in this workspace,
# and `npm ci --workspace=client` is what reproduces it.
# ─────────────────────────────────────────────────────────────────────────────

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json

# Install scripts run deliberately: esbuild (under vite) fetches its platform
# binary in a postinstall, and the build fails without it.
RUN npm ci --workspace=client

COPY client/ client/
# The client's build script ends by verifying the HTML it just produced (see
# scripts/check-html.mjs). It runs here, in the image build, on purpose: a
# document that loads no application is not something to discover after the
# container is serving it.
COPY scripts/ scripts/
RUN npm run build --workspace=client

# ── Runtime stage (nginx) ─────────────────────────────────────────────────────
FROM nginx:alpine AS runner
COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
# Included by both document-serving locations in nginx.conf. Not in conf.d/,
# because everything in conf.d is auto-included into http{} and a bare list of
# add_header directives there would apply to every response on the server.
COPY client/security-headers.conf /etc/nginx/security-headers.conf
EXPOSE 80
