---
description: "Read-only bounded Prometheus queries, alert-rule lookup, target health, and series metadata discovery for DSH AIOps."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-prometheus

English | [中文](README.zh.md)

## Summary

This package lets DSH read Prometheus metrics, alerting rules, target health, and bounded series metadata. Choose it for a trusted Prometheus HTTP endpoint whose response must be bounded and cancellable. It supplies `ctx.prometheus`; the model-facing tool names and rendering belong to `dsh-tool-aiops-observe`. The provider performs no writes and follows no redirects.

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
| `defaultDiscoveryLimit` | `20` | Default rule, target, or metadata result count |
| `maxDiscoveryLimit` | `100` | Hard caller-visible result-count cap |
| `maxMatcherCount` | `20` | Maximum exact label or series-selector filters per request |
| `maxInputChars` | `2000` | Maximum length of one discovery input value |
| `maxDiscoveryWindowSeconds` | `86400` | Maximum absolute label/series discovery window |

The table above is the exhaustive list of accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`PrometheusRuntime` defines instant/range queries plus alert-rule, scrape-target, and label/series discovery. The default `PrometheusHttpRuntime` uses only Prometheus GET APIs, validates configuration and request bounds, percent-encodes parameters, delegates non-redirecting bounded acquisition to `dsh-aiops-http-read`, and returns canonical result-count-limited data. Rule lookup excludes active-alert expansion. Target URLs are stripped of credentials, query, and fragment. A supplied `generatorURL` is accepted only for the configured same-origin graph endpoint, parsed locally for PromQL, and never fetched.

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
- **No arbitrary or global discovery** — metadata calls require concrete selectors and a bounded absolute time window; target calls require exact labels or a scrape pool.
