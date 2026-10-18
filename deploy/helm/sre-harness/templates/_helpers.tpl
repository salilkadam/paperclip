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
# vars into ~/.ssh. required:false fallbacks so components without SSH work
# still run when the Vault properties are absent.
if [ -n "${GPU_SSH_KEY:-}" ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  printf '%s\n' "$GPU_SSH_KEY" > "$HOME/.ssh/id_ed25519" && chmod 600 "$HOME/.ssh/id_ed25519"
  printf '%s\n' "${GPU_KNOWN_HOSTS:-}" > "$HOME/.ssh/known_hosts" && chmod 644 "$HOME/.ssh/known_hosts"
  export GPU_SSH_USER="${GPU_SSH_USER:-dshci}"
  export GPU_SSH_PORT="${GPU_SSH_PORT:-22}"
fi
{{- end -}}
