---
description: "Read-only Kubernetes access for DSH AIOps, executed on the cluster agent bound to each diagnosis."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

English | [中文](README.zh.md)

## Summary

This package supplies the provider-neutral `ctx.kubernetes` service for object, Event, and bounded non-streaming Pod-log reads. Its provider is agent-only: every read is one typed request over the WebSocket of the cluster agent registered in [`dsh-aiops-agents`](../aiops-agents/README.md). The DSH host holds no kubeconfig, runs no `kubectl`, and cannot reach a cluster API server directly. The capability exposes no mutation, exec, arbitrary URL, watch, or raw-command path.

## Use this package

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes'
  config:
    defaultCluster: prod-sh
    defaultLogTailLines: 200
    maxLogTailLines: 2000
```

Each request names a registered cluster: the incident router binds the routed alert's cluster label (configurable on the router, default `cluster`) to the diagnosis, and the observation tools pass it through. `defaultCluster` applies only to sessions the router did not open — a manual session, or a round that predates cluster binding. With neither a bound cluster nor a default, Kubernetes tools fail with `unreachable` and a message saying no cluster is bound, so the diagnosis degrades to Alertmanager/Prometheus evidence instead of reading the wrong cluster.

Cluster connectivity is verified by probing the agent, not by testing a credential. The Portal's **Clusters** view runs that probe and shows the agent version and advertised capabilities; the data-source settings cover Prometheus, Alertmanager, and the webhook only.

The closed resource set follows the agent allowlist: Pods, Services, Endpoints, ConfigMaps, PVCs/PVs, Nodes, Namespaces, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, and CronJobs. Event and log windows are filtered and bounded on the agent.

## Implementation map

| File | Role |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | Stable service seam, request validation, and log-request resolution |
| [`src/index.ts`](src/index.ts) | Agent-backed provider: cluster resolution, typed reads, probe, error mapping |
| [`src/types.ts`](src/types.ts) | Provider-neutral requests, results, and connection capability types |

## Known limitations

- Every read needs a connected agent for the bound cluster; config file traffic and RBAC checks are no longer performed by the server.
- The agent's allowlist replaces arbitrary API discovery or custom resources.
- Reads are snapshots; logs do not follow and Events are not watched.
- A round's cluster binding is fixed when the round opens; a fingerprint that moves clusters mid-incident keeps reading the original one until the next round.

See the [AIOps subsystem](../../docs/aiops.md), [the agent protocol](../../agent/docs/protocol.md), and [model-facing observation tools](../tool-aiops-observe/README.md).
