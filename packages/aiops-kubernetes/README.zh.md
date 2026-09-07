---
description: "供部署配置 DSH AIOps kubectl Provider 的只读 Kubernetes 对象、Event 与有界 Pod 日志读取。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

[English](README.md) | 中文

## 概述

本包让 DSH 通过已配置的 kubectl 执行环境读取 Kubernetes 对象、按时间排序的 Event 与有界非流式 Pod 日志。它提供 `ctx.kubernetes`，面向模型的工具保留在 `dsh-tool-aiops-observe`。每条命令都使用显式 argv；不暴露 shell 或任意 kubectl 参数。本包不会创建、修补、删除集群对象，不会在对象内执行命令，也不会跟随日志。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在一个 `ctx.subprocess` Provider 之后挂载本包，并为选中的 kubeconfig 授予只读 RBAC。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes'
  config:
    command: kubectl
    context: production-readonly
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | `kubectl` | 可执行文件路径或通过 PATH 解析的名称 |
| `context` | kubectl 默认值 | 显式 Kubernetes context |
| `kubeconfig` | kubectl 发现机制 | 显式 kubeconfig 路径 |
| `graceMs` | `5000` | 进程树终止宽限时间 |
| `maxOutputBytes` | `2000000` | 完整保留 stdout 的上限 |
| `defaultLogTailLines` | `200` | 请求省略时使用的 Pod 日志行数 |
| `maxLogTailLines` | `2000` | Provider 限制后的最大 Pod 日志行数 |

上表完整列出了所有可接受字段。

针对已有样本 Pod 运行按需的真实集群 CrashLoopBackOff 演练（测试为只读）：

```sh
AIOPS_E2E_NAMESPACE=diagnostics AIOPS_E2E_POD=crashloop-fixture \
  pnpm exec vitest run packages/aiops-kubernetes/tests/crashloopbackoff.e2e.spec.ts
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

`KubernetesRuntime` 定义对象、列表、Event 与 Pod 日志读取。默认的 `KubectlKubernetesRuntime` 通过 `ctx.subprocess` 解析可执行文件、构造固定的 `kubectl get` 或 `kubectl logs` argv，并拒绝看起来像选项的模型输入。Event 读取接受闭区间 `sinceTime`/`untilTime`，并在取得按时间排序的 JSON 快照后按 Event 发生区间过滤。日志接受相对 `since` 或绝对 `sinceTime`；绝对 `untilTime` 会强制时间戳，并在有界读取后移除更晚或无时间戳的行。日志请求仍会在执行前解析 Provider 默认值与行数上限。stdout 有损或对象 JSON 无效时，调用会失败，不会返回不完整证据。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service、kubectl Provider、argv 构造与输出校验 |
| [`src/types.ts`](src/types.ts) | 与 Provider 无关的请求、已解析日志 spec、JSON 结果与日志文本 |
| — | 不发布 invariant companion，因为每条命令只有一个子进程结果，不存在可独立变化并发生分歧的可变观测 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 子系统](../../docs/aiops.zh.md)——端到端观测与事件流程。
- [AIOps 包导航](../README.zh.md)——所有包及其职责。
- [DSH 子进程子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subprocess.zh.md)——托管进程与输出语义。
- [观测工具](../tool-aiops-observe/README.zh.md)——面向模型的 Consumer。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-aiops-observe` 间接生效；该 Consumer 渲染有界 Kubernetes JSON、精确的有界日志文本与受控的命令失败。

#### KV 缓存影响

没有直接失效；上述 Consumer 负责工具 schema 与结果消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **kubectl 必须安装在子进程执行环境中**——如果缺失，第一次读取会在命令解析时失败。
- **仅快照读取**——Pod 日志不会跟随，Event 读取也不会 watch 后续对象。绝对上界是在返回快照上执行，而不是 Kubernetes 服务端筛选。
- **没有发现或聚合**——API 发现与跨 Pod/Loki 式日志搜索不属于该 Provider。
