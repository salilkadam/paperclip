
# Step 3 of tenant-client switch: write patched tenants JSON to Vault (kv
# patch keeps all other properties), force-sync the ESO, restart gworkspace,
# and verify. Prints hashes only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/vault-ops.sh
source "$HERE/lib/vault-ops.sh"
vault_ops_login
trap vault_ops_logout EXIT

# a) push the payload into vault-0 (the token travels on stdin per call)
timeout 60 kubectl -n vault cp /tmp/nt.txt vault-0:/tmp/nt.txt

echo "== patch Vault =="
vault_ops_sh '
vault kv patch secret/t6-apps/mcp/config gworkspace_tenants_json=@/tmp/nt.txt >/dev/null
echo "patched ok"
vault kv get -format=json secret/t6-apps/mcp/config > /tmp/mcp-cfg2.json
rm -f /tmp/nt.txt /tmp/mcp-cfg2.json.check 2>/dev/null || true
'
timeout 60 kubectl -n vault cp vault-0:/tmp/mcp-cfg2.json /tmp/mcp-cfg2.json
chmod 600 /tmp/mcp-cfg2.json

echo "== verify vault read-back =="
python3 - <<'PY'
import json, hashlib
d = json.load(open("/tmp/mcp-cfg2.json"))["data"]["data"]
t = json.loads(d["gworkspace_tenants_json"])["base"]
h = lambda v: hashlib.sha256(str(v).encode()).hexdigest()[:8] if v else "-"
print("vault base client_id:", t.get("client_id"))
print("vault base secret-sha8:", h(t.get("client_secret")), "(expect 8b6327ae)")
print("vault base state-sha8 :", h(t.get("state_signing_key")), "(expect 4b82fdc5)")
print("vault base redirect   :", t.get("redirect_uri"))
print("other props intact   :", "postgres_connection" in d, "langfuse_tenants_json" in d, "redis_tenants_json" in d)
PY

echo "== force-sync ESO =="
timeout 60 kubectl -n mcp annotate externalsecret mcp-gworkspace-tenants force-sync="$(date +%s)" --overwrite
sleep 12
timeout 60 kubectl -n mcp get externalsecret mcp-gworkspace-tenants -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'

echo "== verify k8s secret =="
python3 - <<'PY'
import json, subprocess, base64, hashlib
out = subprocess.run(["kubectl","-n","mcp","get","secret","mcp-gworkspace-tenants","-o","json"],capture_output=True,text=True,timeout=60).stdout
v = json.loads(out)["data"]["tenants.json"]
t = json.loads(base64.b64decode(v))["base"]
h = lambda x: hashlib.sha256(str(x).encode()).hexdigest()[:8] if x else "-"
print("secret base client_id  :", t.get("client_id"))
print("secret base secret-sha8:", h(t.get("client_secret")))
PY

echo "== restart gworkspace =="
timeout 60 kubectl -n mcp rollout restart deploy/mcp-gworkspace-server
timeout 60 kubectl -n mcp rollout status deploy/mcp-gworkspace-server --timeout=180s

POD=$(timeout 60 kubectl -n mcp get pods --no-headers | awk '/^mcp-gworkspace-server/{print $1}' | head -1)
echo "== mounted tenants.json in $POD =="
timeout 60 kubectl -n mcp exec "$POD" -c gworkspace -- python3 -c 'import json,hashlib;t=json.load(open("/etc/mcp/tenants.json"))["base"];h=lambda x:hashlib.sha256(str(x).encode()).hexdigest()[:8] if x else "-";print("client_id:",t.get("client_id"));print("secret-sha8:",h(t.get("client_secret")),"state-sha8:",h(t.get("state_signing_key")))'
