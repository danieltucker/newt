#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the server & client images for linux/amd64 (TrueNAS) and push to GHCR.
#
# FALLBACK ONLY. The normal path is .github/workflows/publish.yml, which builds
# on GitHub's native amd64 runners and needs no local Docker and no PAT. Use
# this script only to publish from a machine that has Docker — the primary dev
# box (Windows/arm64) has none, and an arm64 host cross-building amd64 here goes
# through QEMU and is slow.
#
# One-time prerequisites:
#   1. Create a GitHub Personal Access Token (classic) with the 'write:packages' scope.
#   2. Log in to GHCR (token piped in, never echoed to history):
#        echo <YOUR_PAT> | docker login ghcr.io -u <github-username> --password-stdin
#
# Usage:
#   ./scripts/deploy/build-and-push.sh [tag]     # tag defaults to "latest"
#   GHCR_OWNER=myorg ./scripts/deploy/build-and-push.sh v1.2.0
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GHCR_OWNER="${GHCR_OWNER:-danieltucker}"
TAG="${1:-latest}"
REGISTRY="ghcr.io"
PLATFORM="linux/amd64"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Ensure a buildx builder exists and is selected.
if ! docker buildx inspect newtab-builder >/dev/null 2>&1; then
  docker buildx create --name newtab-builder >/dev/null
fi
docker buildx use newtab-builder

# Both builds take the repo ROOT as context: this is an npm-workspaces monorepo
# and the only lockfile lives there. See server/Dockerfile.
echo "==> server  ->  $REGISTRY/$GHCR_OWNER/newtab-server:$TAG  ($PLATFORM)"
docker buildx build --platform "$PLATFORM" \
  -f "$ROOT/server/Dockerfile" \
  -t "$REGISTRY/$GHCR_OWNER/newtab-server:$TAG" \
  --push "$ROOT"

echo "==> client  ->  $REGISTRY/$GHCR_OWNER/newtab-client:$TAG  ($PLATFORM)"
docker buildx build --platform "$PLATFORM" \
  -f "$ROOT/client/Dockerfile" \
  -t "$REGISTRY/$GHCR_OWNER/newtab-client:$TAG" \
  --push "$ROOT"

echo
echo "==> Done. Pushed:"
echo "    $REGISTRY/$GHCR_OWNER/newtab-server:$TAG"
echo "    $REGISTRY/$GHCR_OWNER/newtab-client:$TAG"
echo
echo "Note: new GHCR packages are private by default. To let TrueNAS pull without a"
echo "login, make them public (GitHub > your profile > Packages > each package >"
echo "Package settings > Change visibility), or 'docker login ghcr.io' on the NAS."
