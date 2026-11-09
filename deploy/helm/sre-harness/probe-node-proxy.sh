#!/bin/sh
# Probe which nodes' kubelet proxy subresource the API server can actually
# reach, and report the schedulable ones that cannot.
#
# Regression probe for the 2026-11-09 monitor incident: every harness cron pod
# was scheduled onto one particular node and `kubectl logs job/...` answered
#
#   proxy error from 127.0.0.1:6443 while dialing <node IP>:10250,
#   code 502: 502 Bad Gateway
#
# for every read -- live or finished, new pod or old -- while the same node
# happily served scheduling (containers created and ran on it the whole time).
# The apiserver->kubelet proxy is one shared path for logs, exec, attach and
# port-forward, so on that node the documented forensic path (`kubectl logs
# job/...`) and any live exec/debug were silently dead while `kubectl get`
# looked healthy. Nothing in the harness could see it: the sweep reads nodes
# and pods fine, and a 502 on a log read looks like an ordinary bad node.
#
# This probe asks the apiserver to proxy /healthz on every node and
# distinguishes:
#   OK            HTTP 200 'ok'          proxy path works
#   BLACKHOLE     HTTP status reply      the request reached the proxy path
#                 (status-                   and something answered with a
#                 bearing,                 verdict that is neither an auth
#                 incl. a 200            reply nor 'ok' -- e.g. 502/503 from
#                 that is not 'ok')      the proxy hop, or 404 from a
#                                        non-kubelet listener. Logs/exec/
#                                        port-forward on such a node fail
#                                        while the node still schedules pods
#                                        (2026-11-09: one node answered 502
#                                        to every proxy read, all day).
#   NOAUTH        HTTP 401/403           an auth verdict. NOT proof the path
#                                        works (a broken kubelet answers 401
#                                        on its plain port too) and not proof
#                                        it is broken: the node is unjudged.
#                                        With the monitor's restricted RBAC
#                                        every node answers this way and the
#                                        whole probe says NOAUTH-ALL --
#                                        honestly blind, never falsely OK.
#                                        rbac.clusterNodeRead (chart) grants
#                                        nodes get/list, but NOT nodes/proxy;
#                                        NOAUTH-ALL on that identity means
#                                        the grant needs nodes/proxy added --
#                                        same read-only blast radius (a node
#                                        proxy GET reaches no secrets), the
#                                        operator's call.
#   UNREACHABLE   dial error, timeout    nothing answering the proxy port.
#                                        Counted as a failure on a schedulable
#                                        node ONLY when some node answered
#                                        with a real HTTP status: if every
#                                        node fails at dial level the probe
#                                        cannot tell a dead kubelet from no
#                                        proxy permission at all, so it
#                                        reports PROBE-UNUSABLE instead.
#
# Read-only (it only calls `kubectl get --raw`), so the monitor runs it under
# its normal restricted SA. Exit codes:
#   0  clean pass, or pass(partial) with unjudged (NOAUTH) nodes listed
#   1  a schedulable node is BLACKHOLE, or UNREACHABLE while others answered
#   3  PROBE-UNUSABLE: no node answered with an HTTP status (dial-level
#      failures only) -- an environment issue, not a node verdict
#
# Usage (inside the cluster, with kubectl + the monitor's kubeconfig):
#   sh deploy/helm/sre-harness/probe-node-proxy.sh
#   sh deploy/helm/sre-harness/probe-node-proxy.sh --verbose   # list nodes
#                                                             # skipped as unschedulable
set -u

VERBOSE=0
if [ "${1:-}" = "--verbose" ]; then
  VERBOSE=1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "FAIL: kubectl not found" >&2
  exit 2
fi

TABLE="$(kubectl get nodes -o json 2>/dev/null)"
if [ -z "$TABLE" ]; then
  echo "FAIL: kubectl get nodes -o json returned nothing" >&2
  exit 2
fi

# One "name|ip|roles|taints|pressure" line per node.
ROWS="$(printf '%s' "$TABLE" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let list;
    try { list = JSON.parse(raw).items || []; } catch (e) {
      console.error("FAIL: cannot parse node list: " + e.message);
      process.exit(2);
    }
    for (const n of list) {
      const labels = (n.metadata || {}).labels || {};
      const roles = Object.keys(labels)
        .filter((k) => k.startsWith("node-role.kubernetes.io/"))
        .map((k) => k.split("/").pop())
        .sort()
        .join(",");
      const ip =
        ((n.status || {}).addresses || []).find((a) => a.type === "InternalIP") || {};
      const specTaints = (((n.spec || {}).taints) || [])
        .filter((t) => t.effect === "NoSchedule" || t.effect === "PreferNoSchedule")
        .map((t) => t.key + ":" + t.effect)
        .join(",");
      const pressure = ((n.status || {}).conditions || [])
        .filter(
          (c) =>
            (c.type === "DiskPressure" || c.type === "ProcessPressure") &&
            c.status === "True"
        )
        .map((c) => c.type)
        .join(",");
      console.log(
        [
          (n.metadata || {}).name || "?",
          ip.address || "",
          roles || "-",
          specTaints || "-",
          pressure || "-",
        ].join("|")
      );
    }
  });
' 2>/dev/null)"

if [ -z "$ROWS" ]; then
  echo "FAIL: no nodes parsed" >&2
  exit 2
fi

printf '%-22s %-15s %-12s %-10s %s\n' "NODE" "IP" "PROXY" "SCHED" "NOTE"
FAIL=0
NOAUTH_SEEN=0
STATUS_SEEN=0
UNREACHABLE_SCHED=0
while IFS='|' read -r name ip roles taints pressure; do
  [ -n "$name" ] || continue

  # Does the scheduler put normal pods here? A control-plane role, a
  # NoSchedule/PreferNoSchedule taint or disk/pid pressure says effectively
  # no, which is what decides whether a broken proxy on this node matters.
  SCHED="yes"
  WHY=""
  case "$roles" in
    *master*|*control-plane*) SCHED="no"; WHY="control-plane" ;;
  esac
  if [ "$SCHED" = "yes" ] && [ "$taints" != "-" ]; then
    SCHED="no"; WHY="taint $taints"
  fi
  if [ "$SCHED" = "yes" ] && [ "$pressure" != "-" ]; then
    SCHED="no"; WHY="$pressure"
  fi

  PROXY="UNKNOWN"
  DETAIL=""
  if [ -z "$ip" ]; then
    PROXY="UNREACHABLE"; DETAIL="no InternalIP"
  else
    ERR=/tmp/probe-node-proxy.$$.err
    OUT="$(kubectl get --raw "/api/v1/nodes/${ip}:10250/proxy/healthz" 2>"$ERR")"
    RC=$?
    # Classify on the FULL error text; truncate only for display. Cutting to
    # 120 chars first loses the "code NNN" at the tail of kubectl's proxy
    # errors, which is the whole signal (found by smoke test, not in the lab:
    # real 502s read as dial failures through a short cut).
    DETAIL_FULL="$(tr '\n' ' ' <"$ERR")"
    DETAIL="$(printf '%s' "$DETAIL_FULL" | cut -c1-120)"
    rm -f "$ERR"
    if [ $RC -eq 0 ]; then
      if printf '%s' "$OUT" | grep -q 'ok'; then
        PROXY="OK"
      else
        PROXY="BLACKHOLE"; DETAIL="200 but not 'ok': $(printf '%s' "$OUT" | cut -c1-60)"
      fi
    else
      # kubectl folds the apiserver's verdict into its error text, in two
      # shapes: "Error from server (Forbidden): ..." for Status objects
      # rendered as client errors (the RBAC reply lands here -- there is no
      # literal "code 403" in it), and "... code 502: 502 Bad Gateway" for
      # proxied upstream failures (the black hole lands there). Auth-shaped
      # text first (NOAUTH: unjudged), then any other HTTP status (the path
      # answered with a non-auth verdict: BLACKHOLE), then no status at all
      # (dial-level: UNREACHABLE).
      case "$DETAIL_FULL" in
        *"is forbidden"*|*"Forbidden"*|*"Unauthorized"*|*"cannot get resource"*|*"code 401"*|*"code 403"*)
          PROXY="NOAUTH" ;;
        *"code "*) PROXY="BLACKHOLE" ;;
        *) PROXY="UNREACHABLE" ;;
      esac
    fi
  fi

  printf '%-22s %-15s %-12s %-10s %s\n' "$name" "$ip" "$PROXY" "$SCHED" "$DETAIL"

  case "$PROXY" in
    BLACKHOLE)
      STATUS_SEEN=1
      if [ "$SCHED" = "yes" ]; then
        # A non-auth, non-ok status reply on a schedulable node. Written as
        # if/fi, not `[ ... ] && FAIL=1`: when the test is false that form
        # returns 1, and as the last command in the loop body it would set
        # the loop's own exit status -- a trap for `set -e` callers on a
        # node that should not fail.
        FAIL=1
      fi
      ;;
    OK) STATUS_SEEN=1 ;;
    NOAUTH) NOAUTH_SEEN=1 ;;
    UNREACHABLE)
      if [ "$SCHED" = "yes" ]; then
        UNREACHABLE_SCHED=1
      fi
      ;;
  esac
  if [ "$VERBOSE" = "1" ] && [ "$SCHED" = "no" ] \
     && { [ "$PROXY" = "BLACKHOLE" ] || [ "$PROXY" = "UNREACHABLE" ]; }; then
    printf '  -> not counted: %s\n' "$WHY"
  fi
done <<EOF
$ROWS
EOF

if [ "$STATUS_SEEN" = "0" ] && [ "$NOAUTH_SEEN" = "0" ]; then
  # Nothing answered with any HTTP verdict at all: not one status reply, not
  # even an auth reply. This is not a per-node signal -- it means the probe
  # itself cannot reach the proxy path from here (no network to 6443's proxy
  # route, an apiserver that never answers this subresource, a kubectl
  # misconfigured against another context). Reporting PASS would lie;
  # reporting FAIL would blame nodes for an environment problem.
  echo "PROBE-UNUSABLE: no node answered the proxy probe with any HTTP status."
  echo "      The probe cannot judge anything from here (kubectl context/network);"
  echo "      treat kubelet-proxy state as UNKNOWN, not healthy."
  exit 3
fi

if [ "$FAIL" = "1" ]; then
  echo "FAIL: at least one schedulable node answered the proxy probe with a"
  echo "      non-auth, non-ok status -- pods there schedule and run, but"
  echo "      logs/exec/port-forward via the apiserver fail, so harness job"
  echo "      forensics on that node are blind: read sre-harness-run-log"
  echo "      instead of kubectl logs, and report it as a HARNESS WARN."
  exit 1
fi

if [ "$UNREACHABLE_SCHED" = "1" ] && [ "$STATUS_SEEN" = "1" ]; then
  # Other nodes proved the probe works, so a dial-level failure on a
  # schedulable node is a real signal: nothing answers its proxy port.
  echo "FAIL: a schedulable node refused/never answered the proxy dial while"
  echo "      other nodes answered normally -- its kubelet serving path is down."
  exit 1
fi

if [ "$NOAUTH_SEEN" = "1" ]; then
  # This identity could not use nodes/proxy somewhere, so a pass here only
  # covers the nodes that answered OK; say so instead of claiming more than
  # was seen. NOAUTH-ALL (every node unjudged) is this chart's today: the
  # pre-provisioned SA has no nodes/proxy right, so the monitor is blind by
  # RBAC design and only a BLACKHOLE on the few nodes that do answer status
  # would ever surface. Granting nodes/proxy to rbac.clusterNodeRead (same
  # read-only blast radius -- a node proxy GET reaches no secrets) is the
  # operator's call.
  echo "PASS(partial): no schedulable node answered with a proxy failure;"
  echo "      nodes answering 401/403 are unjudged by this identity."
  exit 0
fi

echo "PASS: kubelet proxy path answered healthy on all schedulable nodes."
exit 0
