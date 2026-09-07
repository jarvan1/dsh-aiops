# DSH AIOps

English | [中文](README.zh.md)

`dsh-aiops` is an independently built DSH bundle for Alertmanager-driven, read-only Kubernetes incident diagnosis. It provides authenticated webhook ingress, fingerprint-to-Session routing with a durable queue and resource budgets, alert-time query windows, a packaged `k8s-diag` skill, Alertmanager, Prometheus, and Kubernetes observation capabilities, structured incident reports, append-only operator feedback, workspace-scoped history/routing audit, and a dedicated AIOps Portal inside DSH Web.

## Compatibility and installation

The current source bundle is built and tested against:

| Component | Supported version |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.2-rc.1` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | `>=10` (Git prepare-script approval may be required) |

Install the repository directly into the DSH Web profile:

```sh
dsh plugin --profile web add github:jarvan1/dsh-aiops
```

Without a global DSH command, use the matching CLI version:

```sh
npx -y @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add github:jarvan1/dsh-aiops
```

pnpm 10 and later will initially block the Git dependency's `prepare` script. The failed command prints an `allowBuilds` entry containing the resolved repository and commit. Copy that **exact key** into `<DSH_HOME>/profiles/web/pnpm-workspace.yaml` (normally `~/.dsh/profiles/web/pnpm-workspace.yaml`) and run the add command again. Its shape is:

```yaml
allowBuilds:
  'dsh-aiops@https://codeload.github.com/jarvan1/dsh-aiops/tar.gz/<resolved-commit-sha>': true
```

Do not replace the printed key with only `dsh-aiops`: pnpm intentionally binds this permission to the exact Git source revision.

For reproducible deployments, pin a release tag or commit, for example `github:jarvan1/dsh-aiops#<commit-sha>`. Restart DSH after installation.

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

The GitHub installation uses the repository root bundle and relative built plugin entries. A future registry deployment can install `@deepseek-ai/dsh-aiops`; both forms add the AIOps patch after the profile's base and application layers. `PROMETHEUS_URL` and `ALERTMANAGER_URL` provide optional composition defaults and can be saved or overridden live in the AIOps data-source settings. `AIOPS_WORKSPACE` and the `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` credential configure the automated workflow. The webhook listener defaults to `127.0.0.1:3081/alertmanager`; Kubernetes uses the configured `kubectl` command and read-only deployment credentials.

In a Web profile, use the persistent `AIOps` action in the sidebar footer to open the global Portal from any screen. A non-blank Session also exposes the existing `AIOps` conversation view. The Portal always reads `AIOPS_WORKSPACE`; it does not widen scope based on the currently selected chat Session. Prometheus and Alertmanager URLs saved in the Portal are persisted in the DSH user settings document and apply live.

See [the AIOps subsystem guide](docs/aiops.md) for the delivery lifecycle and [the roadmap](docs/roadmap.md) for completed and upcoming stages.

The main DSH repository remains the source of generic Session, query, workflow, permission, and runtime capabilities. This repository owns only the AIOps domain packages and bundle.
