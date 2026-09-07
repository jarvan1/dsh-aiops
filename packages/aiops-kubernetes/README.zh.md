---
description: "通过 kubeconfig 直连 Kubernetes API 的只读 Provider，并保留可选 kubectl 兼容入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

[English](README.md) | 中文

## 概述

本包提供与 Provider 无关的 `ctx.kubernetes` Service，用于读取对象、Event 和有界非流式 Pod 日志。默认的 `NativeKubernetesRuntime` 使用官方 `@kubernetes/client-node` 加载 kubeconfig 并直接调用 API Server，因此 DSH 主机不需要安装 `kubectl`。该能力不暴露变更、容器 exec、任意 URL、watch 或原始命令入口。

## 使用本包

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

省略 `kubeconfig` 和 `context` 时使用标准 kubeconfig 发现与 `current-context`。显式路径必须是绝对路径，指向 DSH 服务端机器上的文件，而不是浏览器所在机器。AIOps Portal 只把路径和 context 保存到用户设置，不会把 kubeconfig 内容或凭据发送给浏览器。

Portal 连通性测试会访问集群版本端点，并通过 `SelfSubjectAccessReview` 检查所选默认 namespace 中诊断所需的三项最低权限：读取 Pod、列出 Event、读取 `pods/log` 子资源。Kubernetes、Prometheus 和 Alertmanager 三项测试全部通过后才能保存。

原生对象读取器当前明确支持诊断内置集合：Pod、Service、Endpoints、ConfigMap、PVC/PV、Node、Namespace、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job 和 CronJob。Event 与日志读取保持有界；当 Kubernetes 没有对应服务端选项时，会在本地按闭区间上界过滤。

### 可选 kubectl 兼容 Provider

已有部署可以显式选择旧 Provider：

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes/kubectl'
  config:
    command: kubectl
    kubeconfig: /srv/dsh/.kube/config
```

该子路径需要 `ctx.subprocess` 和已安装的 `kubectl`；它不再是默认入口。

## 实现导航

| 文件 | 作用 |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | 稳定 Service 接口、输入校验和 Event/日志窗口辅助逻辑 |
| [`src/index.ts`](src/index.ts) | 默认原生 kubeconfig/API Provider 与 RBAC 连通性检查 |
| [`src/kubectl.ts`](src/kubectl.ts) | 显式 kubectl 兼容 Provider |
| [`src/types.ts`](src/types.ts) | Provider 无关请求、结果和连接能力类型 |

## 已知限制

- 使用 `users[].user.exec` 的 kubeconfig 不需要 `kubectl`，但 DSH 主机仍须安装其中指定的认证程序，例如 `aws`、`gcloud` 或 `kubelogin`。
- 原生 Provider 使用有界资源白名单，尚不支持任意 API discovery 或自定义资源。
- 所有读取均为快照；日志不会 follow，Event 也不会 watch。

参见 [AIOps 子系统](../../docs/aiops.zh.md)和[面向模型的观测工具](../tool-aiops-observe/README.zh.md)。
