#!/usr/bin/env bash
# Applies the scoped RBAC templates in this directory.
#
# The manifests use ${VAR} placeholders for environment-specific namespaces,
# so they must be rendered with envsubst before applying. Never apply the
# raw files.
#
# Usage:
#   PAPERCLIP_NS=bionicorg WEB_NS=web WEBSITE_NS=reliora-website \
#   DEMO_NS=bionicaisolutions ./deploy/rbac/apply.sh
#
# Add --dry-run to render and validate without applying.
set -euo pipefail

cd "$(dirname "$0")"

for v in PAPERCLIP_NS WEB_NS WEBSITE_NS DEMO_NS; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: set ${v} (see usage in this script header)." >&2
    exit 1
  fi
done

DRY=()
if [ "${1:-}" = "--dry-run" ]; then
  DRY=(--dry-run=client)
  echo "=== Dry-run mode: nothing will be applied ==="
fi

# Render ${VAR} placeholders. Prefer envsubst; fall back to python3 where
# gettext is not installed (e.g. minimal build sandboxes).
render() {
  if command -v envsubst >/dev/null 2>&1; then
    envsubst '${PAPERCLIP_NS} ${WEB_NS} ${WEBSITE_NS} ${DEMO_NS}'
  else
    python3 -c 'import os,sys
t=sys.stdin.read()
for var in ("PAPERCLIP_NS","WEB_NS","WEBSITE_NS","DEMO_NS"): t=t.replace("${"+var+"}", os.environ[var])
sys.stdout.write(t)'
  fi
}

for f in paperclip-agent-web.yaml sre-harness.yaml; do
  echo "=== Applying ${f} (namespaces: ${PAPERCLIP_NS} ${WEB_NS} ${WEBSITE_NS} ${DEMO_NS}) ==="
  render < "${f}" | kubectl apply "${DRY[@]}" -f -
done

echo
if [ ${#DRY[@]} -gt 0 ]; then
  echo "Dry-run complete. Templates render and validate cleanly."
else
  echo "RBAC applied. Run ./verify-authz.sh to confirm the permission matrix."
fi
