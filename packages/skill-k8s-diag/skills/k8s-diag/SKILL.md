---
name: k8s-diag
description: "Diagnose routed Kubernetes and service alerts with the supplied alert-time window, read-only evidence tools, explicit hypothesis tests, and a durable structured incident report. Use for CrashLoopBackOff, NodeNotReady, Pending Pods, PVC, replica mismatch, error-rate, and latency alerts."
metadata:
  version: "1.1.0"
  owner: "dsh-aiops"
---

# Kubernetes alert diagnosis

Follow this workflow for every routed alert.

## Guardrails

- Use only the read-only AIOps tools. Never create, patch, delete, restart, scale, exec into, or otherwise mutate infrastructure.
- Treat the route event's `diagnosis.anchor` as T0 and its `diagnosis.window` as authoritative. Do not substitute a relative window based on the current time.
- Copy tool parameters from `diagnosis.prometheusQueryRange`, `diagnosis.kubernetesEvents`, and `diagnosis.kubernetesLogs`. Add only the query, namespace, Pod, container, or selector fields required by that tool.
- Separate observations from causal claims. A firing or resolved alert is evidence about an expression, not proof that an incident began, ended, or has a particular root cause.
- Do not invent absent labels, workload ownership, deploy history, SLOs, or metric names. Record missing or inaccessible evidence as a limitation.
- A routed turn may contain multiple deliveries for one fingerprint. Account for every route event, use the newest supplied diagnosis window for live queries, and write one coherent current report for the alert round.
- Never call `aiops_incident_feedback` from alert lifecycle state, model confidence, or your own conclusion. It is only for a later, explicit operator confirmation, correction, or rejection.

## Investigation sequence

1. Record the alert, fingerprint, round, lifecycle status, namespace/workload labels, T0, and observation window as initial facts.
2. Identify the target from supplied labels. Read the named workload or node with `kubernetes_get`; use `kubernetes_list` with exact selectors to locate owned Pods and related objects. Avoid broad cluster-wide lists when a namespace or selector is available.
3. Read `kubernetes_events` with the exact absolute `since_time` and `until_time` from the route. Prefer `involvedObject.name=<name>` and a namespace when known.
4. For relevant Pods and containers, read bounded `kubernetes_logs` with the supplied absolute window, tail limit, and timestamps. For restarts, inspect both current and `previous: true` logs when a previous container exists.
5. Use `prometheus_query_range` with the supplied `start`, `end`, and `step`. Choose PromQL from alert annotations or deployment conventions; use an instant query at T0 only when a range cannot answer the question.
6. Build a short timeline ordered around T0. Give every material fact a stable evidence ID. State at least one candidate hypothesis and the observation that would strengthen or weaken it.
7. Persist the complete current state with `aiops_incident_report`, even when the conclusion is insufficient evidence. Keep `incidentId` stable for later updates. Every hypothesis must reference evidence IDs present in that same report. Recommendations are for human review only and must include risk.

## Scenario checks

- **CrashLoopBackOff / container restarts:** inspect Pod container states, `lastState.terminated`, exit code/reason, restart count, probes, limits, current and previous logs, and Events. Correlate restart changes near T0; do not call an application log line the cause without matching lifecycle evidence.
- **NodeNotReady:** inspect Node Ready condition transition time/reason/message, pressure conditions, taints, lease/heartbeat facts if visible, node Events, affected Pods, and node/workload metrics around T0. Distinguish control-plane observation loss from confirmed node failure.
- **Pending Pod:** inspect Pod conditions, scheduling Events, requests, node selectors/affinity, taints/tolerations, quota, and referenced PVC state. Separate unschedulable, image-pull, and volume-attachment paths.
- **PVC capacity or errors:** inspect PVC and PV phase, capacity, storage class, binding, conditions and Events. Correlate filesystem/volume metrics where available; avoid assuming filesystem exhaustion from PVC allocation alone.
- **Replica mismatch:** compare desired, current, updated, available and unavailable replicas; inspect rollout conditions, ReplicaSets/Pods and Events. Test whether the mismatch is rollout progress, scheduling failure, readiness failure, or intentional scaling.
- **High error rate:** reconstruct the alert PromQL when available, compare numerator and denominator over the exact range, segment by service/status/route only when labels support it, and correlate with workload state and logs. Small denominators and scrape gaps can mislead ratios.
- **High latency:** inspect the exact histogram/summary or recording rule, quantile and traffic volume over the range, compare error/saturation signals, and correlate with workload state. A percentile spike does not by itself identify the slow dependency.

## Report quality gate

Before finishing, ensure the report includes the T0/window fact, target identity, Kubernetes state, Events, logs and metrics that were available; every causal statement is a hypothesis with cited evidence; confidence is calibrated; gaps are explicit; and no recommended action is presented as already executed.
