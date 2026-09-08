---
description: "Installable profile layer adding Alertmanager-driven read-only diagnosis, durable incident routing, and history search to a DSH surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-aiops

English | [中文](README.zh.md)

## Summary

This bundle adds an Alertmanager-driven, read-only AIOps workflow to an existing DSH profile. It mounts a dedicated webhook listener, a general fingerprint router with durable queue/cooldown/resource budgets, the packaged `aiops-diag` skill, three observation Providers, seven observation tools, report and feedback write tools, five workspace-scoped history/audit tools, and a Web Portal. No shipped profile includes it by default. Startup requires `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`; endpoints and the server-side kubeconfig path can be supplied through environment defaults or saved live in the Portal. Kubernetes reads need read-only cluster credentials but do not require kubectl.

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

### Install into a profile

Add the checkout package to a long-running profile, then provide the data endpoints, webhook credential, and diagnostic workspace:

```sh
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web add link:/path/to/dsh-aiops/packages/aiops
DSH_HOME=/path/to/profile-home AIOPS_ALERTMANAGER_WEBHOOK_SECRET=change-me AIOPS_WORKSPACE=/srv/aiops-workspace \
  ALERTMANAGER_URL=http://127.0.0.1:9093 PROMETHEUS_URL=http://127.0.0.1:9090 \
  pnpm dsh web
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web remove @deepseek-ai/dsh-aiops
```

`AIOPS_ALERTMANAGER_WEBHOOK_SECRET` can also be persisted in DSH's private credential file at `<DSH_HOME>/.credentials.yaml` instead of being exported for every launch. The `secretEnv` field in `cordis.patch.yml` remains a reference name, never the secret value:

```yaml
version: 1
refs:
  AIOPS_ALERTMANAGER_WEBHOOK_SECRET: replace-with-a-long-random-secret
records: {}
```

If the file already exists, merge this entry into `refs` without replacing other credentials. On POSIX systems the file must remain owner-only (`chmod 600`).

The plugin command reconciles this package and its dependencies into the profile and activates its declared `dsh.bundle.patch`. A missing patch declaration or required HTTP endpoint fails loudly instead of starting a partial AIOps tool set.

### What you get

The layer inserts a generic webhook runtime, deterministic incident router, globally registered `aiops-diag` instructions, an isolated Alertmanager listener, three observation Providers, observation/report/feedback/history tools, and a read-only `AIOps` Web tab. The router accepts all alert names except explicitly configured noise and assigns a default severity when the source value is missing or unknown. `AIOPS_WORKSPACE` selects both the diagnostic Workspace and the Portal's fixed server-side scope. The bundle keeps routing state, queue, and audit in `aiops-router.sqlite` and the disposable history index in `aiops-incidents.sqlite`. Default storm control uses a 60-second fingerprint cooldown, a 100-item/15-minute queue, three attempts, four globally active turns, and severity-specific concurrency/token reservations.

Configure Alertmanager's webhook receiver to send JSON with `Authorization: Bearer <secret>`. An optional `X-DSH-Delivery-ID` enables sender-owned retry identity; otherwise the authenticated body digest is used. The shipped policy accepts arbitrary alert names except its explicit noise exclusions, normalizes known severity labels, falls back to a configured default severity, and applies severity-specific model and storm-control budgets. A later profile patch can replace those policy values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch is a later profile layer: it inserts AIOps row IDs and deliberately replaces the base session-query configuration to enable full-text search. Provider rows load before their Consumer, while Cordis injection also holds Consumers until required services are available. Resource limits are explicit bundle values and remain overridable by a later user patch that replaces the complete row configuration.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ingress, routing/time policy, packaged skill, diagnostic Providers and tools, and derived-index activation |
| [`src/index.ts`](src/index.ts) | Empty module entry; the manifest-declared patch is the package's runtime substance |
| — | No invariant companion is published because the bundle owns composition only; inserted packages enforce their relations |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps package map](../README.md) — packages supplied by this layer.
- [AIOps subsystem](../../docs/aiops.md) — architecture and first-version boundaries.
- [DSH profile boot](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md) — bundle order and user patch semantics.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the packaged `aiops-diag` skill and the observation, incident, and incident-history packages inserted by this patch layer; those packages own instructions, tool schemas, and results.

#### KV Cache effect

Adding or removing the layer changes the visible tool-schema prefix; provider environment values alone do not change schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The layer requires an existing application profile** — it does not include `dsh-base`, an LLM provider, or a task runner.
- **The listener has no TLS** — keep the default loopback bind behind a TLS reverse proxy, or explicitly protect an all-interface bind with network policy.
- **Environment values are composition defaults** — the Web Portal can persist and apply endpoint and kubeconfig selections live.
- **Read-only credentials remain deployment-owned** — the Portal checks required Kubernetes RBAC, but cannot prove external Alertmanager/Prometheus ACL policy.
- **One process owns the index path** — do not point another running Session Query Provider at the same `aiops-incidents.sqlite` file.
