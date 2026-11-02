#!/bin/bash
# run-local.sh SITE_REPO_DIR — run the deployer's real steps, in the pinned
# images, against planted failures. Needs docker. Uses docker volumes, not bind
# mounts. Kubernetes is faked by test/fake-kubectl; NetworkPolicies, RBAC and
# CephFS are not exercised here (see the cutover verification in the plan).
set -uo pipefail
SRC="${1:?site repo checkout (with deploy/ and public/)}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
eval "$(sed -n 's/^\(  *\)image: \(.*\)@\(sha256:[0-9a-f]*\)$/\2@\3/p' "$HERE/40-cronjob.yaml" | sort -u | awk -F'[/:@]' '{n=$1=="alpine"?$2:$1; gsub(/-/,"_",n); print toupper(n)"="$0}')"
IMG_K8S="$K8S"; IMG_GIT="$GIT"; IMG_NODE="$NODE"; IMG_NGINX="$NGINXINC"
P=sdtest; NET=$P-net; pass=0; fail=0

# Gate: each step here must mount exactly what 40-cronjob.yaml mounts. A test
# whose mounts drift from the manifest proves nothing about the CronJob.
python3 -I - "$HERE/40-cronjob.yaml" "$0" <<'PY' || { echo "harness mounts differ from 40-cronjob.yaml"; exit 1; }
import re, sys
y = open(sys.argv[1]).read().split('\n          volumes:')[0]; t = open(sys.argv[2]).read()   # containers only
names = {'trusted': 'trusted', 'checkin': 'checkin', 'checkout': 'checkout', 'releases': 'releases',
         'stagetmp': 'stagetmp', 'stageout': 'stageout', 'git-key': 'gitkey'}
bad = 0
for blk in re.split(r'\n            - name: |\n          containers:\n            - name: ', y)[1:]:
    step = blk.split('\n', 1)[0].strip()
    want = {m for m in re.findall(r'name: ([a-z-]+), mountPath', blk) if m in names}
    line = [l for l in t.splitlines() if re.match(r'\s*step %s ' % step, l)]
    have = {k for k, v in names.items() if line and '$(v %s)' % v in line[0]}
    if not line or want != have:
        print('mount mismatch in step %s: manifest %s, harness %s' % (step, sorted(want), sorted(have))); bad = 1
sys.exit(bad)
PY
VOLS="scripts releases trusted checkin checkout stagetmp stageout fake repo gitkey"
v() { echo "$P-$1"; }
cleanup() { docker rm -f $P-live >/dev/null 2>&1; for x in $VOLS; do docker volume rm -f "$(v $x)" >/dev/null 2>&1; done; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT
cleanup; docker network create $NET >/dev/null
for x in $VOLS; do docker volume create "$(v $x)" >/dev/null; done

# a helper container to load files into volumes
load() { # load VOLUME SRC_PATH
  docker create --name $P-load -v "$(v "$1")":/v alpine:3.20 true >/dev/null
  docker cp "$2/." $P-load:/v/ >/dev/null; docker rm $P-load >/dev/null; }
root() { docker run --rm -v "$(v releases)":/srv/site -v "$(v fake)":/fake -v "$(v trusted)":/trusted \
  -v "$(v repo)":/repo -v "$(v gitkey)":/git-key -v "$(v checkin)":/checkin -v "$(v checkout)":/checkout \
  -v "$(v stagetmp)":/stagetmp -v "$(v stageout)":/stageout --entrypoint sh "$IMG_K8S" -c "git config --global --add safe.directory '*'; $1"; }

mkdir -p /tmp/$P-scripts; cp "$HERE"/deployer.sh "$HERE"/smoke.sh "$HERE"/stage-top.conf "$HERE"/known_hosts /tmp/$P-scripts/
cp "$HERE"/test/fake-kubectl /tmp/$P-scripts/kubectl; chmod +x /tmp/$P-scripts/*
load scripts /tmp/$P-scripts

# the test repository: commits on top of the site, each a branch tip we move main to
W=/tmp/$P-work; rm -rf $W; git clone -q "$SRC" $W; cd $W; git checkout -q -B main
git -c user.name=t -c user.email=t@t commit -q --allow-empty -m A; A=$(git rev-parse HEAD)
mk() { git checkout -q -B "$1" "$A"; eval "$2"; git add -A; git -c user.name=t -c user.email=t@t commit -q -m "$1"; git rev-parse HEAD; }
B_500=$(mk bad500 "sed -i 's#location = /healthz {#location = /_site-pricing.html { return 500; }\n    location = /healthz {#' deploy/nginx.conf")
C_STALE=$(mk stale "sed -i 's/Pricing/Pricingg/' site-src/pages/pricing.html")
D_LOG=$(mk hostilelog "sed -i 's#location = /healthz {#location = /x { access_log /srv/site/state; return 200; }\n    location = /healthz {#' deploy/nginx.conf")
E_SLOW=$(mk slow "sed -i 's#location = /healthz {#location = /_site-pricing.html { limit_rate 50; }\n    location = /healthz {#' deploy/nginx.conf")
F_LINK=$(mk symlink "ln -s /etc/passwd public/leak.html")
G_DAV=$(mk dav "sed -i 's#location = /healthz {#location /dav/ { alias /srv/site/current/html/; dav_methods PUT DELETE; }\n    location = /healthz {#' deploy/nginx.conf")
I_HANG=$(mk hang "sed -i '1a process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000); return;' site-src/build.cjs")
J_FORGE=$(mk forge "sed -i '1a require(\"fs\").writeFileSync(\"/checkout/result\", \"pass\"); require(\"fs\").chmodSync(\"/checkout/result\", 0o444); process.exit(1);' site-src/build.cjs")
K_NEXT=$(mk next "sed -i 's/Pricing/Pricing/' site-src/pages/pricing.html; echo '<!-- k -->' >> deploy/security-headers.conf")
H_CONF=$(mk confchange "sed -i 's#location = /healthz {#location = /extra { return 204; }\n    location = /healthz {#' deploy/nginx.conf")
git checkout -q main; rm -rf /tmp/$P-repo; git clone -q --bare $W /tmp/$P-repo; load repo /tmp/$P-repo
cd - >/dev/null
setmain() { root "cd /repo && git update-ref refs/heads/main $1 && chown -R 65534:101 /repo"; }

root 'echo dummy > /git-key/deploy_key; mkdir -p /srv/site/releases;
  echo "{\"metadata\":{\"resourceVersion\":\"1\"},\"spec\":{\"holderIdentity\":\"\"}}" > /fake/lease.json;
  echo "{\"data\":{}}" > /fake/cm.json; touch /fake/pod-pod1; : > /fake/events;
  chown -R 101:101 /srv/site /fake /trusted /checkin /checkout /stagetmp /stageout /git-key /repo;
  # what Kubernetes gives these volumes: emptyDir is world-writable; the PVC and the
  # Secret get group 101 (fsGroup), the Secret mode 0440
  chmod 0777 /trusted /checkin /checkout /stagetmp /stageout;   # emptyDir: 0777, no sticky bit chmod 2775 /srv/site /srv/site/releases;
  chmod 0440 /git-key/deploy_key; chmod -R g+rwX /fake
  # test only: the local repo stands in for GitHub; git refuses a repo owned by
  # another uid, and fetch runs as 65534
  chown -R 65534:101 /repo'

# the "live" website pod: serves from the volume read-only; reloads on a config-hash change
docker run -d --name $P-live --network $NET --user 101 -v "$(v releases)":/srv/site:ro -v "$(v fake)":/fake:ro \
  --entrypoint sh "$IMG_NGINX" -c 'echo "include /srv/site/current/default.conf;" > /tmp/b.conf
   sed "s#include /etc/nginx/conf.d/\*.conf;#include /tmp/b.conf;#" /etc/nginx/nginx.conf > /tmp/n.conf
   last=""; while :; do h="$(cat /fake/hash 2>/dev/null)"; if [ -e /srv/site/current/default.conf ]; then
     if [ ! -f /tmp/nginx.pid ]; then nginx -c /tmp/n.conf && last="$h"; elif [ "$h" != "$last" ]; then nginx -c /tmp/n.conf -s reload; last="$h"; fi; fi; sleep 1; done' >/dev/null
sleep 2; LIVE_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" $P-live)
root "echo $LIVE_IP > /fake/live-ip; chown 101 /fake/live-ip"

# Each step runs exactly as in 40-cronjob.yaml: its command shape and time limit,
# and its uid (fetch is 65534, the rest 101; all group 101).
limit() { sed -n "s/.*timeout -s KILL \([0-9]*\) sh \/scripts\/deployer.sh $1;.*/\1/p" "$HERE/40-cronjob.yaml"; }
step() { # step NAME IMAGE MOUNTS...
  n=$1 img=$2; shift 2
  u=101; [ "$n" = fetch ] && u=65534; t0=$(date +%s); echo "    ($n ...)"
  docker run --rm --network $NET --user $u:101 -e POD_NAME=pod1 -e REPO_URL=/repo -e NAMESPACE=reliora-website \
    -e CHECK_TIMEOUT="${CHECK_TIMEOUT:-300}" \
    -e PATH=/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e HOME=/tmp \
    -v "$(v scripts)":/scripts:ro "$@" --entrypoint sh "$img" -c "timeout -s KILL $(limit "$n") sh /scripts/deployer.sh $n; exit \$?" 2>&1 | sed -u "s/^/    /"
  rc="${PIPESTATUS[0]}"; echo "$(( $(date +%s) - t0 ))" > "/tmp/$P-took-$n"; echo "    ($n: $(cat /tmp/$P-took-$n)s)"
  return "$rc"
}
run() { # one deployer run, exactly the CronJob's mounts
  # a fresh pod gets empty volumes: clear dotfiles too
  root 'for d in /trusted /checkin /checkout /stagetmp /stageout; do find $d -mindepth 1 -maxdepth 1 -exec rm -rf {} +; done; chmod -R g+rwX /fake /srv/site 2>/dev/null'
  step lock "$IMG_K8S" -v "$(v trusted)":/trusted -v "$(v fake)":/fake
  step fetch "$IMG_GIT" -v "$(v gitkey)":/git-key:ro -v "$(v releases)":/srv/site:ro -v "$(v trusted)":/trusted -v "$(v checkin)":/checkin -v "$(v repo)":/repo:ro
  step attempt "$IMG_K8S" -v "$(v trusted)":/trusted -v "$(v checkin)":/checkin -v "$(v fake)":/fake
  step check "$IMG_NODE" -v "$(v checkin)":/checkin -v "$(v checkout)":/checkout
  step copy "$IMG_NGINX" -v "$(v releases)":/srv/site -v "$(v trusted)":/trusted -v "$(v checkout)":/checkout:ro
  step stage "$IMG_NGINX" -v "$(v releases)":/srv/site:ro -v "$(v trusted)":/trusted:ro -v "$(v stagetmp)":/stagetmp -v "$(v stageout)":/stageout --read-only
  step switch "$IMG_K8S" -v "$(v releases)":/srv/site -v "$(v trusted)":/trusted -v "$(v stageout)":/stageout:ro -v "$(v fake)":/fake
  step report "$IMG_K8S" -v "$(v trusted)":/trusted:ro -v "$(v fake)":/fake; RC=$?
}
state() { root 'grep -E "^(state|reason|commit)=" /srv/site/state 2>/dev/null | tr "\n" " "; echo; echo "current=$(readlink /srv/site/current)"'; }
expect() { # expect LABEL STATE_REGEX CURRENT_SHA EXIT
  s="$(state)"; cur="$(echo "$s" | sed -n 's/.*current=releases\/\([0-9a-f]*\).*/\1/p')"
  live="$(docker run --rm --network $NET --entrypoint sh "$IMG_K8S" -c "curl -s -o /dev/null -w %{http_code} --max-time 5 http://$LIVE_IP:8080/_site-pricing.html")"
  if echo "$s" | grep -qE "state=($2) " && [ "$cur" = "$3" ] && [ "$RC" = "$4" ]; then
    echo "PASS $1 (state ok, current ${cur:0:7}, live pricing $live, exit $RC)"; pass=$((pass+1))
  else echo "FAIL $1: got [$s] exit $RC live pricing $live; want state $2 current ${3:0:7} exit $4"; fail=$((fail+1)); fi
}

echo "== 1 before cutover: publish only"; setmain $A; run; expect publish "published" $A 0
echo "== 2 cutover, then a normal run is a skip"; root 'echo release-volume > /fake/serving'; run; expect skip-up-to-date "published" $A 0
root "sed -i 's/^state=published/state=ok/' /srv/site/state"
if [ -z "${TAIL_ONLY:-}" ]; then
echo "== 3 a page returns 500 (stage smoke)"; setmain $B_500; run; expect stage-500 "failed_smoke" $A 1
echo "== 4 same commit again: pinned"; run; expect pinned "failed_smoke" $A 0
echo "== 5 stale page (--check)"; setmain $C_STALE; run; expect stale "failed_check" $A 1
echo "== 6 hostile access_log onto the volume"; setmain $D_LOG; run; expect hostile-log "failed_check" $A 1
root 'grep -c . /srv/site/state' | grep -q '^8$' && { echo "PASS state file untouched by nginx"; pass=$((pass+1)); } || { echo "FAIL state file changed"; fail=$((fail+1)); }
echo "== 7 slow page (limit_rate)"; setmain $E_SLOW; run; expect slow "failed_smoke|failed_timeout" $A 1
echo "== 8 symlink in public/"; setmain $F_LINK; run; expect symlink "failed_check" $A 1
echo "== 9 WebDAV PUT allowed by the commit's config"; setmain $G_DAV; run; expect dav-deploys "ok" $G_DAV 0
# PUT a new file and DELETE a page, into a directory that exists: only the
# read-only mount can stop them.
code="$(docker run --rm --network $NET --entrypoint sh "$IMG_K8S" -c "curl -s -o /dev/null -w %{http_code} --max-time 5 -X PUT --data x http://$LIVE_IP:8080/dav/planted.txt; curl -s -o /dev/null -w ,%{http_code} --max-time 5 -X DELETE http://$LIVE_IP:8080/dav/_site-pricing.html")"
if root "test ! -e /srv/site/releases/$G_DAV/html/planted.txt && test -f /srv/site/releases/$G_DAV/html/_site-pricing.html"; then
  echo "PASS dav PUT,DELETE ($code) changed nothing: volume is read-only"; pass=$((pass+1))
else echo "FAIL dav changed the volume ($code)"; fail=$((fail+1)); fi
echo "== 10 config change: restart onto the new config"; setmain $H_CONF; run; expect confchange "ok" $H_CONF 0
root 'grep -c restart /fake/events' | grep -qv '^0$' && { echo "PASS restart requested"; pass=$((pass+1)); } || { echo "FAIL no restart"; fail=$((fail+1)); }
echo "== 11 live smoke fails once: rollback to the previous release"; setmain $A; root 'touch /fake/bad-endpoints-once; chown 101 /fake/bad-endpoints-once'; run; expect rollback "failed_smoke" $H_CONF 1
echo "== 12 recovery: killed after the swap (state switching, current = new)"
root "printf 'state=switching\nreason=switching\ncommit=$A\ndeployer=x\nprevious=$H_CONF\nprevhash=none\ntries=0\ntime=0\n' > /srv/site/state; ln -sfn releases/$A /srv/site/.c && mv -T /srv/site/.c /srv/site/current; chown -h 101:101 /srv/site/state /srv/site/current"
run; expect recover-switch "ok" $A 0
echo "== 13 the Lease held by a live pod: skip"; root "touch /fake/pod-other; jq '.spec.holderIdentity=\"other\" | .spec.renewTime=\"$(date -u +%Y-%m-%dT%H:%M:%S.000000Z)\"' /fake/lease.json > /fake/l && mv /fake/l /fake/lease.json; chown 101 /fake/lease.json" 2>/dev/null
setmain $B_500; run; expect locked "ok" $A 0
root "jq '.spec.holderIdentity=\"\"' /fake/lease.json > /fake/l && mv /fake/l /fake/lease.json; rm -f /fake/pod-other; chown 101 /fake/lease.json"
fi
echo "== 14 a check that ignores TERM and never exits"; setmain $I_HANG; CHECK_TIMEOUT=20 run
# the property: the check step itself is cut off near its limit (20 s), whatever the machine load
t="$(cat /tmp/$P-took-check)"
expect hang "failed_timeout" $A 1; [ "$t" -lt 80 ] && { echo "PASS hang bounded: check step ${t}s for a 20s limit"; pass=$((pass+1)); } || { echo "FAIL check step took ${t}s"; fail=$((fail+1)); }
echo "== 15 a check that writes its own pass, read-only, then fails"; setmain $J_FORGE; run; expect forged-pass "failed_check" $A 1
if [ -z "${TAIL_ONLY:-}" ]; then
echo "== 16 attempts exceeded: stop, pin, no untrusted code"
dv="$(docker run --rm -v "$(v scripts)":/s:ro --entrypoint sh "$IMG_K8S" -c 'cat /s/deployer.sh /s/smoke.sh /s/stage-top.conf | sha256sum | cut -c1-12')"
setmain $K_NEXT; root "jq --arg k \"$K_NEXT-$dv\" '.data[\"attempt-key\"]=\$k | .data[\"attempt-count\"]=\"3\"' /fake/cm.json > /fake/c && mv /fake/c /fake/cm.json; chown 101 /fake/cm.json"
run; expect overflow "failed_timeout" $A 1
grep -A8 '== 16' /tmp/sdtest.log 2>/dev/null | grep -q '\[check\]' && { echo "FAIL check ran after attempts were exceeded"; fail=$((fail+1)); } || { echo "PASS no check run after attempts were exceeded"; pass=$((pass+1)); }
fi
[ -n "${TAIL_ONLY:-}" ] && root "sed -i 's/^state=published/state=ok/' /srv/site/state"
echo "== 17 the API is down during the switch: infra_error, nothing switched"
root "printf 'state=ok\nreason=live\ncommit=$A\ndeployer=x\nprevious=none\nprevhash=none\ntries=0\ntime=0\n' > /srv/site/state; chown 101 /srv/site/state; jq '.data[\"attempt-count\"]=\"0\"' /fake/cm.json > /fake/c && mv /fake/c /fake/cm.json; touch /fake/api-down; chown 101 /fake/cm.json /fake/api-down"
setmain $H_CONF; run; expect api-down "infra_error|staging" $A 1
root 'rm -f /fake/api-down'; echo "== 18 the API is back: the next run deploys"; run; expect api-back "ok" $H_CONF 0
echo "== 19 real ssh to GitHub as uid 65534 (a dummy key must be refused by GitHub, not by ssh)"
out="$(docker run --rm --user 65534:101 -e HOME=/tmp -v "$(v scripts)":/scripts:ro --entrypoint sh "$IMG_GIT" -c 'ssh-keygen -q -t ed25519 -N "" -f /tmp/k >/dev/null && timeout -s KILL 30 ssh -i /tmp/k -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/scripts/known_hosts -o StrictHostKeyChecking=yes -T git@github.com 2>&1')"
echo "$out" | grep -q 'Permission denied (publickey)' && { echo "PASS ssh reached GitHub with the pinned host key and was refused for the key"; pass=$((pass+1)); } || { echo "FAIL ssh: $out"; fail=$((fail+1)); }
echo; echo "passed $pass, failed $fail"; [ "$fail" -eq 0 ]
