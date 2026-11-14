# AIOps

English | [中文](aiops.zh.md)

The DSH AIOps subsystem is an Alertmanager-driven, read-only investigation, operator-feedback, and history loop over current alerts, Prometheus metrics, Kubernetes objects and Events, bounded Pod logs, and durable incident records. It adds authenticated webhook ingress, storm-controlled persistent fingerprint routing, one packaged diagnostic skill, three swappable observation capabilities, fourteen model tools, plugin-owned durable incident/feedback/delivery storage, IM push of completed diagnoses, and a dedicated Portal inside DSH Web without changing `agent-loop`. Session logs remain the diagnostic narrative; two plugin-owned storage domains (`aiops_incident`, `aiops_delivery`) hold structured incident state and delivery decisions; SQLite stores routing coordination/audit, while RAG remains outside this version.

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
              aiops_incident storage domain
                (one durable report per Session)
                  /        |            \
   aiopsIncidents/     history tools   aiops-delivery
     changed event        |            subscription
        |                 |                 |
 explicit operator verdict |        bounded IM webhook POST
   aiops_incident_feedback |                 |
        |                 |         aiops_delivery domain marker
 aiops_incident            |                 |
   storage domain         |                 |
                  \        |                /
              same-origin Portal snapshot
                           |
      overview / detail / route audit / routing-policy dry-run
```

Observation tools return bounded canonical JSON or exact bounded log text and never accept mutation verbs, URLs, shell strings, unrestricted kubectl arguments, or streaming modes. The agent converts relevant observations into evidence records, references those IDs from hypotheses, assigns explicit confidence, and stores proposed actions only as human-reviewable recommendations.

## Alert routing

The Alertmanager adapter accepts only authenticated, bounded v4 JSON. It validates supplied fingerprints or derives one from sorted labels. The router accepts every alert name by default and filters only exact names configured as known noise. Severity labels are normalized through a case-insensitive map; missing or unknown values use the configured default severity instead of being discarded. An exact delivery retry is idempotent, and reuse of a sender-supplied delivery id with different authenticated bytes fails.

SQLite maps `(source, fingerprint)` to the current alert round and deterministic Session ID. Policy-eligible alerts enter a durable queue before Agent creation. Ready items with the same fingerprint/status are grouped and constrained by fingerprint cooldown, queue age/capacity, global/per-severity concurrency, and in-flight token reservations. Critical work has priority, equal severity remains FIFO, and restart recovers processing work. Every filtered, deferred, grouped, dropped, started, completed, and failed transition is audited.

The versioned `aiops-routing` settings surface can change exclusions, severity normalization/defaults, cooldown, queue/retry, concurrency, and token budgets without restart. Portal requires a successful side-effect-free labels dry-run before one revision-fenced atomic save; the router validates cross-field limits, applies the commit live, and stores before/after hashes plus changed fields in durable policy audit.

The first firing creates round 1; repeated firing and resolved notifications append to the same Session; firing after resolution opens a new round. `resolved` means only that the alert expression recovered. Every accepted decision and normalized alert is appended as `aiops/alert-routed` v2 before the model-visible follow-up. The event canonicalizes `startsAt` as T0 and contains one replay-stable window plus exact Prometheus range, Kubernetes Event, and Pod-log parameters.

After a recovery turn settles, the router closes the lifecycle deterministically instead of trusting the model to do it: it reads the Session's latest stored incident record and, unless the incident is already resolved, reports the carried-forward state with status `resolved` plus one `alert-recovery-<receivedAt>` evidence entry citing the alert name and recovery time. The write is idempotent — an already-resolved incident is untouched — and the recovery prompt explicitly tells the model not to close the lifecycle itself. A crash between the settled turn and this write leaves the incident active; the next firing alert then opens a new round as usual.

When a firing alert opens a new round (`created` or `reopened`), the router also performs best-effort diagnosis reuse: it scans this workspace's bounded resolved incidents in the incident store (new `history.maxScanRecords`/`history.maxIncidents` entry settings, defaults 200/3), picks the latest whose report text mentions an identity token of the alert fingerprint (full value or stable suffix), and attaches its top hypotheses and recommendations to the first-turn prompt as explicitly non-authoritative leads to confirm or discard against fresh evidence. Reuse is skipped silently when the incident store is absent or a read fails, never runs for appended or recovery rounds, and adds no writes — the model still starts from a fresh report.

## Capability roles

| Capability | Service Definition and Provider | Consumer |
|---|---|---|
| Alert delivery | [`dsh-webhook-alertmanager`](../packages/webhook-alertmanager/README.md), isolated HTTP listener, `ctx.webhookRuntime` | [`dsh-aiops-incident-router`](../packages/incident-router/README.md), `ctx.aiopsIncidentRouter` |
| Alertmanager alerts | [`dsh-aiops-alertmanager`](../packages/aiops-alertmanager/README.md), `ctx.alertmanager`, HTTP API v2 | `alertmanager_alerts` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Prometheus observation | [`dsh-aiops-prometheus`](../packages/aiops-prometheus/README.md), `ctx.prometheus`, bounded HTTP query/discovery APIs | `prometheus_query`, `prometheus_query_range`, `prometheus_rules`, `prometheus_targets`, `prometheus_discovery` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Kubernetes read | [`dsh-aiops-kubernetes`](../packages/aiops-kubernetes/README.md), `ctx.kubernetes`, official native API client (optional kubectl compatibility subpath) | `kubernetes_get`, `kubernetes_list`, `kubernetes_events`, `kubernetes_logs` in [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.md) |
| Diagnostic workflow | Packaged [`dsh-aiops-skill-k8s-diag`](../packages/skill-k8s-diag/README.md), registered globally | `aiops-diag` dynamically selects Alertmanager, Prometheus, service, and Kubernetes evidence branches |
| Operations Portal | [`dsh-aiops-portal`](../packages/aiops-portal/README.md), fixed same-origin `/api/aiops/portal` | Persistent DSH Web sidebar action, Session view, live data-source/routing settings, and dry-run |
| Product observability | [`dsh-aiops-observability`](../packages/aiops-observability/README.md), `ctx.aiopsTelemetry` | `/api/aiops/healthz`, `/api/aiops/readyz`, and low-cardinality `/api/aiops/metrics` |

Each capability combines its Service Definition and current Provider in one package because they currently evolve as one concern. A second transport or remote execution provider is the trigger to split Provider packages; the Consumer already depends only on the abstract Service.

## Incident state

Structured incident state lives in the plugin-owned `aiops_incident` storage domain (the `ctx.aiopsIncidents` service), not in Session events: DSH 0.2.x reserves `session.append` plugin records for Host-built packages, so an external plugin cannot portably write them. The domain uses the per-record JSON layout at `<DSH_HOME>/storages/aiops_incident/`, one zod-validated document per Session for the latest complete `AiopsIncidentState` (version, stable incident ID, title, severity, status, complete evidence, hypotheses, recommendations) plus an append-only feedback table. Every report replaces the previous one and increments `revision`; the store validates lifecycle continuity (first report cannot be `resolved`; identity is stable; resolved is terminal) and the Session's workspace is fixed at the first report.

Two writers report incident state: the model through `aiops_incident_report`, and the incident router through the deterministic resolved transition after an Alertmanager recovery turn; both go through the same store, schema, and lifecycle validation. Only after the current user explicitly confirms, corrects, or rejects a diagnosis may the Agent append operator feedback; feedback has a deterministic ID, `incidentId`, reviewed `reportRevision`, verdict, and note, is idempotent per feedback ID, and a replacement report invalidates feedback pinned to an older revision. Corrections carry replacement wording and never rewrite the report. The Session log keeps the full diagnostic narrative (routed alerts, observations, model messages, tool calls); the store owns the structured state that history tools, the Portal, delivery, and reuse consume.

## Diagnosis delivery

`aiops-delivery` subscribes to the `aiopsIncidents/changed` event and pushes each qualifying report to one IM incoming webhook — Feishu interactive cards, DingTalk markdown, or Slack text. The webhook URL lives behind a credential reference (`webhookUrlEnv`) so it never enters the patch or settings store, and it must be a clean https URL. Reports below `minSeverity` are skipped until severity escalates; a delivered marker in the `aiops_delivery` domain prevents any later re-push for the same Session — including after a restart — while a failed burst overwrites the marker with the bounded failure reason so a later report retries. Delivery is informational only: it adds one auditable record per decision and never changes infrastructure.

## Persistence, database, and RAG

The subsystem keeps three kinds of durable state. DSH Session persistence (JSONL under `~/.dsh/sessions`) holds the diagnostic narrative: routed alerts, model-visible messages, and tool observations. The plugin-owned storage domains under `<DSH_HOME>/storages/` hold the structured state: `aiops_incident` (incident reports and operator feedback) and `aiops_delivery` (terminal delivery decisions); both are schema-validated at the durable boundary, and an unreadable record is backed up and skipped rather than blocking startup. `aiops-router.sqlite` owns delivery replay, queue, storm-control and routing-policy audit, and fingerprint-to-round coordination. The bundle enables `dsh-session-query-sqlite` at `aiops-incidents.sqlite`; `dsh-tool-aiops-history` scopes tool reads to the caller workspace through the incident store. The Portal adds no database: its endpoint is fixed to the router-configured diagnosis workspace and bounds all incident and audit scans.

RAG is deferred because the loop diagnoses from live operational state and there is no validated runbook corpus yet. Add retrieval only when a maintained corpus, access policy, citations, freshness rules, and evaluation set exist; retrieval should contribute evidence or operator guidance, never bypass read-only tool and approval policy.

## Safety boundary

The package set contains no Alertmanager write, Kubernetes mutation, exec, arbitrary command, streaming log follow, remediation, or approval-bypass path. The Portal never returns the webhook bearer value; it exposes only URL and configured status, and its connection-test/dry-run POSTs reject cross-site browser requests. Deployment still owns the authenticated DSH Host boundary, TLS and reverse-proxy headers, network ACLs, Alertmanager/Prometheus access, kubeconfig selection, credential rotation, and read-only Kubernetes RBAC. See [production deployment and upgrade](deployment.md).

## Current limits

- Alerts: authenticated Alertmanager v4 ingress and current-alert reads; no silences or mutation APIs.
- Metrics: bounded PromQL instant/range queries plus rule, target, label, and series discovery; no Prometheus writes or unrestricted metadata scans.
- Cluster: object get/list, absolute-window Events, and bounded absolute-window non-streaming Pod logs only; no watch, discovery, exec, or topology graph.
- State: one incident per alert round; firing after expression recovery opens a new Session round. Feedback is explicitly appended and does not train the model online. Cross-Session history is read-only and workspace-scoped, with no merge, aggregate analytics, or ticket-system synchronization.
- Experience: the Web profile includes an always-available AIOps Portal, live persistent data-source settings, and revision-fenced routing-policy management; incidents remain read-only, and Electron plus in-Portal feedback/remediation are not supported yet.
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
- [Production deployment and upgrade](deployment.md) — Host/TLS boundary, credential rotation, migration, and release procedure.
- [Repeatable Alertmanager/k3s matrix](../deploy/alertmanager/README.md) — guarded real receiver and restart workflow.
