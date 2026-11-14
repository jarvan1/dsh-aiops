{{/* Expand the chart name. */}}
{{- define "dsh-aiops.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified release name. */}}
{{- define "dsh-aiops.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "dsh-aiops.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-aiops.labels" -}}
helm.sh/chart: {{ include "dsh-aiops.chart" . }}
{{ include "dsh-aiops.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "dsh-aiops.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dsh-aiops.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Secret holding the Alertmanager webhook bearer value. */}}
{{- define "dsh-aiops.credentialsSecretName" -}}
{{- default (printf "%s-credentials" (include "dsh-aiops.fullname" .)) .Values.credentials.existingSecret }}
{{- end }}

{{/* PVC name used by the server. */}}
{{- define "dsh-aiops.dataClaimName" -}}
{{- default (include "dsh-aiops.fullname" .) .Values.persistence.existingClaim }}
{{- end }}

{{/*
Authorities DSH accepts. The Service DNS name is always included because an
in-cluster agent dials it; the public origin's host is added when set.
*/}}
{{- define "dsh-aiops.trustedHosts" -}}
{{- $hosts := list -}}
{{- $service := printf "%s.%s.svc.cluster.local:%v" (include "dsh-aiops.fullname" .) .Release.Namespace .Values.service.webPort -}}
{{- $hosts = append $hosts $service -}}
{{- if .Values.dsh.publicUrl -}}
{{- $hosts = append $hosts (urlParse .Values.dsh.publicUrl).host -}}
{{- end -}}
{{- range .Values.dsh.trustedHosts -}}
{{- $hosts = append $hosts . -}}
{{- end -}}
{{- join " " (uniq $hosts) -}}
{{- end }}
