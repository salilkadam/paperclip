#!/usr/bin/env bash
# sync-brev-sandbox-key.sh — copy the Brev sandbox SSH key from Vault into the
# Paperclip secret that the "Brev paperclip-linux (ssh-docker)" environment uses,
# then probe the environment from every company.
#
# Source of truth: Vault secret/t6-apps/bionic-org/sandbox
#   brev_ssh_private_key  dedicated ed25519 key "paperclip-sandbox@bionic-org"
#   brev_ssh_public_key   the matching authorized_keys line on paperclip-linux
#   brev_known_hosts      ssh-keyscan of brev_host
#   brev_host / brev_ssh_user / brev_instance
#
# Why not an ESO env var: the app pod environment is inherited by local agent
# processes, and the sandbox design forbids agents from holding the host key.
# So the key goes Vault -> (pipe) -> POST /api/secrets/:id/rotate. It is never
# written to disk, a pod env var, or the log. Only sha256 prefixes are printed.
#
# The Paperclip secret keeps its id, and the environment binding uses version
# "latest", so a rotation needs no environment change.
#
# Usage:
#   deploy/scripts/sync-brev-sandbox-key.sh [secretId] [environmentId]
# Rotate the key:
#   1. Generate a new key, add its public key to ~/.ssh/authorized_keys on the host.
#   2. vault kv patch secret/t6-apps/bionic-org/sandbox brev_ssh_private_key=@id ...
#   3. Run this script. Remove the old authorized_keys line after the probe passes.
set -euo pipefail
umask 077
SECRET_ID=${1:-a2c362be-7cfe-4a41-9f20-e4245c3aebe2}
ENV_ID=${2:-4123fb2c-ee70-4cc7-97bb-b0354ee66de3}
NS=bionicorg
VAULT_PATH=secret/t6-apps/bionic-org/sandbox

POD=$(kubectl -n "$NS" get pods --no-headers | awk '/^bionic-org-/ && $3=="Running" {print $1; exit}')
[ -n "$POD" ] || { echo "no running bionic-org pod" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kubectl -n vault exec vault-0 -- rm -f /tmp/.va >/dev/null 2>&1 || true' EXIT

cat > "$TMP/rotate.mjs" <<'JS'
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
const pgDir = readdirSync("/app/node_modules/.pnpm").find((d) => d.startsWith("postgres@"));
const { default: postgres } = await import(`/app/node_modules/.pnpm/${pgDir}/node_modules/postgres/src/index.js`);
const sha8 = (v) => createHash("sha256").update(v).digest("hex").slice(0, 8);
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let value = Buffer.concat(chunks).toString("utf8");
if (!value.includes("PRIVATE KEY")) { console.error("stdin is not a private key"); process.exit(1); }
if (!value.endsWith("\n")) value += "\n";
const { SECRET_ID, ENV_ID, BOARD_USER_ID } = process.env;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const token = `pcp_board_${randomBytes(24).toString("hex")}`;
const [key] = await sql`insert into board_api_keys (user_id, name, key_hash, expires_at)
  values (${BOARD_USER_ID}, 'sync-brev-sandbox-key', ${createHash("sha256").update(token).digest("hex")}, now() + interval '10 minutes') returning id`;
const api = async (method, path, body) => {
  const res = await fetch(`http://localhost:3100/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
try {
  console.log(`vault key sha8: ${sha8(value)}`);
  const rotated = await api("POST", `/secrets/${SECRET_ID}/rotate`, { value });
  console.log(`rotate http=${rotated.status} latestVersion=${rotated.json?.latestVersion ?? JSON.stringify(rotated.json).slice(0, 160)}`);
  if (rotated.status >= 300) process.exitCode = 1;
  const companies = await sql`select id, name from companies where status = 'active' order by created_at`;
  for (const company of companies) {
    const probe = await api("POST", `/environments/${ENV_ID}/probe?companyId=${company.id}`, {});
    const ok = probe.json?.ok === true;
    if (!ok) process.exitCode = 1;
    console.log(`probe as ${company.name}: ${ok ? "OK" : "FAIL"} ${probe.json?.summary ?? probe.status} ${probe.json?.details?.error ?? ""}`);
  }
} finally {
  await sql`update board_api_keys set revoked_at = now() where id = ${key.id}`;
  await sql.end();
}
JS
kubectl -n "$NS" cp "$TMP/rotate.mjs" "$POD:/tmp/sync-brev-sandbox-key.mjs" >/dev/null

kubectl -n "$NS" get secret bionic-org-secrets -o jsonpath='{.data.vault_token}' | base64 -d > "$TMP/va"
kubectl -n vault cp "$TMP/va" vault-0:/tmp/.va >/dev/null
rm -f "$TMP/va"

# Vault -> pipe -> Paperclip. The key exists only in this pipe.
set +e
kubectl -n vault exec vault-0 -- sh -c "VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=\$(cat /tmp/.va) vault kv get -field=brev_ssh_private_key $VAULT_PATH; rm -f /tmp/.va" 2>/dev/null \
  | kubectl -n "$NS" exec -i "$POD" -- env SECRET_ID="$SECRET_ID" ENV_ID="$ENV_ID" BOARD_USER_ID="${BOARD_USER_ID:-mO44P6K9aWIwqI1BGM9v3XOvkpDwWTXy}" \
      node /tmp/sync-brev-sandbox-key.mjs
status=$?
set -e
kubectl -n "$NS" exec "$POD" -- rm -f /tmp/sync-brev-sandbox-key.mjs
exit $status
