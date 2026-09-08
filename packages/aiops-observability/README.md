---
description: "Low-cardinality health, readiness, and Prometheus telemetry for the DSH AIOps runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-observability

English | [中文](README.zh.md)

This Cordis service exposes product-level operational signals without alert-derived labels:

- `GET|HEAD /api/aiops/healthz` reports process liveness.
- `GET|HEAD /api/aiops/readyz` returns `200` only after both the Alertmanager ingress and incident router are registered; otherwise it returns `503` with bounded component state.
- `GET|HEAD /api/aiops/metrics` returns Prometheus text exposition for webhook outcomes, queue depth and oldest age, grouped/deferred/dropped work, active diagnoses, model token reservations, dispatch failures, and diagnostic latency.

All metric label values come from fixed enums. Alert names, fingerprints, delivery IDs, Session IDs, URLs, namespaces, and other unbounded values are deliberately absent. Counters and latency buckets are process-lifetime telemetry; durable routing truth and audit remain in the incident-router SQLite store.

## Configuration

`healthPath`, `readinessPath`, and `metricsPath` may replace the three defaults. Each must be a distinct absolute non-root exact path without a trailing slash, query, or fragment.

## Integration

The service publishes `ctx.aiopsTelemetry`. The Alertmanager adapter records one bounded request outcome and marks ingress readiness. The incident router records queue transitions, dispatch failures, diagnostic latency, and current gauges, and marks router readiness.

See the [AIOps subsystem](../../docs/aiops.md) for the complete runtime flow and safety boundary.
