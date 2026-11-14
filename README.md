# DSH AIOps

English | [中文](README.zh.md)

`dsh-aiops` is an independently built DSH bundle for Alertmanager-driven, read-only incident diagnosis. It provides authenticated webhook ingress, general fingerprint-to-Session routing with a durable queue and resource budgets, alert-time query windows, a packaged `aiops-diag` skill, dynamically selected Alertmanager, Prometheus, and Kubernetes observation capabilities, structured incident reports, append-only operator feedback, workspace-scoped history/routing audit, and a dedicated AIOps Portal inside DSH Web.

## Compatibility and installation

The current source bundle is built and tested against:

| Component | Supported version |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.2.2-rc.1` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | `11.7.0` (`>=10` Git prepare-script approval semantics are required) |

Install the repository directly into the DSH Web profile:

```sh
dsh plugin --profile web add github:jarvan1/dsh-aiops
```

Without a global DSH command, use the matching CLI version:

```sh
npx -y @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add github:jarvan1/dsh-aiops
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

The GitHub installation uses the repository root bundle and relative built plugin entries. A future registry deployment can install `@deepseek-ai/dsh-aiops`; both forms add the AIOps patch after the profile's base and application layers. `PROMETHEUS_URL` and `ALERTMANAGER_URL` provide optional composition defaults and can be saved or overridden live in the AIOps data-source settings; `AIOPS_DEFAULT_CLUSTER` sets the fallback cluster agent for alerts without a cluster label. `AIOPS_WORKSPACE` and the `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` credential configure the automated workflow. The webhook listener defaults to `127.0.0.1:3081/alertmanager`; set `AIOPS_WEBHOOK_PUBLIC_URL` to the address Alertmanager should use when that loopback address is not reachable. Kubernetes reads go through the registered cluster agents; the host needs no kubeconfig and no `kubectl`.

In a Web profile, use the persistent `AIOps` action in the sidebar footer to open the global Portal from any screen. A non-blank Session also exposes the existing `AIOps` conversation view. The Portal always reads `AIOPS_WORKSPACE`; it does not widen scope based on the currently selected chat Session. Prometheus/Alertmanager URLs are persisted in DSH user settings and apply live; both must pass connectivity probes. Kubernetes connectivity is the agent probe in the **Clusters** view.

The same workspace manages versioned routing policy. A pasted normalized-label dry-run must succeed before the complete policy is saved atomically with a settings revision fence; changes apply live and are durably audited. The webhook credential remains server-side and the Portal returns only its configured status.

Multi-cluster access uses an outbound-only Go agent installed inside each cluster. The AIOps Portal issues one token per cluster (shown once, stored as a digest), the agent dials the server and proves its cluster identity with it, and the server tracks `pending`/`connected`/`offline`/`revoked` without ever holding a cluster credential. Diagnosis reads go through the selected agent: the router binds each alert round to the cluster named by its `cluster` label, and the host kubeconfig provider is gone. Upgrades remain a manual rollout. See [the agent](agent/README.md), [its protocol](agent/docs/protocol.md), and [the server gateway](packages/aiops-agents/README.md).

See [the AIOps subsystem guide](docs/aiops.md) for the delivery lifecycle, [production deployment and upgrade](docs/deployment.md) for the Host/TLS/rotation boundary, [the repeatable Alertmanager/k3s matrix](deploy/alertmanager/README.md) for real-cluster validation, [the roadmap](docs/roadmap.md) for completed and upcoming stages, and [the changelog](CHANGELOG.md) for notable changes.

The main DSH repository remains the source of generic Session, query, workflow, permission, and runtime capabilities. This repository owns only the AIOps domain packages and bundle.
