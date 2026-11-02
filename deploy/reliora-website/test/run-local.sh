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
H_CONF=$(mk confchange "sed -i 's#location = /healthz {#location = /extra { return 204; }\n    location = /healthz {#' deploy/nginx.conf")
git checkout -q main; rm -rf /tmp/$P-repo; git clone -q --bare $W /tmp/$P-repo; load repo /tmp/$P-repo
cd - >/dev/null
setmain() { root "cd /repo && git update-ref refs/heads/main $1"; }

root 'echo dummy > /git-key/deploy_key; mkdir -p /srv/site/releases;
  echo "{\"metadata\":{\"resourceVersion\":\"1\"},\"spec\":{\"holderIdentity\":\"\"}}" > /fake/lease.json;
  echo "{\"data\":{}}" > /fake/cm.json; touch /fake/pod-pod1; : > /fake/events;
  chown -R 101:101 /srv/site /fake /trusted /checkin /checkout /stagetmp /stageout /git-key /repo'

# the "live" website pod: serves from the volume read-only; reloads on a config-hash change
docker run -d --name $P-live --network $NET --user 101 -v "$(v releases)":/srv/site:ro -v "$(v fake)":/fake:ro \
  --entrypoint sh "$IMG_NGINX" -c 'echo "include /srv/site/current/default.conf;" > /tmp/b.conf
   sed "s#include /etc/nginx/conf.d/\*.conf;#include /tmp/b.conf;#" /etc/nginx/nginx.conf > /tmp/n.conf
   last=""; while :; do h="$(cat /fake/hash 2>/dev/null)"; if [ -e /srv/site/current/default.conf ]; then
     if [ ! -f /tmp/nginx.pid ]; then nginx -c /tmp/n.conf && last="$h"; elif [ "$h" != "$last" ]; then nginx -c /tmp/n.conf -s reload; last="$h"; fi; fi; sleep 1; done' >/dev/null
sleep 2; LIVE_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" $P-live)
root "echo $LIVE_IP > /fake/live-ip; chown 101 /fake/live-ip"

step() { # step NAME IMAGE MOUNTS...
  n=$1 img=$2; shift 2
  docker run --rm --network $NET --user 101:101 -e POD_NAME=pod1 -e REPO_URL=/repo -e NAMESPACE=reliora-website \
    -e PATH=/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e HOME=/tmp \
    -v "$(v scripts)":/scripts:ro "$@" --entrypoint sh "$img" /scripts/deployer.sh "$n" 2>&1 | sed "s/^/    /"
  return "${PIPESTATUS[0]}"
}
run() { # one deployer run, exactly the CronJob's mounts
  root 'rm -rf /trusted/* /checkin/* /checkout/* /stagetmp/* /stageout/*'
  step lock "$IMG_K8S" -v "$(v trusted)":/trusted -v "$(v fake)":/fake
  step fetch "$IMG_GIT" -v "$(v gitkey)":/git-key:ro -v "$(v releases)":/srv/site:ro -v "$(v trusted)":/trusted -v "$(v checkin)":/checkin -v "$(v repo)":/repo:ro
  step attempt "$IMG_K8S" -v "$(v trusted)":/trusted -v "$(v fake)":/fake
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
echo; echo "passed $pass, failed $fail"; [ "$fail" -eq 0 ]
