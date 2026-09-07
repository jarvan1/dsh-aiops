# @deepseek-ai/dsh-aiops-incident-router

English | [中文](README.zh.md)

Durable Alertmanager fingerprint routing for DSH AIOps. The service registers one trusted `alertmanager` webhook rule, applies an exact alertname allowlist and severity mapping, serializes routing decisions in SQLite, and drives deterministic diagnostic Session identities.

## Lifecycle

- The first accepted firing alert creates round 1.
- A later firing notification appends to the same Session.
- A resolved notification appends to that Session and marks the alert expression recovered; it does not close the AIOps incident automatically.
- A firing notification after resolution creates the next round and a new Session.
- An exact delivery retry is idempotent. Reusing a supplied delivery id with different authenticated bytes fails.
- Concurrent first notifications coalesce on one deterministic Session, while SQLite `BEGIN IMMEDIATE` serializes fingerprint state changes.
- Pending notifications with the same fingerprint and lifecycle status are grouped into one model turn; status changes retain order.
- After process restart, processing work returns to the queue and the same SQLite mapping resumes the persisted Session before the next append.

Every policy-eligible alert is persisted before an Agent is created. The router uses fingerprint cooldown, global/severity concurrency, global/severity token reservations, and queue capacity to start, defer, or drop it. Critical work has priority and equal severity remains FIFO. Every filtered, grouped, deferred, dropped, started, completed, or failed transition is audited. Every ultimately accepted decision is written as an ignorable `aiops/alert-routed` v2 Session event before its model-visible follow-up. The event projects `alert.startsAt` into a canonical T0, a bounded window, and exact `prometheus_query_range`, `kubernetes_events`, and `kubernetes_logs` time arguments. Session JSONL remains diagnostic truth; the router database owns delivery replay, queue/audit facts, and fingerprint-to-round coordination only.

## Configuration

`source` selects one adapter instance. `statePath` and `workspacePath` must be absolute (`:memory:` is test-only for state). `agentPreset` and `permissionPreset` control Session composition. `alertnameAllowlist` must be non-empty. `severityMap` maps provider labels to `info`, `warning`, or `critical`; unmapped values are filtered. `modelBudgets` supplies the maximum output tokens per severity.

`stormControl` configures fingerprint cooldown, queue size/age, failed-dispatch attempts/backoff, global and per-severity concurrency, and global and per-severity in-flight model-token reservations. Each model budget must fit its reservation caps, and per-severity concurrency cannot exceed the global cap. `diagnosisWindow` sets pre/post-anchor seconds, Prometheus resolution seconds, and the bounded Pod-log line cap placed in each route event.

See the [routing decision](../../docs/decisions/2026-09-06-alertmanager-session-routing.md) for database ownership and restart semantics, and the [Stage E decision](../../docs/decisions/2026-09-06-operator-feedback-storm-control.md) for storm-control and feedback boundaries.
