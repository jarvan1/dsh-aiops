---
name: aiops-diag
description: "Diagnose general Alertmanager alerts with the supplied alert-time window, dynamically selected read-only evidence sources, explicit hypothesis tests, and a durable structured incident report. Use for Kubernetes, node, Prometheus target, service, error-rate, latency, storage, and sparsely labelled alerts."
metadata:
  version: "1.3.0"
  owner: "dsh-aiops"
---

# General AIOps alert diagnosis

Follow this workflow for every routed Alertmanager alert. Do not assume that the target is Kubernetes.

## Guardrails

- Use only the read-only AIOps tools. Never create, patch, delete, restart, scale, exec into, or otherwise mutate infrastructure.
- Treat the route event's `diagnosis.anchor` as T0 and its `diagnosis.window` as authoritative. Do not substitute a relative window based on the current time.
- Copy time parameters from `diagnosis.prometheusQueryRange`, `diagnosis.kubernetesEvents`, and `diagnosis.kubernetesLogs` when the corresponding tool is relevant. Add only supported target, query, namespace, Pod, container, or selector fields.
- Separate observations from causal claims. A firing or resolved alert is evidence about an expression, not proof that an incident began, ended, or has a particular root cause.
- Do not invent absent labels, workload ownership, deploy history, SLOs, dependencies, or metric names. Record missing or inaccessible evidence as a limitation.
- A routed turn may contain multiple deliveries for one fingerprint. Account for every route event, use the newest supplied diagnosis window for live queries, and write one coherent current report for the alert round.
- Never call `aiops_incident_feedback` from alert lifecycle state, model confidence, or your own conclusion. It is only for a later, explicit operator confirmation, correction, or rejection.

## Evidence-source selection

Start from the alert payload and select only the relevant branches. More than one branch may apply.

- Always inspect Alertmanager lifecycle and grouping context. Use `alertmanager_alerts` to confirm current state when useful.
- Labels such as `namespace`, `pod`, `container`, `deployment`, `statefulset`, `daemonset`, `workload`, or `node` enable the Kubernetes branch.
- Labels such as `job` or `instance`, or a Prometheus `generatorURL`, enable the Prometheus target branch.
- Labels such as `service`, `app`, `route`, `endpoint`, `cluster`, or `environment` enable the service-metrics branch.
- If labels are sparse, start with Alertmanager context, then use `prometheus_rules` with the exact alert name before declaring the alert under-specified. Pass `generator_url` only when copying the routed alert's value exactly; the Provider accepts only its configured Prometheus graph URL and never fetches that URL.

## Investigation sequence

1. Record the alert name, fingerprint, round, lifecycle status, labels, annotations, T0, and observation window as initial facts.
2. Confirm the current Alertmanager view when it can clarify firing/resolved state, grouping, receiver, or related alerts.
3. Select evidence branches from the labels. State which branches were selected and why; skipped branches are not missing evidence when their identifying labels are absent.
4. For every Prometheus-originated or otherwise non-Kubernetes alert, call `prometheus_rules` with its exact `alertname` and identifying labels. Prefer the returned rule `query`; a safely recovered generator expression is corroborating context, not permission to fetch its URL. Never manufacture PromQL or a metric name.
5. When `job`, `instance`, or a scrape-pool identity is available, call `prometheus_targets` to inspect health, last scrape time, and `lastError`. Use only exact labels from the alert or discovered evidence. Target-down evidence proves scrape failure, not necessarily application failure.
6. If the rule expression or target identity still needs disambiguation, use `prometheus_discovery` over exactly the supplied diagnosis start/end window. Start with concrete metric names recovered from the rule. Label-based selectors must contain a non-empty exact matcher; keep limits small and do not enumerate global metadata.
7. Run `prometheus_query_range` with the supplied `start`, `end`, and `step` only after recovering the exact PromQL or metric identity. Use an instant query at T0 only when a range cannot answer the question.
8. For the Kubernetes branch, read named objects with `kubernetes_get`, or use `kubernetes_list` with exact namespace and selectors to locate related objects. Then collect bounded Events and logs with the supplied absolute time window. Avoid broad cluster-wide discovery when a narrower target is available.
9. Build a short timeline ordered around T0. Give every material fact a stable evidence ID. State at least one candidate hypothesis and the observation that would strengthen or weaken it.
10. Persist the complete current state with `aiops_incident_report`, even when the conclusion is insufficient evidence. Keep `incidentId` stable for later updates. Every hypothesis must reference evidence IDs present in that same report. Recommendations are for human review only and must include risk.

## Scenario checks

- **Prometheus target down:** recover the rule first, inspect exact target health and `lastError`, then query `up` or scrape duration only when named by recovered evidence. Distinguish scrape/network failure from confirmed service failure.
- **Service error rate:** reconstruct the alert expression when available, compare numerator and denominator, and segment only by labels present in evidence. Check traffic volume and scrape gaps before interpreting ratios.
- **Service latency:** inspect the exact histogram, summary, or recording rule, quantile and traffic volume over the range, then compare error and saturation signals. A percentile spike does not identify the slow dependency by itself.
- **CrashLoopBackOff / container restarts:** inspect Pod container states, `lastState.terminated`, exit code/reason, restart count, probes, limits, current and previous logs, and Events. Correlate restart changes near T0.
- **NodeNotReady:** inspect Ready and pressure conditions, transition reason/message, taints, lease or heartbeat facts when visible, node Events, affected workloads, and relevant metrics. Distinguish control-plane observation loss from confirmed node failure.
- **Pending Pod:** inspect Pod conditions, scheduling Events, requests, selectors/affinity, taints/tolerations, quota, and referenced PVC state. Separate unschedulable, image-pull, and volume-attachment paths.
- **Storage capacity or errors:** inspect the named storage target and its metrics. For Kubernetes PVC/PV labels, inspect phase, capacity, class, binding, conditions, and Events. Do not infer filesystem exhaustion from allocated capacity alone.
- **Replica mismatch:** compare desired, current, updated, available, and unavailable replicas; inspect rollout conditions, child objects, Pods, and Events. Test rollout, scheduling, readiness, and intentional-scaling explanations.
- **Sparse-label alert:** use rule lookup before reporting the alert as under-specified. Report the lifecycle, candidate rule expression, and target context actually available. Ask for the smallest missing identifier or datasource needed for a deeper pass; do not silently reinterpret it as a Kubernetes alert.

## Report quality gate

Before finishing, ensure the report includes the T0/window fact, alert identity, selected evidence branches, all available relevant evidence, and explicit gaps. Every causal statement must be a hypothesis with cited evidence, confidence must be calibrated, and no recommended action may be presented as already executed. Kubernetes state, Events, and logs are required only when the alert identifies a Kubernetes target.
