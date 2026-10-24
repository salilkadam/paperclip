#!/usr/bin/env bash
# Break-glass: regenerate the Vault root token when no usable token exists.
# (2026-10-07: the ops token stored in bionic-org/config was scoped down to
# the `bionic-org-app` policy; root is no longer stored anywhere.)
#
# Requirements: kubectl access to ns `vault`; the StatefulSet `vault` with pod
# vault-0; secret `vault-unseal-keys` holding 2 of 3 shamir shares (fields
# key1/key2, matching the t=2 threshold).
#
# Notes learned the hard way:
# - The vault CLI is non-interactive here: pipe shares with `-` (stdin) or
#   pass as an argument; a tty prompt hangs.
# - `generate-root -generate-otp` prints the bare OTP with no label.
# - An attempt started before a process restart survives in memory; deleting
#   the vault-0 pod clears it (the vault-auto-unseal cronjob re-unseals it
#   within a minute using the same k8s secret).
# - The vault container runs as a non-root user: the token goes to
#   /tmp/.vault-root-token (mode 600), not /root. The inner script stops on
#   the first error so a failed write can never be followed by deleting the
#   encoded token (2026-10-24: that lost one generated root token).
# - Revoke the regenerated root token (`vault token revoke -self`) once an
#   orphan admin token exists; the durable mitigation against share leakage
#   is rotating unseal keys (`vault operator rotate`).
set -euo pipefail
NS=${NS:-vault}
POD=${POD:-vault-0}

kubectl -n "$NS" get secret vault-unseal-keys -o go-template='{{index .data "key1"}}' | base64 -d > /tmp/.us1
kubectl -n "$NS" get secret vault-unseal-keys -o go-template='{{index .data "key2"}}' | base64 -d > /tmp/.us2
chmod 600 /tmp/.us1 /tmp/.us2
trap 'rm -f /tmp/.us1 /tmp/.us2' EXIT
kubectl -n "$NS" cp /tmp/.us1 "$POD:/tmp/.us1"
kubectl -n "$NS" cp /tmp/.us2 "$POD:/tmp/.us2"

kubectl -n "$NS" exec "$POD" -- sh -c '
set -e
umask 077
export VAULT_ADDR=http://127.0.0.1:8200
chmod 600 /tmp/.us1 /tmp/.us2
OTP=$(vault operator generate-root -generate-otp | tr -d "[:space:]")
if [ ${#OTP} -lt 20 ]; then echo "OTP generation failed"; exit 2; fi
INIT=$(vault operator generate-root -init -otp="$OTP" 2>&1)
NONCE=$(printf "%s" "$INIT" | awk "/[Nn]once/{print \$2; exit}")
if [ -z "$NONCE" ]; then
  echo "init failed (stale attempt?): $(printf "%s" "$INIT" | head -1)"
  echo "clear it: kubectl -n vault delete pod vault-0 (auto-unseal recovers), then rerun"
  exit 2
fi
printf "%s" "$(cat /tmp/.us1)" | vault operator generate-root -otp="$OTP" -nonce="$NONCE" - >/dev/null 2>&1
printf "%s" "$(cat /tmp/.us2)" | vault operator generate-root -otp="$OTP" -nonce="$NONCE" - >/tmp/.gr
ENC=$(awk "/Encoded Token/{print \$3; exit}" /tmp/.gr)
[ -n "$ENC" ] || { echo "no encoded token; shares did not reach threshold"; tail -2 /tmp/.gr; exit 3; }
vault operator generate-root -decode="$ENC" -otp="$OTP" > /tmp/.vault-root-token
chmod 600 /tmp/.vault-root-token
rm -f /tmp/.us1 /tmp/.us2 /tmp/.gr
echo "root token written to ${POD}:/tmp/.vault-root-token (sha8: $(sha256sum /tmp/.vault-root-token | cut -c1-8))"
echo "Copy it out (kubectl cp), store it in the operator password manager, then remove it from the pod."
'
