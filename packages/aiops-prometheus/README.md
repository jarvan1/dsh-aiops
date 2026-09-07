---
description: "Read-only Prometheus instant and range queries for deployments configuring the DSH AIOps metrics provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-prometheus

English | [中文](README.zh.md)

## Summary

This package lets DSH read Prometheus metrics through instant and range PromQL queries. Choose it for a trusted Prometheus HTTP endpoint whose response must be bounded and cancellable. It supplies `ctx.prometheus`; the model-facing tool names and rendering belong to `dsh-tool-aiops-observe`. The provider performs no writes and follows no redirects.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount one provider row, then let a provider-neutral Consumer call `ctx.prometheus`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-prometheus'
  config:
    baseUrl: http://prometheus.internal:9090
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Trusted Prometheus HTTP(S) endpoint and optional path prefix |
| `timeoutMs` | `30000` | Per-request deadline |
| `maxResponseBytes` | `2000000` | Complete response-body byte cap |

The table above is the exhaustive list of accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`PrometheusRuntime` defines instant and range query operations; the default `PrometheusHttpRuntime` implements them through `/api/v1/query` and `/api/v1/query_range`. It validates configuration at load, percent-encodes parameters, delegates non-redirecting bounded acquisition to `dsh-aiops-http-read`, and returns only successful Prometheus query data.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, HTTP provider, configuration, and response validation |
| [`src/types.ts`](src/types.ts) | Provider-neutral requests and results |
| — | No invariant companion is published because each call has one response and no independent mutable observation can diverge |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — end-to-end observation and incident flow.
- [AIOps package map](../README.md) — all packages and their roles.
- [Observation tools](../tool-aiops-observe/README.md) — the model-facing Consumer.
- [AIOps HTTP read helper](../aiops-http-read/README.md) — shared deadline and response-byte enforcement.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-aiops-observe`, which renders normalized Prometheus query results and contained provider failures.

#### KV Cache effect

No direct invalidation; the named Consumer owns tool schemas and result messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Authentication is not implemented** — the first version targets trusted internal endpoints; bearer-token and mTLS providers require a separate credential-aware design.
- **No Prometheus alert or metadata APIs** — only instant and range PromQL queries are available; Alertmanager reads use the separate AIOps Provider.
