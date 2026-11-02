#!/usr/bin/env bash
# Verifies the scoped RBAC matrix with kubectl auth can-i, impersonating each
# ServiceAccount token. Read-only: it creates no resources.
#
# Usage:
#   PAPERCLIP_NS=bionicorg WEB_NS=web WEBSITE_NS=reliora-website \
#   DEMO_NS=bionicaisolutions ./deploy/rbac/verify-authz.sh
#
# Exit code is non-zero if any expectation fails.
set -uo pipefail

for v in PAPERCLIP_NS WEB_NS WEBSITE_NS DEMO_NS; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: set ${v} (see usage in this script header)." >&2
    exit 1
  fi
done

AGENT="system:serviceaccount:${PAPERCLIP_NS}:paperclip-agent-web-sa"
HARNESS="system:serviceaccount:${PAPERCLIP_NS}:sre-harness-sa"

FAILS=0

# can-i <expect yes|no> <verb> <resource[/subresource]> <namespace> <identity>
can-i() {
  local expect="$1" verb="$2" resource="$3" ns="$4" who="$5"
  local actual
  if actual=$(kubectl auth can-i "${verb}" "${resource}" -n "${ns}" --as "${who}" 2>/dev/null); then
    actual="yes"
  else
    actual="no"
  fi
  local mark="OK  "
  if [ "${actual}" != "${expect}" ]; then
    mark="FAIL"
    FAILS=$((FAILS + 1))
  fi
  printf '%s  expect=%-3s got=%-3s  %-8s %-28s ns=%-20s as=%s\n' \
    "${mark}" "${expect}" "${actual}" "${verb}" "${resource}" "${ns}" "${who##*:}"
}

echo "=== Website agent (paperclip-agent-web-sa) ==="
# May patch the two pinned marketing deployments.
can-i yes patch deployments/baisoln-web "${WEB_NS}" "${AGENT}"
can-i yes patch deployments/reliora-website "${WEBSITE_NS}" "${AGENT}"
# May observe its own namespace and the website namespaces.
can-i yes get pods "${PAPERCLIP_NS}" "${AGENT}"
can-i yes get pods/log "${PAPERCLIP_NS}" "${AGENT}"
can-i yes list services "${WEB_NS}" "${AGENT}"
# May NOT write outside its pinned targets.
can-i no patch deployments/contact-api "${WEB_NS}" "${AGENT}"
can-i no delete pods "${WEB_NS}" "${AGENT}"
can-i no get secrets "${WEB_NS}" "${AGENT}"
can-i no get secrets "${PAPERCLIP_NS}" "${AGENT}"
can-i no patch deployments/bionic-org "${PAPERCLIP_NS}" "${AGENT}"
can-i no delete deployments/baisoln-web "${WEB_NS}" "${AGENT}"
can-i no create pods/exec "${PAPERCLIP_NS}" "${AGENT}"

echo
echo "=== SRE harness (sre-harness-sa) ==="
# May operate fully in the four monitored namespaces.
can-i yes patch deployments/bionic-org "${PAPERCLIP_NS}" "${HARNESS}"
can-i yes delete pods "${PAPERCLIP_NS}" "${HARNESS}"
can-i yes create pods/exec "${PAPERCLIP_NS}" "${HARNESS}"
can-i yes get secrets "${PAPERCLIP_NS}" "${HARNESS}"
can-i yes create secrets "${WEB_NS}" "${HARNESS}"
can-i yes delete deployments/reliora-website "${WEBSITE_NS}" "${HARNESS}"
can-i yes patch deployments/baisoln-web "${WEB_NS}" "${HARNESS}"
can-i yes delete pods "${DEMO_NS}" "${HARNESS}"
# May NOT reach outside the monitored namespaces or go cluster-scoped.
can-i no get secrets default "${HARNESS}"
can-i no get nodes "" "${HARNESS}"
can-i no get clusterroles "" "${HARNESS}"
can-i no create namespace "" "${HARNESS}"

echo
if [ "${FAILS}" -eq 0 ]; then
  echo "All expectations matched the RBAC matrix."
else
  echo "${FAILS} expectation(s) FAILED. Do not rely on this RBAC until fixed."
fi
exit "${FAILS}"
