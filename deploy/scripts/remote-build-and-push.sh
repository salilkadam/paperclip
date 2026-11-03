#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# remote-build-and-push.sh — build the Bionic image on the Brev GPU box
# (paperclip-linux) instead of locally, then optionally deploy.
#
# Usage (from the repo root, in the devcontainer that has kubectl + vault):
#   ./deploy/scripts/remote-build-and-push.sh             build HEAD, push, deploy
#   ./deploy/scripts/remote-build-and-push.sh --no-deploy build and push only
#   ./deploy/scripts/remote-build-and-push.sh --clean     also remove the remote builder (and its cache)
#
# Why: a Docker build inside the devcontainer (itself a container) is very slow.
#
# Isolation on the GPU box (it also runs agent sandboxes; the build must not touch them or the GPUs):
#   - The build runs in its own BuildKit container (buildx "docker-container" driver), never on the host's
#     default builder, so it cannot see or reuse the host's images, containers or sandbox leases.
#   - GPUs are hidden from it (NVIDIA_VISIBLE_DEVICES=void; no --gpus), and CPU/memory are capped
#     (BUILD_CPUS, BUILD_MEMORY) with a low CPU weight, so running sandboxes keep priority.
#   - The source is the committed tree (git archive of HEAD), unpacked into a fresh temp dir that is deleted
#     on exit. Registry credentials live in a temp DOCKER_CONFIG that is deleted on exit; they are sent over
#     stdin, never on a command line.
#   - The image is pushed straight from BuildKit; nothing is loaded into the host's Docker image store.
#   - The builder container keeps a layer cache between runs (it makes rebuilds minutes instead of ~20 min).
#     --clean removes the builder and its cache; the next run starts cold.
#
# Needs: git, ssh, vault (VAULT_ADDR/VAULT_TOKEN, or the same lookup as the other deploy scripts), jq.
# Remote needs: docker with the buildx plugin, reachable as brev_ssh_user@brev_host.
# Secrets read from Vault:
#   secret/t6-apps/bionic-org/sandbox  brev_ssh_private_key, brev_known_hosts, brev_host, brev_ssh_user
#   secret/shared/dockerhub            username, pat
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/../.."  # repo root

DEPLOY=1
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=0 ;;
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

IMAGE="${IMAGE:-docker4zerocool/bionic}"
BUILDER="${BUILDER:-paperclip-builder}"
BUILD_CPUS="${BUILD_CPUS:-8}"
BUILD_MEMORY="${BUILD_MEMORY:-24g}"
DEPLOY_REPO_DIR="${DEPLOY_REPO_DIR:-/workspace/Deploy/k8s-infrastructure/deploy}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
for bin in git ssh vault jq; do command -v "$bin" >/dev/null || die "'$bin' is not installed"; done

# The image tag is the commit; deploy.sh deploys the same `git rev-parse --short HEAD`.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Note: uncommitted changes are NOT in the build. It uses the committed HEAD only."
fi
TAG="$(git rev-parse --short HEAD)"
FULL="${IMAGE}:${TAG}"

# ── Vault ────────────────────────────────────────────────────────────────────
say "Opening Vault"
PIDS=()
LOCAL_TMP="$(mktemp -d)"
cleanup_local() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  rm -rf "$LOCAL_TMP"
}
trap cleanup_local EXIT
export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
if ! curl -s -o /dev/null --max-time 2 "$VAULT_ADDR/v1/sys/health"; then
  command -v kubectl >/dev/null || die "Vault is not reachable at $VAULT_ADDR and kubectl is missing"
  kubectl -n vault port-forward svc/vault 8200:8200 >/dev/null 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 2 "$VAULT_ADDR/v1/sys/health" && break; sleep 1; done
fi
if [[ -z "${VAULT_TOKEN:-}" ]]; then
  if [[ -s "$DEPLOY_REPO_DIR/vault/.vault-admin-token" ]]; then
    VAULT_TOKEN="$(cat "$DEPLOY_REPO_DIR/vault/.vault-admin-token")"
  elif [[ -s "$DEPLOY_REPO_DIR/vault/vault-init.json" ]]; then
    VAULT_TOKEN="$(jq -r .root_token "$DEPLOY_REPO_DIR/vault/vault-init.json")"
  else
    read -rsp "    Vault token: " VAULT_TOKEN && echo
  fi
fi
export VAULT_TOKEN

umask 077
vault kv get -format=json secret/t6-apps/bionic-org/sandbox | jq -r '.data.data' > "$LOCAL_TMP/sandbox.json" ||
  die "cannot read secret/t6-apps/bionic-org/sandbox"
jq -r '.brev_ssh_private_key' "$LOCAL_TMP/sandbox.json" > "$LOCAL_TMP/id"
jq -r '.brev_known_hosts' "$LOCAL_TMP/sandbox.json" > "$LOCAL_TMP/known_hosts"
HOST="$(jq -r '.brev_host' "$LOCAL_TMP/sandbox.json")"
USER_="$(jq -r '.brev_ssh_user // "ubuntu"' "$LOCAL_TMP/sandbox.json")"
rm -f "$LOCAL_TMP/sandbox.json"
[[ -n "$HOST" && "$HOST" != null ]] || die "brev_host is not set in Vault"
DH_USER="$(vault kv get -field=username secret/shared/dockerhub)"
DH_PAT="$(vault kv get -field=pat secret/shared/dockerhub)"

SSH=(ssh -i "$LOCAL_TMP/id" -o IdentitiesOnly=yes -o UserKnownHostsFile="$LOCAL_TMP/known_hosts"
  -o StrictHostKeyChecking=yes -o BatchMode=yes -o ServerAliveInterval=30 "$USER_@$HOST")
"${SSH[@]}" true || die "cannot SSH to $USER_@$HOST (is paperclip-linux running? see deploy/scripts/brev-heartbeat.sh)"

# ── Remote build ─────────────────────────────────────────────────────────────
# Runs on the GPU box. It reads two credential lines, then the source tarball, from stdin.
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail
read -r DH_USER
read -r DH_PAT
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  if [ "$CLEAN" = 1 ]; then docker buildx rm "$BUILDER" >/dev/null 2>&1 && echo "    removed builder $BUILDER and its cache" || true; fi
}
trap cleanup EXIT
command -v docker >/dev/null || { echo "docker is not installed on the build host" >&2; exit 1; }
# Private Docker config for this run only (registry login); the builder list and CLI plugins stay shared.
export DOCKER_CONFIG="$WORK/docker"
mkdir -p "$DOCKER_CONFIG" "$HOME/.docker/buildx"
ln -s "$HOME/.docker/buildx" "$DOCKER_CONFIG/buildx"
[ -d "$HOME/.docker/cli-plugins" ] && ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
docker buildx version >/dev/null 2>&1 || { echo "the docker buildx plugin is not installed on the build host" >&2; exit 1; }
printf '%s' "$DH_PAT" | docker login -u "$DH_USER" --password-stdin docker.io >/dev/null
unset DH_PAT

mkdir -p "$WORK/src"
tar -x -C "$WORK/src"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "    creating isolated builder $BUILDER"
  base=(--name "$BUILDER" --driver docker-container --driver-opt env.NVIDIA_VISIBLE_DEVICES=void)
  docker buildx create "${base[@]}" \
      --driver-opt "memory=$BUILD_MEMORY" \
      --driver-opt "cpu-period=100000" --driver-opt "cpu-quota=$((BUILD_CPUS * 100000))" \
      --driver-opt "cpu-shares=256" >/dev/null 2>&1 \
    || { echo "    (this buildx cannot cap CPU/memory; creating the builder without caps)"; docker buildx create "${base[@]}" >/dev/null; }
fi
docker buildx inspect --bootstrap "$BUILDER" >/dev/null
# Prove the build container cannot reach a GPU before building.
C="buildx_buildkit_${BUILDER}0"
GPUS="$(docker exec "$C" sh -c 'ls /dev/nvidia[0-9]* 2>/dev/null | wc -l' 2>/dev/null || echo 0)"
REQ="$(docker inspect -f '{{len .HostConfig.DeviceRequests}}' "$C" 2>/dev/null || echo 0)"
if [ "$GPUS" != 0 ] || { [ -n "$REQ" ] && [ "$REQ" != 0 ]; }; then
  echo "the build container can see GPUs ($GPUS devices, $REQ device requests); refusing to build" >&2
  exit 1
fi
echo "    build container sees 0 GPUs"

docker buildx build --builder "$BUILDER" --target production -t "$IMAGE_REF" --push "$WORK/src"
echo "    pushed $IMAGE_REF"
REMOTE

say "Building $FULL on $HOST (isolated BuildKit container, GPUs hidden, ${BUILD_CPUS} CPUs / ${BUILD_MEMORY})"
REMOTE_B64="$(printf '%s' "$REMOTE_SCRIPT" | base64 | tr -d '\n')"
# The remote script travels as an argument; stdin carries the credentials (never argv) and then the source.
{
  printf '%s\n%s\n' "$DH_USER" "$DH_PAT"
  git archive --format=tar HEAD
} | "${SSH[@]}" "IMAGE_REF='$FULL' BUILDER='$BUILDER' BUILD_CPUS='$BUILD_CPUS' BUILD_MEMORY='$BUILD_MEMORY' CLEAN='$CLEAN' bash -c \"\$(printf %s '$REMOTE_B64' | base64 -d)\"" \
  || die "remote build failed (output above)"

# ── Deploy ───────────────────────────────────────────────────────────────────
if [[ "$DEPLOY" == 1 ]]; then
  say "Deploying $TAG"
  # deploy.sh rewrites the image pull secret from these, so pass the real ones (environment, not argv).
  DOCKER_USERNAME="$DH_USER" DOCKER_PASSWORD="$DH_PAT" ./deploy/scripts/deploy.sh
else
  echo
  echo "Image ready: $FULL. Deploy with: ./deploy/scripts/deploy.sh (it uses the same commit tag)."
fi
