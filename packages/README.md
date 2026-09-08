---
description: "The AIOps package group: authenticated alert ingress, durable routing, read-only observation, incident state, and history search."
kind: "package-group"
---

# aiops/ — read-only operations investigation

English | [中文](README.zh.md)

## Summary

The `aiops/` group accepts authenticated Alertmanager notifications; routes stable fingerprints through a durable queue, grouping, cooldown, and resource budgets into diagnostic Session rounds; lets each Agent collect bounded evidence and persist structured reports; appends operator verdicts; and queries or displays reports, feedback, and routing audit in a Portal. The family is read-only and does not contain remediation or RAG.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Thirteen packages cover ingress, routing, acquisition, model interaction, a packaged diagnostic skill, durable state, history reads, product telemetry, the Portal, and composition.

| Package | Role | ctx key or contribution |
|---|---|---|
| [`aiops-http-read/`](aiops-http-read/README.md) | Shared bounded read-only HTTP acquisition | Stateless library |
| [`aiops-alertmanager/`](aiops-alertmanager/README.md) | Read-only current-alert Service Definition and HTTP Provider | `ctx.alertmanager` |
| [`aiops-prometheus/`](aiops-prometheus/README.md) | Read-only PromQL, rule, target, and metadata Service Definition and HTTP Provider | `ctx.prometheus` |
| [`aiops-kubernetes/`](aiops-kubernetes/README.md) | Read-only native Kubernetes API Provider with optional kubectl compatibility | `ctx.kubernetes` |
| [`tool-aiops-observe/`](tool-aiops-observe/README.md) | Ten model-facing observation tools | `ctx.tools` |
| [`aiops-incident/`](aiops-incident/README.md) | Complete reports, append-only feedback, projections, and write tools | `aiops/incident-state`, `aiops/operator-feedback` |
| [`tool-aiops-history/`](tool-aiops-history/README.md) | Workspace-scoped report, feedback, and routing-audit tools | `ctx.tools` over `ctx.sessionQuery` and router |
| [`aiops-portal/`](aiops-portal/README.md) | Read-only incidents plus revision-fenced data-source/routing settings and dry-run | `conversation.view`, `/api/aiops/portal` |
| [`aiops-observability/`](aiops-observability/README.md) | Low-cardinality liveness, readiness, and Prometheus telemetry | `ctx.aiopsTelemetry`, `/api/aiops/{healthz,readyz,metrics}` |
| [`webhook-alertmanager/`](webhook-alertmanager/README.md) | Bearer-authenticated, bounded Alertmanager v4 HTTP adapter | `ctx.webhookRuntime.dispatch()` |
| [`incident-router/`](incident-router/README.md) | Fingerprint rounds, replay protection, durable queue, live versioned policy/audit, storm control, and deterministic Session lifecycle | `ctx.aiopsIncidentRouter` |
| [`skill-k8s-diag/`](skill-k8s-diag/README.md) | Versioned general alert-time diagnosis workflow available across Workspaces; package path retained for compatibility | `aiops-diag` skill |
| [`aiops/`](aiops/README.md) | Installable profile patch containing the runtime rows and enabling the derived index | `dsh.bundle.patch` |

<a id="related-documentation"></a>
## Related documentation

- [AIOps subsystem](../docs/aiops.md) — complete runtime flow, state model, and first-version boundaries.
- [Production deployment and upgrade](../docs/deployment.md) — Host/TLS, credentials, migration, and validation.
- [Repeatable Alertmanager/k3s matrix](../deploy/alertmanager/README.md) — guarded real receiver testing.
- [AIOps foundation decision](../docs/decisions/2026-09-04-dsh-aiops-read-only-foundation.md) — package topology and safety rationale.
- [Packages](../README.md) — top-level workspace map.

<a id="dev-note"></a>
## Dev Note

None.
