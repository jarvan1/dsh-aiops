---
description: "Read-only Kubernetes object, Event, and bounded Pod-log retrieval for deployments configuring the DSH AIOps kubectl Provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

English | [中文](README.zh.md)

## Summary

This package lets DSH read Kubernetes objects, chronological Events, and bounded non-streaming Pod logs through a configured kubectl execution world. It supplies `ctx.kubernetes` while the model-facing tools stay in `dsh-tool-aiops-observe`. Every command uses an explicit argv; no shell or arbitrary kubectl arguments are exposed. The package never creates, patches, deletes, executes in, or follows logs from cluster objects.

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

Mount it after one `ctx.subprocess` provider; grant the selected kubeconfig read-only RBAC.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes'
  config:
    command: kubectl
    context: production-readonly
```

| Field | Default | Meaning |
|---|---|---|
| `command` | `kubectl` | Executable path or PATH-resolved name |
| `context` | kubectl default | Explicit Kubernetes context |
| `kubeconfig` | kubectl discovery | Explicit kubeconfig path |
| `graceMs` | `5000` | Process-tree termination grace |
| `maxOutputBytes` | `2000000` | Complete retained stdout cap |
| `defaultLogTailLines` | `200` | Pod-log line count when a request omits it |
| `maxLogTailLines` | `2000` | Maximum Pod-log line count after Provider capping |

The table above is the exhaustive list of accepted fields.

Run the opt-in real-cluster CrashLoopBackOff exercise against an existing fixture Pod (the test is read-only):

```sh
AIOPS_E2E_NAMESPACE=diagnostics AIOPS_E2E_POD=crashloop-fixture \
  pnpm exec vitest run packages/aiops-kubernetes/tests/crashloopbackoff.e2e.spec.ts
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`KubernetesRuntime` defines object, list, Event, and Pod-log reads. The default `KubectlKubernetesRuntime` resolves the executable through `ctx.subprocess`, constructs fixed `kubectl get` or `kubectl logs` argv, and rejects option-looking model values. Event reads accept inclusive `sinceTime`/`untilTime` bounds and filter Event occurrence intervals after the chronological JSON snapshot. Logs accept either relative `since` or absolute `sinceTime`; an absolute `untilTime` forces timestamps and removes later or undated lines after the bounded read. Log requests still resolve a Provider default and line cap before execution. Lossy stdout or invalid object JSON fails the call instead of returning incomplete evidence.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, kubectl provider, argv construction, and output validation |
| [`src/types.ts`](src/types.ts) | Provider-neutral requests, resolved log spec, JSON results, and log text |
| — | No invariant companion is published because each command has one subprocess outcome and no independent mutable observation can diverge |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — end-to-end observation and incident flow.
- [AIOps package map](../README.md) — all packages and their roles.
- [DSH subprocess subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subprocess.md) — managed process and output semantics.
- [Observation tools](../tool-aiops-observe/README.md) — the model-facing Consumer.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-aiops-observe`, which renders bounded Kubernetes JSON, exact bounded log text, and contained command failures.

#### KV Cache effect

No direct invalidation; the named Consumer owns tool schemas and result messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **kubectl must be installed in the subprocess execution world** — command resolution fails at the first read when it is absent.
- **Snapshot reads only** — Pod logs never follow, and Event reads do not watch for later objects. Absolute upper bounds are enforced on the returned snapshot, not by Kubernetes server-side selection.
- **No discovery or aggregation** — API discovery and multi-Pod/Loki-style log searches remain outside this Provider.
