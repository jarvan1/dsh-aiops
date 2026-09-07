---
description: "Model-facing read-only Alertmanager, Prometheus, and Kubernetes tools for collecting bounded AIOps evidence without infrastructure mutation."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-aiops-observe

English | [中文](README.zh.md)

## Summary

This package gives the model seven read-only observation tools: Alertmanager current alerts, Prometheus instant/range queries, and Kubernetes object/list/Event/Pod-log reads. Use it with one Provider for each service to collect factual incident evidence. The tools expose no raw HTTP URL, shell command, arbitrary kubectl arguments, log following, or mutation. Provider limits bound every complete result returned to the model.

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

Mount the three Provider services before this Consumer.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-alertmanager'
  config:
    baseUrl: http://alertmanager.internal:9093
- name: '@deepseek-ai/dsh-aiops-prometheus'
  config:
    baseUrl: http://prometheus.internal:9090
- name: '@deepseek-ai/dsh-aiops-kubernetes'
- name: '@deepseek-ai/dsh-tool-aiops-observe'
```

The registered tool schemas are the exhaustive source for arguments and results.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each tool translates snake-case model arguments to one provider-neutral Service call and forwards cancellation. Kubernetes calls derive their working directory from the owning Agent Session; Event and log tools accept explicit absolute `since_time`/`until_time` values, while bounded log requests pass through the Provider's explicit resolver. Structured results render as deterministic JSON, filtered log text remains bounded, and generic read/search cards need no package-specific UI.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Seven schemas, Service calls, rendering, and pure call presentation |
| — | No invariant companion is published because this adapter owns no independent state or lifecycle stream |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — observation-to-incident workflow.
- [Alertmanager Provider](../aiops-alertmanager/README.md) — current-alert filters and HTTP limits.
- [Prometheus provider](../aiops-prometheus/README.md) — query transport and bounds.
- [Kubernetes provider](../aiops-kubernetes/README.md) — kubectl read enforcement.
- [Incident state](../aiops-incident/README.md) — durable evidence, hypotheses, and recommendations.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

### Observation tool schemas

#### What the model sees

The model sees the registered `alertmanager_alerts`, `prometheus_query`, `prometheus_query_range`, `kubernetes_get`, `kubernetes_list`, `kubernetes_events`, and `kubernetes_logs` schemas. Their descriptions identify every operation as read-only and tell the model to use observations as evidence rather than immediate causal proof.

#### Token effect

The seven schemas add a fixed request prefix while this plugin is visible. Each successful call appends Provider-bounded JSON or exact bounded log text; failures append the contained tool error.

#### KV Cache effect

The tool-schema prefix is stable until the plugin registration changes. Call results append after that prefix and do not rewrite earlier request content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No change-source or aggregated-log tools** — deployment history and Loki-style cross-Pod searches remain future Providers and Consumers.
- **Generic UI cards only** — the Web Client has no AIOps-specific chart, topology, or evidence card.
