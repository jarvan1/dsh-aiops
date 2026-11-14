{{- define "dsh-aiops-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-aiops-agent.fullname" -}}
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

{{- define "dsh-aiops-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-aiops-agent.labels" -}}
helm.sh/chart: {{ include "dsh-aiops-agent.chart" . }}
{{ include "dsh-aiops-agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "dsh-aiops-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dsh-aiops-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "dsh-aiops-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dsh-aiops-agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "Set serviceAccount.name when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "dsh-aiops-agent.tokenSecretName" -}}
{{- default (printf "%s-token" (include "dsh-aiops-agent.fullname" .)) .Values.token.existingSecret }}
{{- end }}

{{- define "dsh-aiops-agent.clusterRoleName" -}}
{{- default (printf "%s-reader" (include "dsh-aiops-agent.fullname" .)) .Values.rbac.clusterRoleName }}
{{- end }}
