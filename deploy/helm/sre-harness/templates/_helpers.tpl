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
