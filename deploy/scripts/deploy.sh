#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Deploy Bionic Org to Kubernetes via Helm
#
# Prerequisites:
#   1. Build & push image:   ./scripts/build-and-push.sh
#   2. Create PostgreSQL DB in CNPG cluster
#   3. Create Keycloak client
#   4. Populate Vault at t6-apps/bionic-org/config
#   5. Create dockerhub-pull-secret in target namespace
#
# Usage:
#   ./deploy/scripts/deploy.sh [RELEASE_NAME]
#
# Defaults release name to "bionic-org".
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/../.."  # repo root

RELEASE="${1:-bionic-org}"
NAMESPACE="bionicorg"
CHART="./deploy/helm/bionic-org"
TAG="$(git rev-parse --short HEAD)"

echo "=== Deploying Bionic Org ==="
echo "  Release   : ${RELEASE}"
echo "  Namespace   : bionicorg"
echo "  Image Tag : ${TAG}"
echo ""

# --- Step 1: Create namespace ---
echo "[1/6] Creating namespace ${NAMESPACE}..."
kubectl create namespace bionicorg --dry-run=client -o yaml | kubectl apply -f -
echo "  ✓ Namespace ready"

# --- Step 2: Create dockerhub pull secret ---
echo "[2/6] Creating dockerhub pull secret..."
kubectl -n bionicorg create secret docker-registry dockerhub-pull-secret \
  --docker-server=docker.io \
  --docker-username="${DOCKER_USERNAME:-}" \
  --docker-password="${DOCKER_PASSWORD:-}" \
  --dry-run=client -o yaml | kubectl -n "${NAMESPACE}" apply -f - 2>/dev/null || true
echo "  ✓ Pull secret ready (or already exists)"

# --- Step 3: Create service account ---
echo "[3/6] Applying ServiceAccount..."
kubectl -n bionicorg create serviceaccount bionic-org-sa --dry-run=client -o yaml | kubectl -n bionicorg apply -f -
echo "  ✓ ServiceAccount ready"

# --- Step 4: Deploy via Helm ---
echo "[4/6] Installing/Upgrading Helm release..."
# Override the image tag in the Helm release
helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" \
  --set "image.tag=${TAG}" \
  --set "domain=org.baisoln.com" \
  --create-namespace \
  --wait \
  --timeout 5m \
  --atomic
echo "  ✓ Helm release deployed"

# --- Step 5: Verify ---
echo "[5/6] Verifying deployment..."
kubectl -n bionicorg rollout status deployment/bionic-org --timeout=300s
echo "  ✓ Deployment healthy"

echo ""
echo "=== Deployment Summary ==="
echo "  Release     : ${RELEASE}"
echo "  Namespace   : bionicorg"
echo "  Domain      : org.baisoln.com"
echo "  Image       : docker4zerocool/bionic:${TAG}"
echo "  Service     : http://bionic-org.${NAMESPACE}.svc.cluster.local:3100"
echo "  Ingress     : https://org.baisoln.com"
echo ""
echo "Next steps:"
echo "  1. Ensure DNS record for org.baisoln.com points to your cluster LB (192.168.0.210)"
echo "  2. Verify TLS cert: kubectl -n bionicorg get certificate"
echo "  3. Check Vault at t6-apps/bionic-org/config has all required keys"
echo "  4. Create Keycloak client for org.baisoln.com"
echo "  5. Access: https://org.baisoln.com"
