---
description: "Read-only native Kubernetes API access from kubeconfig, with an optional kubectl compatibility provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

English | [中文](README.zh.md)

## Summary

This package supplies the provider-neutral `ctx.kubernetes` service for object, Event, and bounded non-streaming Pod-log reads. Its default `NativeKubernetesRuntime` uses the official `@kubernetes/client-node` library to load kubeconfig and call the API server directly, so the DSH host does not need `kubectl`. The capability exposes no mutation, exec, arbitrary URL, watch, or raw-command path.

## Use this package

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes'
  config:
    kubeconfig: /srv/dsh/.kube/config
    context: production-readonly
    timeoutMs: 30000
    maxResponseBytes: 2000000
    defaultLogTailLines: 200
    maxLogTailLines: 2000
```

`kubeconfig` and `context` may be omitted to use normal kubeconfig discovery and `current-context`. A configured path must be absolute and refers to a file on the DSH server, not the browser machine. The AIOps Portal stores only this path and context in user settings; it never sends kubeconfig contents or credentials to the browser.

The Portal connection test calls the cluster version endpoint and uses `SelfSubjectAccessReview` to verify the three minimum diagnosis capabilities in the selected default namespace: get Pods, list Events, and get the `pods/log` subresource. Saving is enabled only after this check and the Prometheus/Alertmanager checks pass.

The native object reader intentionally supports the built-in diagnosis set: Pods, Services, Endpoints, ConfigMaps, PVCs/PVs, Nodes, Namespaces, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, and CronJobs. Event and log windows remain bounded and are post-filtered at an inclusive upper bound when Kubernetes has no matching server-side option.

### Optional kubectl compatibility provider

Existing deployments can explicitly select the legacy provider:

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes/kubectl'
  config:
    command: kubectl
    kubeconfig: /srv/dsh/.kube/config
```

That subpath requires `ctx.subprocess` and an installed `kubectl`; it is no longer the package default.

## Implementation map

| File | Role |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | Stable service seam, validation, and Event/log window helpers |
| [`src/index.ts`](src/index.ts) | Default native kubeconfig/API provider and RBAC connectivity check |
| [`src/kubectl.ts`](src/kubectl.ts) | Explicit kubectl compatibility provider |
| [`src/types.ts`](src/types.ts) | Provider-neutral requests, results, and connection capability types |

## Known limitations

- Kubeconfigs using `users[].user.exec` do not require `kubectl`, but still require their configured authentication executable (for example `aws`, `gcloud`, or `kubelogin`) on the DSH host.
- The native provider uses a bounded allowlist rather than arbitrary API discovery or custom resources.
- Reads are snapshots; logs do not follow and Events are not watched.

See the [AIOps subsystem](../../docs/aiops.md) and [model-facing observation tools](../tool-aiops-observe/README.md).
