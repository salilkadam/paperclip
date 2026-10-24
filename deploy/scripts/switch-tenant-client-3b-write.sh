
# Step 3b: write FULL payload via kv put @file (this Vault build lacks -stdin
# for patch), force-sync ESO, restart, verify. Hashes only.
set -euo pipefail

python3 deploy/scripts/switch-tenant-client-2b-payload.py

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
vault_ops_login
trap vault_ops_logout EXIT
kubectl -n vault cp /tmp/payload.json vault-0:/tmp/payload.json
rm -f /tmp/payload.json

echo "== kv put =="
vault_ops_sh '
vault kv put secret/t6-apps/mcp/config @/tmp/payload.json >/dev/null && echo "put ok"
vault kv get -format=json secret/t6-apps/mcp/config > /tmp/mcp-cfg2.json
rm -f /tmp/payload.json
'
kubectl -n vault cp vault-0:/tmp/mcp-cfg2.json /tmp/mcp-cfg2.json
chmod 600 /tmp/mcp-cfg2.json

echo "== verify vault read-back =="
python3 - <<'PY'
import json, hashlib
d = json.load(open("/tmp/mcp-cfg2.json"))["data"]["data"]
t = json.loads(d["gworkspace_tenants_json"])["base"]
h = lambda v: hashlib.sha256(str(v).encode()).hexdigest()[:8] if v else "-"
assert t["client_id"].startswith("382016492812-"), "NOT SWITCHED"
print("vault base client_id  :", t.get("client_id"))
print("vault base secret-sha8:", h(t.get("client_secret")), "(expect 8b6327ae)")
print("vault base state-sha8 :", h(t.get("state_signing_key")), "(expect 4b82fdc5)")
print("vault base redirect   :", t.get("redirect_uri"))
print("other props intact   :", "postgres_connection" in d, "langfuse_tenants_json" in d, "redis_tenants_json" in d, "redis" and len(d))
PY

echo "== force-sync ESO =="
kubectl -n mcp annotate externalsecret mcp-gworkspace-tenants force-sync="$(date +%s)" --overwrite
sleep 12

echo "== verify k8s secret =="
python3 - <<'PY'
import json, subprocess, base64, hashlib
out = subprocess.run(["kubectl","-n","mcp","get","secret","mcp-gworkspace-tenants","-o","json"],capture_output=True,text=True).stdout
v = json.loads(out)["data"]["tenants.json"]
t = json.loads(base64.b64decode(v))["base"]
h = lambda x: hashlib.sha256(str(x).encode()).hexdigest()[:8] if x else "-"
assert t["client_id"].startswith("382016492812-"), "SECRET NOT UPDATED"
print("secret base client_id  :", t.get("client_id"))
print("secret base secret-sha8:", h(t.get("client_secret")))
PY

echo "== restart gworkspace =="
kubectl -n mcp rollout restart deploy/mcp-gworkspace-server
kubectl -n mcp rollout status deploy/mcp-gworkspace-server --timeout=180s

POD=$(kubectl -n mcp get pods --no-headers | awk '/^mcp-gworkspace-server/{print $1}' | head -1)
echo "== mounted tenants.json in $POD =="
kubectl -n mcp exec "$POD" -c gworkspace -- python3 -c 'import json,hashlib;t=json.load(open("/etc/mcp/tenants.json"))["base"];h=lambda x:hashlib.sha256(str(x).encode()).hexdigest()[:8] if x else "-";print("client_id:",t.get("client_id"));print("secret-sha8:",h(t.get("client_secret")),"state-sha8:",h(t.get("state_signing_key")));assert t["client_id"].startswith("382016492812-"), "MOUNT NOT UPDATED"'
echo "SWITCH COMPLETE"
