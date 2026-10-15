#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-and-push.sh — Build Bionic Docker image and push to registry
#
# Usage:
#   ./deploy/scripts/build-and-push.sh [TAG]
#   FULL_CLEANUP=1 ./deploy/scripts/build-and-push.sh [TAG]
#
# Defaults to git short SHA if no TAG is provided.
# Requires: docker, git
#
# Runs anywhere docker works (e.g. a sandboxed build host reached over ssh);
# the Kubernetes cluster pulls the pushed image from the registry, so the
# build host keeps nothing persistent (see cleanup below).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root (script lives in deploy/scripts/)

TAG="${1:-$(git rev-parse --short HEAD)}"
IMAGE="docker4zerocool/bionic"
FULL="${IMAGE}:${TAG}"

echo "=== Building Bionic image ==="
echo "  Image : ${FULL}"
echo "  Tag   : ${TAG}"
echo ""

docker build -t "${FULL}" . --target production

echo ""
echo "=== Pushing image ==="
docker push "${FULL}"

# ─────────────────────────────────────────────────────────────────────────────
# Sandbox cleanup. The cluster pulls from the registry, so the locally built
# image is pure build residue once pushed -- delete it to keep the host clean.
# BuildKit's layer cache is deliberately left in place (it is what makes the
# next build minutes instead of ~20 minutes). FULL_CLEANUP=1 additionally
# sweeps dangling images and trims build cache down to a bounded footprint.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up build sandbox ==="
if docker image inspect "${FULL}" >/dev/null 2>&1; then
    docker rmi "${FULL}" >/dev/null && echo "  Removed local ${FULL} (still in registry)"
fi
if [ "${FULL_CLEANUP:-0}" = "1" ]; then
    docker image prune -f >/dev/null 2>&1 && echo "  Pruned dangling images"
    docker builder prune -f --keep-storage 20GB >/dev/null 2>&1 && echo "  Trimmed build cache (kept 20GB warm)"
fi

echo ""
echo "=== Done ==="
echo "  Image ready in registry: ${FULL}"
echo "  Deploy with: helm upgrade (image.tag=${TAG}) or ./deploy/scripts/deploy.sh ${TAG}"
