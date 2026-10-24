#!/usr/bin/env bash
# Break-glass: regenerate a Vault root token when no usable admin token exists.
#
# Requirements: kubectl access to ns `vault`; pod vault-0 (StatefulSet `vault`,
# runs as non-root uid 100); secret `vault-unseal-keys` holding 2 of 3 shamir
# shares (fields key1/key2, matching the t=2 threshold).
#
# Output: the root token lands in a local 0600 file (ROOT_TOKEN_FILE, default
# ~/.vault-root-token) and is removed from the pod in the same run. Use it only
# to mint an ORPHAN admin token (`vault token create -orphan -policy=admin ...`),
# then revoke it: `VAULT_TOKEN=$(cat ~/.vault-root-token) vault token revoke -self`.
#
# Safety properties (2026-10-24 incident: one generated root token was lost):
# - The OTP and the encoded token are kept (mode 600) until the token has been
#   decoded in memory and written; if decoding fails they are left in place and
#   the recovery steps are printed.
# - The script refuses to start while state from a previous run is still in the
#   pod (/tmp/.otp, /tmp/.gr, /tmp/.vault-root-token): a rerun must never
#   overwrite the only copy of a generated root token. Recover or remove it first.
# - The local token file is written via a temp file and only renamed into place
#   after a complete copy-out; a failed copy-out says where the token still is.
# - Key shares are removed on every exit path, in the pod and locally.
# - A stale in-progress attempt is reported with the non-disruptive fix
#   `vault operator generate-root -cancel` (unauthenticated; no pod restart).
# - Vault's own error messages stay visible.
set -euo pipefail
umask 077
NS=${NS:-vault}
POD=${POD:-vault-0}
ROOT_TOKEN_FILE=${ROOT_TOKEN_FILE:-$HOME/.vault-root-token}

LOCAL_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$LOCAL_DIR"
  timeout 30 kubectl -n "$NS" exec "$POD" -- rm -f /tmp/.us1 /tmp/.us2 >/dev/null 2>&1 \
    || echo "WARNING: could not remove key shares from $POD:/tmp/.us1 /tmp/.us2 -- remove them by hand" >&2
}
trap cleanup EXIT

[[ ! -e "$ROOT_TOKEN_FILE" ]] || { echo "$ROOT_TOKEN_FILE already exists; move it away first" >&2; exit 1; }
leftover=$(timeout 30 kubectl -n "$NS" exec "$POD" -- sh -c 'ls /tmp/.otp /tmp/.gr /tmp/.vault-root-token 2>/dev/null' || true)
if [[ -n "$leftover" ]]; then
  echo "refusing to start: a previous run left state in $POD: $(echo $leftover)" >&2
  echo "  /tmp/.vault-root-token: a generated root token -- copy it out, then remove the file" >&2
  echo "  /tmp/.otp + /tmp/.gr: decode with vault operator generate-root -decode=<Encoded Token in .gr> -otp=<.otp>, then remove both" >&2
  exit 6
fi

timeout 30 kubectl -n "$NS" get secret vault-unseal-keys -o go-template='{{index .data "key1"}}' | base64 -d > "$LOCAL_DIR/us1"
timeout 30 kubectl -n "$NS" get secret vault-unseal-keys -o go-template='{{index .data "key2"}}' | base64 -d > "$LOCAL_DIR/us2"
timeout 60 kubectl -n "$NS" cp "$LOCAL_DIR/us1" "$POD:/tmp/.us1"
timeout 60 kubectl -n "$NS" cp "$LOCAL_DIR/us2" "$POD:/tmp/.us2"

timeout 180 kubectl -n "$NS" exec "$POD" -- sh -c '
set -e
umask 077
export VAULT_ADDR=http://127.0.0.1:8200
trap "rm -f /tmp/.us1 /tmp/.us2" EXIT
OTP=$(vault operator generate-root -generate-otp | tr -d "[:space:]")
if [ ${#OTP} -lt 20 ]; then echo "OTP generation failed" >&2; exit 2; fi
INIT=$(vault operator generate-root -init -otp="$OTP" 2>&1) || true
NONCE=$(printf "%s" "$INIT" | awk "/[Nn]once/{print \$2; exit}")
if [ -z "$NONCE" ]; then
  echo "generate-root init failed:" >&2
  printf "%s\n" "$INIT" | grep -v "^ *$" >&2
  echo "If an earlier attempt is still in progress, cancel it (no restart needed):" >&2
  echo "  kubectl -n vault exec vault-0 -- sh -c \"VAULT_ADDR=http://127.0.0.1:8200 vault operator generate-root -cancel\"" >&2
  exit 2
fi
# Persist the OTP before any share is submitted: from here on, the encoded
# token plus this OTP are the only way to obtain the generated root token.
printf "%s" "$OTP" > /tmp/.otp
vault operator generate-root -otp="$OTP" -nonce="$NONCE" - < /tmp/.us1 >/dev/null
vault operator generate-root -otp="$OTP" -nonce="$NONCE" - < /tmp/.us2 > /tmp/.gr
ENC=$(awk "/Encoded Token/{print \$3; exit}" /tmp/.gr)
[ -n "$ENC" ] || { echo "no encoded token; shares did not reach threshold:" >&2; tail -2 /tmp/.gr >&2; rm -f /tmp/.otp /tmp/.gr; exit 3; }
if ! TOK=$(vault operator generate-root -decode="$ENC" -otp="$OTP"); then
  echo "decode failed; the root token is NOT lost. Encoded token in /tmp/.gr, OTP in /tmp/.otp (both 600)." >&2
  echo "Retry inside vault-0: vault operator generate-root -decode=<Encoded Token from /tmp/.gr> -otp=<contents of /tmp/.otp>" >&2
  exit 4
fi
printf "%s" "$TOK" > /tmp/.vault-root-token
rm -f /tmp/.otp /tmp/.gr
'

# Copy the token out and remove the pod copy in the same run. The local file
# appears only after a complete, non-empty copy; otherwise the pod copy stays.
if ! timeout 60 kubectl -n "$NS" exec "$POD" -- cat /tmp/.vault-root-token > "$LOCAL_DIR/root.tok" || [[ ! -s "$LOCAL_DIR/root.tok" ]]; then
  echo "copy-out failed; the root token remains at $POD:/tmp/.vault-root-token (copy it out by hand; a rerun refuses until it is gone)" >&2
  exit 5
fi
mv "$LOCAL_DIR/root.tok" "$ROOT_TOKEN_FILE"
timeout 30 kubectl -n "$NS" exec "$POD" -- rm -f /tmp/.vault-root-token
echo "root token written to $ROOT_TOKEN_FILE (0600, sha8 $(sha256sum "$ROOT_TOKEN_FILE" | cut -c1-8)); pod copy removed."
echo "Next: mint an orphan admin token with it, then revoke it (vault token revoke -self) and delete the file."
