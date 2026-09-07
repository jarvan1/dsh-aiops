# DSH AIOps

English | [中文](README.zh.md)

`dsh-aiops` is an independently built DSH bundle for Alertmanager-driven, read-only Kubernetes incident diagnosis. It provides authenticated webhook ingress, fingerprint-to-Session routing with a durable queue and resource budgets, alert-time query windows, a packaged `k8s-diag` skill, Alertmanager, Prometheus, and Kubernetes observation capabilities, structured incident reports, append-only operator feedback, workspace-scoped history/routing audit, and a dedicated AIOps Portal inside DSH Web.

The sibling `deepseek-harness` checkout supplies local development overrides. Package source imports resolve through normal package exports; this workspace does not use DSH TypeScript path aliases.

## Development

```sh
pnpm install --offline
pnpm run typecheck
pnpm test
pnpm run pack:bundle
```

For local development, install the bundle into a DSH profile from the checked-out package:

```sh
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web add link:/path/to/dsh-aiops/packages/aiops
```

A published deployment installs `@deepseek-ai/dsh-aiops` from its registry. The CLI adds `@deepseek-ai/dsh-aiops/cordis.patch.yml` after the profile's base and application layers. `PROMETHEUS_URL` and `ALERTMANAGER_URL` provide optional composition defaults and can be saved or overridden live in the AIOps data-source settings. `AIOPS_WORKSPACE` and the `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` credential configure the automated workflow. The webhook listener defaults to `127.0.0.1:3081/alertmanager`; Kubernetes uses the configured `kubectl` command and read-only deployment credentials.

In a Web profile, use the persistent `AIOps` action in the sidebar footer to open the global Portal from any screen. A non-blank Session also exposes the existing `AIOps` conversation view. The Portal always reads `AIOPS_WORKSPACE`; it does not widen scope based on the currently selected chat Session. Prometheus and Alertmanager URLs saved in the Portal are persisted in the DSH user settings document and apply live.

See [the AIOps subsystem guide](docs/aiops.md) for the delivery lifecycle and [the roadmap](docs/roadmap.md) for completed and upcoming stages.

The main DSH repository remains the source of generic Session, query, workflow, permission, and runtime capabilities. This repository owns only the AIOps domain packages and bundle.
