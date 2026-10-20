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

# Evidence must outlive the pod. On a deadline kill the Job controller deletes
# the pod in the same second, so `kubectl logs` is unreadable afterwards and
# the run reports nothing at all. The SIGTERM grace window is the last chance
# to say anything, so report how far the session got before we exit.
post_partial_evidence() {
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
  post_to_slack "RUN TERMINATED BEFORE COMPLETION ($DSH_PROFILE, SIGTERM): ${DSH_PARTIAL:-no session events captured}"
}

# TERM arrives on a deadline kill or an eviction; INT on a manual stop. Report
# and leave with 143, which says the run was cut short, not that it failed.
trap 'DSH_RC=143; kill "$DSH_PID" "$DSH_TAIL" 2>/dev/null; post_partial_evidence; exit 143' TERM INT

dsh --profile "$DSH_PROFILE" --from-default-profile headless \
    --patch /config/gpuai.patch.yml --json "$TASK" >"$DSH_LOG" 2>&1 &
DSH_PID=$!
tail -f -n +1 "$DSH_LOG" 2>/dev/null &
DSH_TAIL=$!
wait "$DSH_PID"
DSH_RC=$?
# Session ended on its own terms: disarm, so the caller's own Slack post is
# never doubled by a late signal.
trap - TERM INT
kill "$DSH_TAIL" 2>/dev/null
wait "$DSH_TAIL" 2>/dev/null
DSH_FINAL="$(node -e '
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
  const out = final
    || (errs.length ? "dsh error: " + errs.join("; ") : "")
    || "dsh produced no final answer (" + tools + " tool calls, turn_end " + (turn || "never reached") + ")";
  process.stdout.write(String(out).slice(0, 20000));
' "$DSH_LOG")"
{{- end -}}
