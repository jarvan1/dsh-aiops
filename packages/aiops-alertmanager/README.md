---
description: "Read-only Alertmanager API v2 current-alert queries for deployments configuring DSH AIOps alert evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-alertmanager

English | [中文](README.zh.md)

## Summary

This package lets DSH read current Alertmanager alerts with state, label, and receiver filters. Choose it for a trusted Alertmanager HTTP endpoint whose complete response and query expressions must be bounded. It supplies `ctx.alertmanager`; the model-facing schema and rendering belong to `dsh-tool-aiops-observe`. The Provider exposes only `GET /api/v2/alerts`, performs no writes, and follows no redirects.

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

Mount one Provider row, then let a provider-neutral Consumer call `ctx.alertmanager`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-alertmanager'
  config:
    baseUrl: http://alertmanager.internal:9093
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Trusted Alertmanager HTTP(S) endpoint and optional path prefix |
| `timeoutMs` | `30000` | Per-request deadline |
| `maxResponseBytes` | `2000000` | Complete response-body byte cap |
| `maxFilterCount` | `20` | Combined alert and receiver-label matcher cap |
| `maxQueryValueChars` | `1000` | Character cap for each matcher or receiver expression |

The table above is the exhaustive list of accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`AlertmanagerRuntime` resolves Provider-owned API defaults and bounded filters before a query. The default `AlertmanagerHttpRuntime` percent-encodes repeated matchers, rejects credentials, delegates non-redirecting bounded acquisition to `dsh-aiops-http-read`, and accepts only a lossless JSON array of alert objects.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, HTTP Provider, request limits, and response validation |
| [`src/types.ts`](src/types.ts) | Provider-neutral request, resolved spec, and result types |
| — | No invariant companion is published because each call has one response and no independent mutable observation can diverge |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — alert-to-incident investigation flow.
- [AIOps package map](../README.md) — packages in the read-only workflow.
- [Observation tools](../tool-aiops-observe/README.md) — the model-facing Consumer.
- [AIOps HTTP read helper](../aiops-http-read/README.md) — shared deadline and response-byte enforcement.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-aiops-observe`, which renders detached current alerts and contained Provider failures.

#### KV Cache effect

No direct invalidation; the named Consumer owns the tool schema and result messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Authentication is not implemented** — the package targets trusted internal endpoints; bearer-token and mTLS Providers require a credential-aware design.
- **Current alerts only** — the package does not expose silences, alert groups, receivers, status, or any Alertmanager write endpoint.
