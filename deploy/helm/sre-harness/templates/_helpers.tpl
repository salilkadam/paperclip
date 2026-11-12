{{- define "sre-harness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sre-harness.fullname" -}}
{{- printf "%s" (include "sre-harness.name" .) -}}
{{- end -}}

{{- define "sre-harness.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "sre-harness.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: paperclip-scoped-rbac
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "sre-harness.namespace" -}}
{{- .Values.namespace | default .Release.Namespace -}}
{{- end -}}

{{- define "sre-harness.buildNodeSelector" -}}
{{- /*
nodeSelector for workloads that SSH to the GPU build host. The dshci key is
source-IP restricted in authorized_keys, so these pods are pinned to the one
node the GPU host will accept them from.

This must stay a Helm action comment. Prose text here is emitted, lands on the
same YAML line as the first mapping key after nindent, and is then parsed as a
YAML comment -- which silently swallows that key and yields an empty
nodeSelector. helm lint does not catch it.
*/ -}}
{{- $sel := dict -}}
{{- with .Values.nodeSelector }}{{- $sel = merge (deepCopy .) $sel -}}{{- end }}
{{- with .Values.build.nodeHostname }}{{- $_ := set $sel "kubernetes.io/hostname" . -}}{{- end }}
{{- if $sel }}{{ toYaml $sel }}{{- end }}
{{- end -}}

{{- define "sre-harness.gpuaiPatch" -}}
# dsh model config shared by every headless component (monitor, remediate,
# approvals). Rendered into a ConfigMap key; mirrors
# deploy/harness-image/dsh-profile-patch.yml minus interactive-only entries.
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gpuai:
        displayName: "GPU-AI Gateway"
        api: openai-completions
        baseURL: {{ .Values.gpuai.baseURL | quote }}
        apiKeyEnv: GPUAI_API_KEY
        models:
          - id: {{ .Values.gpuai.model | quote }}
            name: {{ .Values.gpuai.model | quote }}
            contextWindow: 131072
            maxTokens: 16384
            input: [text]
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gpuai
    model: {{ .Values.gpuai.model | quote }}
{{- end -}}

{{- define "sre-harness.sshBootstrap" -}}
# Materialize the pinned GPU build-host SSH credentials from ESO-synced env
# vars. required:false fallbacks so components without SSH still run when the
# Vault properties are absent.
#
# Path matters: OpenSSH resolves `~` through getpwuid(), NOT $HOME. These pods
# export HOME=/home/node/.dsh for dsh state, so writing the key material under
# $HOME/.ssh leaves ssh looking at /home/node/.ssh and every GPU build dies
# with "Host key verification failed" (verified 2026-10-18). Write to the
# passwd home instead.
if [ -n "${GPU_SSH_KEY:-}" ]; then
  SSH_DIR="{{ .Values.ssh.home }}/.ssh"
  mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
  printf '%s\n' "$GPU_SSH_KEY" > "$SSH_DIR/id_ed25519" && chmod 600 "$SSH_DIR/id_ed25519"
  printf '%s\n' "${GPU_KNOWN_HOSTS:-}" > "$SSH_DIR/known_hosts" && chmod 644 "$SSH_DIR/known_hosts"
  # BatchMode makes an unattended session fail fast instead of blocking on a
  # password/host-key prompt that nobody is there to answer.
  printf '%s\n' \
    'Host *' \
    '    BatchMode yes' \
    '    StrictHostKeyChecking yes' \
    '    ConnectTimeout 10' \
    '    ServerAliveInterval 15' \
    '    ServerAliveCountMax 4' > "$SSH_DIR/config" && chmod 600 "$SSH_DIR/config"
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes"
  export GPU_SSH_USER="${GPU_SSH_USER:-dshci}"
  export GPU_SSH_PORT="${GPU_SSH_PORT:-52225}"
  # The address is runtime configuration, never chart content: the fork is
  # public. Say it here, because an unset host otherwise surfaces much later
  # as an unresolvable hostname inside a build the operator is waiting on.
  if [ -z "${GPU_SSH_HOST:-}" ]; then
    echo "[ssh] GPU_SSH_HOST is unset; GPU builds and deploys cannot run." >&2
    echo "[ssh] Fix: kubectl -n <namespace> create configmap {{ .Values.buildHost.hostConfigMap }} --from-literal=GPU_SSH_HOST=<address>" >&2
  fi
fi
{{- end -}}

{{- define "sre-harness.runHeadless" -}}
# Run one unattended dsh headless session with live forensics.
# Reads DSH_PROFILE and TASK; sets DSH_RC and DSH_FINAL. Callers must wrap
# this in `set +e` / `set -e` because a non-zero dsh exit is expected traffic.
#
# Why --json + tail instead of OUT="$(dsh ...)": a buffered command
# substitution holds the whole session in memory, so when the job is killed on
# activeDeadlineSeconds the pod dies with zero output and the run is
# undebuggable. Streaming each event line to container stdout means `kubectl
# logs` always shows how far the engineer actually got.
DSH_LOG=/tmp/dsh-events.jsonl
: > "$DSH_LOG"
DSH_STARTED_AT="$(date +%s)"
# Read by record_run and the trap, some of which now run before the session
# has set them. These scripts run under `set -u`, and an unset read there kills
# the record silently.
DSH_RC=
DSH_PID=
DSH_TAIL=
DSH_HB=

# Evidence must outlive the pod. On a deadline kill the Job controller deletes
# the pod in the same second, so `kubectl logs` is unreadable afterwards and
# the run reports nothing at all. The SIGTERM grace window is the last chance
# to say anything, so report how far the session got before we exit.
# session_summary builds (but does not send) a "how far did it get" digest of
# the event stream. Split out of post_partial_evidence so the heartbeat can
# reuse it every few minutes without spamming Slack.
session_summary() {
  DSH_PARTIAL="$(DSH_STARTED_AT="$DSH_STARTED_AT" node -e '
    const fs = require("fs");
    let raw = "";
    try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch {}
    const events = raw.split("\n").filter((l) => l.trim());
    const parts = [];
    if (process.env.DSH_STARTED_AT) {
      const mins = Math.round((Date.now() / 1000 - Number(process.env.DSH_STARTED_AT)) / 60);
      parts.push("ran " + mins + " min");
    }
    parts.push(events.length + " events");
    let tools = 0;
    const errs = [];
    const words = [];
    let last = "";
    for (const line of events) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "tool_call") {
        tools++;
        last = String(e.tool || "?") + " " + String((e.input && e.input.description) || "");
      } else if (e.type === "text" && e.text) {
        words.push(String(e.text).replace(/\s+/g, " ").slice(0, 400));
        if (words.length > 2) words.shift();
      } else if (e.type === "error") {
        errs.push(String(e.message || "unknown"));
      }
    }
    parts.push(tools + " tool calls");
    if (errs.length) parts.push("errors: " + errs.join("; "));
    if (words.length) parts.push("last words: " + words.join(" // "));
    if (last) parts.push("last activity: " + last);
    process.stdout.write(parts.join(" | ").slice(0, 4000));
  ' "$DSH_LOG" 2>/dev/null || true)"
}

# Last words on a cut-short run: the summary above, posted to Slack.
post_partial_evidence() {
  session_summary
  post_to_slack "RUN TERMINATED BEFORE COMPLETION ($DSH_PROFILE, SIGTERM): ${DSH_PARTIAL:-no session events captured}"
}

# Which node is this pod on, and can its own logs be read back? Sets RUN_NODE
# and RUN_LOG_READABLE ("yes"/"no"/"") for the next record_run; call it
# immediately before every record_run so each record carries the answer of its
# own moment (a node can black out mid-run).
#
# Why this exists: from 2026-11-09 one schedulable node answers the
# apiserver->kubelet proxy with 502 for log/exec reads while serving pods
# normally, and every log path the harness normally uses -- including reading
# THIS pod's own logs, which the monitor prompt tells the sweep to do -- dies
# silently on it. The run-log ConfigMap is then the only surviving evidence,
# and without these fields a missing log reads as "no evidence gathered"
# instead of "evidence unreadable on node X".
#
# Deliberately NOT kubectl: `kubectl logs <own pod>` is exactly the broken
# path, and the SA may not even read pods outside bionicorg. A direct read of
# the pod object via the in-cluster API is namespaced RBAC the harness
# already holds (it writes the run-log CM the same way), and the object read
# answers even when the node's log proxy is black -- the pod spec/status ride
# on etcd, not on the kubelet. "no" therefore means: pod object rejected with
# a real error, or the node answers this log request with a real non-auth HTTP
# status (500/502...); a dial-level failure (hang, refused, TLS) and 401/403/
# 404 are NOT "no" -- they prove nothing about this node, so the record stays
# unprobed (null) instead of accusing on silence.
probe_log_readability() {
  RUN_NODE="" RUN_LOG_READABLE=""
  local_out="$(POD_NAME="${HOSTNAME:-}" node -e '
    const fs = require("fs");
    const https = require("https");
    const SA = "/var/run/secrets/kubernetes.io/serviceaccount/";
    let ns, tok, ca;
    try {
      ns = fs.readFileSync(SA + "namespace", "utf8").trim();
      tok = fs.readFileSync(SA + "token", "utf8").trim();
      ca = fs.readFileSync(SA + "ca.crt");
    } catch (e) { process.exit(0); } // no SA mounted: no probe, not a verdict
    const name = encodeURIComponent(process.env.POD_NAME || "");
    if (!ns || !tok || !name) process.exit(0);
    const api = (path, wantBody, done) => {
      const r = https.request({
        host: "kubernetes.default.svc", path, ca,
        headers: { authorization: "Bearer " + tok },
      }, res => {
        let d = "";
        res.on("data", c => { d += c; });
        res.on("end", () => done(res.statusCode, d));
      });
      r.setTimeout(6000, () => r.destroy(new Error("dial")));
      r.on("error", () => done(0, "")); // dial-level failure
      r.end();
    };
    const nodePath = "/api/v1/namespaces/" + ns + "/pods/" + name;
    // Bounded worst case: the pod read, then one container probe. A node that
    // black-holes silently (dial hangs) must not stall the heartbeat past the
    // termination-grace budget; an unjudged result beats a late record.
    setTimeout(() => process.exit(0), 13000).unref();
    api(nodePath, true, (code, body) => {
      if (code === 401 || code === 403) process.exit(0); // hop answered, unjudged
      let nodeName = "", containers = [];
      if (code === 200) {
        try {
          const p = JSON.parse(body);
          nodeName = (p.spec && p.spec.nodeName) || "";
          containers = ((p.spec && p.spec.containers) || []).map(c => c.name);
        } catch (e) {}
      }
      // The pod object itself is the fallback verdict source: node name and
      // containers come from etcd and answer even while the log proxy of the
      // node is black. Without them there is nothing to attribute the fault
      // to. (Apostrophe rule for everything in this node -e body: the whole
      // script is embedded in single quotes, so one apostrophe anywhere ends
      // the shell string mid-flight. dash -n on the rendered chart catches
      // it; keep these comments apostrophe-free.)
      if (!nodeName) {
        if (code >= 400 && code !== 401 && code !== 403) {
          process.stdout.write("node=|read=no");
          process.exit(0);
        }
        process.exit(0); // unreachable object, unjudged
      }
      if (!containers.length) containers = [""]; // unnamed pod: default log read
      const prefix = "node=" + nodeName + "|";
      // Verdict rules, deliberately asymmetric:
      //  - a definitive log answer (2xx = readable, any other HTTP status =
      //    the node refused/proxied-fail the read) is reported WITH the node
      //    name so the record can attribute a black hole.
      //  - a dial-level failure (code 0: hang, connection refused, TLS error)
      //    is NOT evidence about the node, so it stays unjudged rather than
      //    accusing it. Same for 401/403/404 on the log read: the hop
      //    answered but that status proves nothing about readability.
      //  - when no log read reaches a definitive answer, still name the node
      //    (read= pending, dropped by the sed below) so the record carries the
      //    attribution even while the readability verdict is null.
      let judged = false;
      const decide = c => {
        if (judged) return;
        if (c >= 200 && c < 300) { judged = true; process.stdout.write(prefix + "read=yes"); process.exit(0); }
        if (c === 0 || c === 401 || c === 403 || c === 404) return; // unjudged: no answer, or a status that proves nothing
        judged = true;
        process.stdout.write(prefix + "read=no"); // real 5xx / proxied failure from the node
        process.exit(0);
      };
      for (const c of containers) api(nodePath + "/log?container=" + encodeURIComponent(c) + "&tailLines=1", false, decide);
      // No container reached a definitive verdict (all hung or 401/403/404):
      // name the node with a pending marker so the record still attributes it;
      // read= stays null because the sed below only extracts yes/no.
      process.on("exit", () => { if (!judged) process.stdout.write(prefix + "read=pending"); });
    });
  ' 2>/dev/null || true)"
  RUN_NODE="$(printf '%s' "$local_out" | sed -n 's/^node=\([^|]*\)|.*$/\1/p')"
  RUN_LOG_READABLE="$(printf '%s' "$local_out" | sed -n 's/.*read=\(ye[sd]\|n[oq]\)[^a-z]*$/\1/p')"
}

# Durable run record. The Job controller deletes the pod on a deadline kill and
# again at the backoff limit, so ttlSecondsAfterFinished preserves nothing and
# post-incident forensics over cron logs dies with the pod. Append one compact
# JSON line per run to the namespaced ConfigMap sre-harness-run-log through the
# in-cluster API. That ConfigMap is created on first write and is deliberately
# NOT chart-owned: a helm-managed ConfigMap would revert the operator's records
# on every upgrade, the same drift class this harness already bans elsewhere.
# Best-effort by design -- a failed record must never fail or delay a run, and
# a run whose API call hangs must still finish inside its Slack grace window.
#
# Keep this definition above the TERM trap, not merely above its normal call
# site. A POSIX shell binds a function only once the definition statement has
# executed, and the trap fires while the shell is still parked in
# `wait "$DSH_PID"`, before anything below it has run. When this definition sat
# below the wait, a deadline kill died with `record_run: not found` and left no
# run-log entry: the record meant to survive the pod deletion was dropped by
# the very handler written to make it survive (dash-reproduced 2026-10-30,
# after the 00:40 remediate deadline kill left nothing to triage).
record_run() {
  # $1: 1 when the run was cut short, 0 on a normal end. $2: excerpt already
  # deemed safe for the Slack report (this text is that same report's content).
  # $3 (optional): "running" for in-flight beats -- same run, rewritten in
  # place, rc still unknown; anything else means the run's final record.
  #
  # RUN_NODE / RUN_LOG_READABLE carry the probe_log_readability verdict.
  # Keep the `${VAR:-}` default-expansion form. These scripts run under
  # `set -u`, so a bare "$VAR" on this line aborts EVERY record with
  # "parameter not set" before node ever runs -- the same class of bug as the
  # definition-order note above. And do NOT prefix plain "$VAR" expecting no
  # leak: dash aborts that form too. Verified against dash (the image shell):
  # `${VAR:-}` reads "" when unset, keeps a per-call `VAR=x record_run ...`
  # value when set, and leaks nothing back into the caller. An absent probe
  # reaches node as "" and is recorded as null = "never probed", which stays
  # distinguishable from "probed, unreadable".
  RUN_LOG="$DSH_LOG" RUN_STARTED_AT="$DSH_STARTED_AT" RUN_RC="$DSH_RC" \
    RUN_COMPONENT="$DSH_PROFILE" RUN_TERMINATED="$1" RUN_EXCERPT="$2" RUN_MODE="${3:-final}" RUN_CM="sre-harness-run-log" \
    RUN_NODE="${RUN_NODE:-}" RUN_LOG_READABLE="${RUN_LOG_READABLE:-}" node -e '
    const fs = require("fs");
    const https = require("https");
    const SA = "/var/run/secrets/kubernetes.io/serviceaccount/";
    const ns = fs.readFileSync(SA + "namespace", "utf8").trim();
    const tok = fs.readFileSync(SA + "token", "utf8").trim();
    const ca = fs.readFileSync(SA + "ca.crt");
    const cm = process.env.RUN_CM;
    let events = 0, tools = 0;
    try {
      for (const l of fs.readFileSync(process.env.RUN_LOG, "utf8").split("\n")) {
        if (!l.trim()) continue;
        events++;
        try { if (JSON.parse(l).type === "tool_call") tools++; } catch (e) {}
      }
    } catch (e) {}
    const mode = process.env.RUN_MODE || "final";
    const rec = {
      component: process.env.RUN_COMPONENT || "unknown",
      startedAt: new Date(Number(process.env.RUN_STARTED_AT) * 1000).toISOString(),
      finishedAt: new Date().toISOString(),
      running: mode === "running",
      rc: mode === "running" ? null : Number(process.env.RUN_RC || 0),
      terminated: process.env.RUN_TERMINATED === "1",
      events: events,
      toolCalls: tools,
      node: process.env.RUN_NODE || null,
      // Probe outcome, not a guess: "yes"/"no" only when probe_log_readability
      // reached a definitive log answer at record time; null when no probe ran
      // or the probe stayed unjudged (hang, auth-only reply). null and "no"
      // must stay distinct -- a record from a session that never probes (older
      // image, manual run) says nothing about logs, while "no" is evidence the
      // log path of that node was black.
      logsReadable: /^(yes|no)$/.test(process.env.RUN_LOG_READABLE || "") ? process.env.RUN_LOG_READABLE : null,
      // Verdict evidence lives here. 500 chars cuts a report off before its
      // PAPERCLIP HEALTH / root-cause lines (observed 2026-11-12: the 17:30
      // run-log record held the preamble of the sweep, not its verdict), and
      // the run-log CM is the only durable record a kubelet-black-holed node
      // leaves -- truncating it destroys the one copy of the finding.
      excerpt: String(process.env.RUN_EXCERPT || "").replace(/\s+/g, " ").slice(0, 3000),
    };
    const api = (method, path, body, ctype, done) => {
      const r = https.request({
        host: "kubernetes.default.svc",
        path: "/api/v1/namespaces/" + ns + "/configmaps" + path,
        method: method,
        ca: ca,
        headers: body !== undefined
          ? { authorization: "Bearer " + tok, "content-type": ctype }
          : { authorization: "Bearer " + tok },
      }, res => {
        let d = "";
        res.on("data", c => { d += c; });
        res.on("end", () => done(res.statusCode, d));
      });
      r.setTimeout(10000, () => r.destroy(new Error("api timeout")));
      r.on("error", e => done(0, String(e && e.message)));
      r.end(body === undefined ? undefined : body);
    };
    const json = o => JSON.stringify(o);
    const line = json(rec);
    // Optimistic concurrency. A blind merge-patch of a stale read lets two
    // writers inside the same second overwrite each other: the normal-exit
    // write of one component silently erases the trap write of another, and
    // the deadline-killed run loses exactly the record written to survive it.
    // Carrying the resourceVersion just read makes the API server reject a
    // stale write with 409; re-read and re-append, bounded, so a contended
    // loop can never eat the Slack grace window. Without a readable
    // resourceVersion the patch stays blind -- the old best-effort behavior.
    // One shared budget: each API call may take 10s, so a third attempt
    // could outlast the 60s termination grace (plus the 10s Slack post).
    // No retry starts after 15s, keeping the worst case near 35s.
    const started = Date.now();
    const append = (attempt) => {
      if (attempt > 1 && Date.now() - started > 15000) {
        console.log("[run-record] out of time after " + (attempt - 1) + " attempt(s), giving up");
        return;
      }
      appendOnce(attempt);
    };
    const appendOnce = (attempt) => api("GET", "/" + cm, undefined, undefined, (code, body) => {
      if (code === 404) {
        const cmBody = json({
          apiVersion: "v1", kind: "ConfigMap",
          metadata: {
            name: cm, namespace: ns,
            labels: { "app.kubernetes.io/managed-by": "sre-harness-runtime" },
            annotations: {
              "paperclip.t9/owner": "sre-harness",
              "paperclip.t9/note": "operator run history, appended at runtime; do not make chart-owned",
            },
          },
          data: { runs: line + "\n" },
        });
        api("POST", "", cmBody, "application/json", c2 => {
          if (c2 === 409) {
            if (attempt < 3) append(attempt + 1);
            else console.log("[run-record] create lost every race, giving up");
          } else console.log("[run-record] create http " + c2);
        });
      } else if (code === 200) {
        let prev = "";
        let rv = "";
        try {
          const obj = JSON.parse(body);
          prev = (obj.data || {}).runs || "";
          rv = (obj.metadata || {}).resourceVersion || "";
        } catch (e) {}
        // Replace the record of this run in place (heartbeat beats cost zero
        // ring space), then cap retention per component. The old global
        // slice(-20) let monitor traffic (~48 writes/day) evict every other
        // component history within hours: on 2026-11-01 the ring held
        // 20/20 monitor lines with not one remediate record left, healthy or
        // killed. Each component now keeps its own last 20 runs. A beat must
        // never overwrite a final record that won the race a moment earlier.
        const isMine = (l) => {
          try {
            const o = JSON.parse(l);
            return o.component === rec.component && o.startedAt === rec.startedAt;
          } catch (e) { return false; }
        };
        const kept = [];
        let replaced = false;
        for (const l of prev.split("\n")) {
          if (!l.trim()) continue;
          if (isMine(l)) {
            let mineIsFinal = true;
            try { mineIsFinal = JSON.parse(l).running !== true; } catch (e) {}
            if (mode === "running" && mineIsFinal) {
              console.log("[run-record] final record already written; dropping beat");
              return;
            }
            if (!replaced) { kept.push(line); replaced = true; }
            continue;
          }
          kept.push(l);
        }
        if (!replaced) kept.push(line);
        const counts = {};
        const out = [];
        for (let i = kept.length - 1; i >= 0; i--) {
          let comp = "corrupt";
          try { comp = String(JSON.parse(kept[i]).component || "corrupt"); } catch (e) {}
          counts[comp] = (counts[comp] || 0) + 1;
          if (counts[comp] <= 20) out.unshift(kept[i]);
        }
        const runs = out.join("\n") + "\n";
        const patchBody = { data: { runs: runs } };
        if (rv) patchBody.metadata = { resourceVersion: rv };
        api("PATCH", "/" + cm, json(patchBody), "application/merge-patch+json", code2 => {
          console.log("[run-record] patch http " + code2);
          if (code2 === 409 || code2 === 404) {
            if (attempt < 3) append(attempt + 1);
            else console.log("[run-record] patch lost every race, giving up");
          }
        });
      } else {
        console.log("[run-record] get http " + code + ", skipping");
      }
    });
    append(1);
  ' 2>&1 | sed "s/^/[run-record] /" || true
}

# TERM arrives on a deadline kill or an eviction; INT on a manual stop. Report
# and leave with 143, which says the run was cut short, not that it failed.
trap 'DSH_RC=143; kill "$DSH_PID" "$DSH_TAIL" "$DSH_HB" 2>/dev/null; post_partial_evidence; probe_log_readability; record_run 1 "$DSH_PARTIAL"; exit 143' TERM INT

# The first record is written BEFORE the session starts: from that second on,
# the run-log says this run exists, the next monitor sweep can see a live
# remediate/approvals entry, and a broken record path (RBAC, API) surfaces
# while there is still a whole session left to act on it.
probe_log_readability
record_run 0 "session started" running
DSH_DONE=/tmp/dsh-session-done

dsh --profile "$DSH_PROFILE" --from-default-profile headless \
    --patch /config/gpuai.patch.yml --json "$TASK" >"$DSH_LOG" 2>&1 &
DSH_PID=$!
tail -f -n +1 "$DSH_LOG" 2>/dev/null &
DSH_TAIL=$!

# One background loop, two jobs, both rewritten in place rather than written
# at death only. Every deadline kill in this cluster's history (2026-10-30,
# 2026-11-01) left no forensics at all because the only durable write happened
# inside the 60s grace window the kubelet enforces on someone else's clock.
#  - Heartbeat: every DSH_HB_INTERVAL (default 300s) rewrite this run's
#    record with the latest digest. Whatever kills the pod -- missed signal,
#    API down in the dying second, SIGKILL -- the last beat is a truthful
#    snapshot minutes old instead of nothing.
#  - Soft deadline: at DSH_SOFT_LIMIT_SECONDS (each cronjob sets its own
#    activeDeadlineSeconds minus 300) send SIGTERM to ourselves, so the trap's
#    report and record run with minutes of wall clock instead of racing
#    kubelet's grace window, and the k8s deadline should only ever catch a
#    pod that is already being torn down.
(
  while :; do
    sleep "${DSH_HB_INTERVAL:-300}"
    [ -e "$DSH_DONE" ] && exit 0
    ELAPSED=$(( $(date +%s) - DSH_STARTED_AT ))
    if [ -n "${DSH_SOFT_LIMIT_SECONDS:-}" ] && [ "$ELAPSED" -ge "$DSH_SOFT_LIMIT_SECONDS" ]; then
      echo "[watchdog] soft deadline ${DSH_SOFT_LIMIT_SECONDS}s reached at ${ELAPSED}s; reporting and exiting ahead of the k8s deadline"
      kill -TERM $$
      exit 0
    fi
    session_summary
    probe_log_readability
    record_run 0 "${DSH_PARTIAL:-heartbeat}" running
  done
) &
DSH_HB=$!

wait "$DSH_PID"
DSH_RC=$?
: > "$DSH_DONE"
# Session ended on its own terms: disarm, so the caller's own Slack post is
# never doubled by a late signal.
trap - TERM INT
kill "$DSH_HB" "$DSH_TAIL" 2>/dev/null
wait "$DSH_TAIL" 2>/dev/null
DSH_FINAL="$(DSH_RC="$DSH_RC" node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  let final = "";
  const errs = [];
  let tools = 0;
  let turn = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "final") final = e.text || "";
    else if (e.type === "tool_call") tools++;
    else if (e.type === "error") errs.push(e.message || "unknown");
    else if (e.type === "status" && e.phase === "turn_end") turn = JSON.stringify(e.reason || {});
  }
  // On a failed run the cause leads: a model that wrote one opening line and
  // then hit an error used to report only that line (2026-10-29 monitor:
  // "I will run the read-only health sweep now."), hiding why it failed.
  const facts = tools + " tool calls, turn_end " + (turn || "never reached");
  const rc = Number(process.env.DSH_RC || 0);
  const out = rc === 0
    ? (final
      || (errs.length ? "dsh error: " + errs.join("; ") : "")
      || "dsh produced no final answer (" + facts + ")")
    : [errs.length ? "dsh error: " + errs.join("; ") : "no dsh error event captured",
        "(" + facts + ")",
        final ? "last text: " + final : ""].filter(Boolean).join("\n");
  process.stdout.write(String(out).slice(0, 20000));
' "$DSH_LOG")"

# Normal end of session: record before the caller spends the remaining grace on
# its Slack post. rc distinguishes a clean pass from a handled failure.
probe_log_readability
record_run 0 "$DSH_FINAL"
{{- end -}}
