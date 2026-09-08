# AIOps

English | [中文](aiops.zh.md)

The DSH AIOps subsystem is an Alertmanager-driven, read-only investigation, operator-feedback, and history loop over current alerts, Prometheus metrics, Kubernetes objects and Events, bounded Pod logs, and durable incident records. It adds authenticated webhook ingress, storm-controlled persistent fingerprint routing, one packaged diagnostic skill, three swappable observation capabilities, fourteen model tools, durable route/incident/feedback events, and a dedicated Portal inside DSH Web without changing `agent-loop`. Session logs remain diagnostic truth; SQLite stores routing coordination/audit and a separately rebuildable cross-Session search index, while RAG remains outside this version.

## Runtime flow

```text
Alertmanager POST /alertmanager
             -> bearer authentication + bounded v4 normalization
             -> ctx.webhookRuntime
             -> durable queue / fingerprint grouping / cooldown / resource budgets
             -> fingerprint / alert-round router
             -> startsAt anchor + bounded absolute query window
             -> deterministic diagnostic Session
             -> load aiops-diag
                              |
alertmanager_alerts -> ctx.alertmanager -> Alertmanager HTTP API v2
prometheus_query*   -> ctx.prometheus   -> Prometheus HTTP API
kubernetes_*        -> ctx.kubernetes   -> native kubeconfig client -> Kubernetes API
             evidence + hypotheses + recommendations
                              |
                 aiops_incident_report
                              |
                aiops/incident-state
                              |
       explicit operator verdict -> aiops_incident_feedback
                              |
                 aiops/operator-feedback
                       /             \
          Session persistence   aiopsIncident projection
                    |
       disposable SQLite session-query index
                    |
 incident history / feedback history / routing audit
                    |
       same-origin read-only Portal snapshot
                    |
       overview / filters / detail / route audit
```

Observation tools return bounded canonical JSON or exact bounded log text and never accept mutation verbs, URLs, shell strings, unrestricted kubectl arguments, or streaming modes. The agent converts relevant observations into evidence records, references those IDs from hypotheses, assigns explicit confidence, and stores proposed actions only as human-reviewable recommendations.

## Alert routing

The Alertmanager adapter accepts only authenticated, bounded v4 JSON. It validates supplied fingerprints or derives one from sorted labels. The router accepts every alert name by default and filters only exact names configured as known noise. Severity labels are normalized through a case-insensitive map; missing or unknown values use the configured default severity instead of being discarded. An exact delivery retry is idempotent, and reuse of a sender-supplied delivery id with different authenticated bytes fails.

SQLite maps `(source, fingerprint)` to the current alert round and deterministic Session ID. Policy-eligible alerts enter a durable queue before Agent creation. Ready items with the same fingerprint/status are grouped and constrained by fingerprint cooldown, queue age/capacity, global/per-severity concurrency, and in-flight token reservations. Critical work has priority, equal severity remains FIFO, and restart recovers processing work. Every filtered, deferred, grouped, dropped, started, completed, and failed transition is audited.

The first firing creates round 1; repeated firing and resolved notifications append to the same Session; firing after resolution opens a new round. `resolved` means only that the alert expression recovered. Every accepted decision and normalized alert is appended as `aiops/alert-routed` v2 before the model-visible follow-up. The event canonicalizes `startsAt` as T0 and contains one replay-stable window plus exact Prometheus range, Kubernetes Event, and Pod-log parameters.

## Capability roles

| Capability | Service Definition and Provider | Consumer |
|---|---|---|
| Alert delivery | [`dsh-webhook-alertmanager`](../packages/webhook-alertmanager/README.md), isolated HTTP listener, `ctx.webhookRuntime` | [`dsh-aiops-incident-router`](../packages/incident-router/README.md), `ctx.aiopsIncidentRouter` |
| Alertmanager alerts | [`dsh-aiops-alertmanager`](../packages/aiops-alertmanager/README.md), `ctx.alertmanager`, HTTP API v2 | `alertmanager_alerts` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Prometheus query | [`dsh-aiops-prometheus`](../packages/aiops-prometheus/README.md), `ctx.prometheus`, HTTP query API | `prometheus_query`, `prometheus_query_range` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Kubernetes read | [`dsh-aiops-kubernetes`](../packages/aiops-kubernetes/README.md), `ctx.kubernetes`, official native API client (optional kubectl compatibility subpath) | `kubernetes_get`, `kubernetes_list`, `kubernetes_events`, `kubernetes_logs` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Diagnostic workflow | Packaged [`dsh-aiops-skill-k8s-diag`](../packages/skill-k8s-diag/README.md), registered globally | `aiops-diag` dynamically selects Alertmanager, Prometheus, service, and Kubernetes evidence branches |
| Operations Portal | [`dsh-aiops-portal`](../packages/aiops-portal/README.md), fixed same-origin `/api/aiops/portal` | Persistent DSH Web sidebar action, Session view, and live data-source settings |

Each capability combines its Service Definition and current Provider in one package because they currently evolve as one concern. A second transport or remote execution provider is the trigger to split Provider packages; the Consumer already depends only on the abstract Service.

## Incident state

Every `aiops/incident-state` event contains the complete current `AiopsIncidentState`: version, stable incident ID, title, severity, status, complete evidence, hypotheses, and recommendations. Only after the current user explicitly confirms, corrects, or rejects a diagnosis may the Agent append `aiops/operator-feedback`. Feedback has a deterministic ID, `incidentId`, reviewed `reportSeq`, verdict, and note; corrections also carry replacement wording and never rewrite the report. Both write paths checkpoint Session persistence before and after append.

The `aiopsIncident` projection is last-valid-write-wins and validates both restored cache values and each replayed incident event. There is no separate invariant companion because there is no second authoritative observation: the projection decodes the event that is itself the durable source, while the tool checks lifecycle continuity before committing the next event.

## Persistence, database, and RAG

The subsystem reuses DSH Session persistence for diagnostic truth. JSONL stores routed alerts, model-visible messages, tool observations, incident state, and operator feedback; `ctx.sessionProjections` supplies current state. `aiops-router.sqlite` owns delivery replay, queue and storm-control audit, and fingerprint-to-round coordination. The bundle enables `dsh-session-query-sqlite` at `aiops-incidents.sqlite`; `dsh-tool-aiops-history` scopes tool reads to the caller workspace. The Portal adds no database: its endpoint is fixed to the router-configured diagnosis workspace and bounds all session, incident, and audit scans.

RAG is deferred because the loop diagnoses from live operational state and there is no validated runbook corpus yet. Add retrieval only when a maintained corpus, access policy, citations, freshness rules, and evaluation set exist; retrieval should contribute evidence or operator guidance, never bypass read-only tool and approval policy.

## Safety boundary

The package set contains no Alertmanager write, Kubernetes mutation, exec, arbitrary command, streaming log follow, remediation, or approval-bypass path. Deployment still owns network ACLs, Alertmanager and Prometheus access, kubeconfig selection, and read-only Kubernetes RBAC. Provider configuration is trusted application composition, while model inputs are constrained and validated before I/O.

## Current limits

- Alerts: authenticated Alertmanager v4 ingress and current-alert reads; no silences or mutation APIs.
- Metrics: PromQL instant and range query only; no rule or metadata APIs.
- Cluster: object get/list, absolute-window Events, and bounded absolute-window non-streaming Pod logs only; no watch, discovery, exec, or topology graph.
- State: one incident per alert round; firing after expression recovery opens a new Session round. Feedback is explicitly appended and does not train the model online. Cross-Session history is read-only and workspace-scoped, with no merge, aggregate analytics, or ticket-system synchronization.
- Experience: the Web profile includes an always-available read-only AIOps Portal and live persistent Prometheus/Alertmanager settings; Electron and in-Portal feedback/remediation are not supported yet.
- Action: recommendations are text for human review; no automated remediation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

The API excerpts below mirror the package source and must change with its public declarations. Framework-inherited `ctx` behavior follows the [DSH Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md).

<a id="ctxalertmanager--alertmanagerruntime-abstract-seam"></a>

### `ctx.alertmanager` — `AlertmanagerRuntime` (abstract seam)

Provider-neutral read-only Alertmanager runtime.

```ts cordis-catalog
/**
 * Apply Provider-owned defaults and limits to a current-alert request.
 * @param request - optional alert state, label, and receiver filters.
 * @returns fully specified query for {@link alerts}.
 */
abstract resolveAlerts(request: AlertmanagerAlertsRequest): AlertmanagerAlertsSpec

/**
 * Read current alerts from Alertmanager API v2.
 * @param spec - fully resolved query from {@link resolveAlerts}.
 * @param signal - caller cancellation.
 * @returns detached current alert objects.
 */
abstract alerts(spec: AlertmanagerAlertsSpec, signal?: AbortSignal): Promise<AlertmanagerAlertsResult>
```

Source: [`packages/aiops-alertmanager/src/index.ts`](../packages/aiops-alertmanager/src/index.ts)

<a id="ctxkubernetes--kubernetesruntime-abstract-seam"></a>

### `ctx.kubernetes` — `KubernetesRuntime` (abstract seam)

Provider-neutral read-only Kubernetes runtime.

```ts cordis-catalog
/**
 * Read one named Kubernetes object.
 * @param request - target resource, object name, namespace, and execution directory.
 * @param signal - caller cancellation.
 * @returns Kubernetes API object as lossless JSON.
 */
abstract get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * List Kubernetes objects.
 * @param request - target resource, namespace, selectors, and execution directory.
 * @param signal - caller cancellation.
 * @returns Kubernetes API list as lossless JSON.
 */
abstract list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * List Kubernetes Event objects in chronological order.
 * @param request - namespace and optional server-side selectors.
 * @param signal - caller cancellation.
 * @returns Kubernetes EventList as lossless JSON.
 */
abstract events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * Apply Provider-owned defaults and caps to a Pod-log request.
 * @param request - Pod, optional container, time window, and requested line count.
 * @returns a fully specified bounded log request for {@link logs}.
 */
abstract resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec

/**
 * Read one bounded non-streaming Pod-log snapshot.
 * @param spec - fully resolved request from {@link resolveLogs}.
 * @param signal - caller cancellation.
 * @returns bounded Pod log text from the selected Provider.
 */
abstract logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult>

/** Validate kubeconfig/API connectivity and the diagnosis read permissions. */
abstract testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult>
```

Source: [`packages/aiops-kubernetes/src/index.ts`](../packages/aiops-kubernetes/src/index.ts)

<a id="ctxprometheus--prometheusruntime-abstract-seam"></a>

### `ctx.prometheus` — `PrometheusRuntime` (abstract seam)

Provider-neutral read-only Prometheus runtime.

```ts cordis-catalog
/**
 * Evaluate one PromQL expression at one instant.
 * @param request - expression and optional evaluation time.
 * @param signal - caller cancellation.
 * @returns normalized successful query data.
 */
abstract query(request: PrometheusInstantQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>

/**
 * Evaluate one PromQL expression over a time range.
 * @param request - expression, range, and resolution.
 * @param signal - caller cancellation.
 * @returns normalized successful query data.
 */
abstract queryRange(request: PrometheusRangeQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>
```

Source: [`packages/aiops-prometheus/src/index.ts`](../packages/aiops-prometheus/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Related documentation

- [AIOps package map](../packages/README.md) — direct package ownership.
- [DSH Session subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md) — durable event and persistence semantics.
- [DSH Session projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.md) — current-state fold and cache behavior.
- [AIOps foundation decision](decisions/2026-09-04-dsh-aiops-read-only-foundation.md) — accepted alternatives and split triggers.
- [Alertmanager Session routing decision](decisions/2026-09-06-alertmanager-session-routing.md) — replay, round, and restart semantics.
- [Time-anchored diagnosis decision](decisions/2026-09-06-time-anchored-diagnosis.md) — T0/window derivation, bounded Kubernetes reads, and packaged skill availability.
- [Feedback and alert-storm decision](decisions/2026-09-06-operator-feedback-storm-control.md) — append-only review, queue, resource budgets, and audit semantics.
- [AIOps Portal decision](decisions/2026-09-06-aiops-portal.md) — same-origin endpoint, workspace scope, and read-only UI boundary.
