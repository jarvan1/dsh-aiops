---
description: "面向模型的只读 Alertmanager、Prometheus 与 Kubernetes 工具，用于收集有界 AIOps 证据而不变更基础设施。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-aiops-observe

[English](README.md) | 中文

## 概述

本包向模型提供七个只读观测工具：Alertmanager 当前告警、Prometheus 即时/范围查询，以及 Kubernetes 对象/列表/Event/Pod 日志读取。将其与各 Service 的一个 Provider 配合使用，可收集事实性的事件证据。这些工具不暴露原始 HTTP URL、shell 命令、任意 kubectl 参数、日志跟随或变更操作。Provider 限制约束返回给模型的每个完整结果。

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

先挂载三个 Provider Service，再挂载本 Consumer。

### 最小配置

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

注册的工具 schema 是参数与结果的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

每个工具把 snake-case 模型参数转换为一次与 Provider 无关的 Service 调用并转发取消信号。Kubernetes 调用从所属 Agent Session 派生工作目录；Event 与日志工具接受明确的绝对 `since_time`/`until_time`，有界日志请求则通过 Provider 的显式 resolver。结构化结果渲染为确定性 JSON，过滤后的日志文本保持有界，通用读取/搜索卡片不需要包专属 UI。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 七个 schema、Service 调用、渲染与纯调用展示 |
| — | 不发布 invariant companion，因为该适配器不拥有独立状态或生命周期流 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 子系统](../../docs/aiops.zh.md)——从观测到事件的工作流。
- [Alertmanager Provider](../aiops-alertmanager/README.zh.md)——当前告警过滤与 HTTP 限制。
- [Prometheus Provider](../aiops-prometheus/README.zh.md)——查询传输与上限。
- [Kubernetes Provider](../aiops-kubernetes/README.zh.md)——kubectl 只读约束。
- [事件状态](../aiops-incident/README.zh.md)——持久证据、假设与建议。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

### 观测工具 schema

#### 模型看到的内容

模型会看到注册的 `alertmanager_alerts`、`prometheus_query`、`prometheus_query_range`、`kubernetes_get`、`kubernetes_list`、`kubernetes_events` 与 `kubernetes_logs` schema。其描述把每项操作标识为只读，并要求模型把观测用作证据，而不是立即视为因果证明。

#### Token 影响

本插件可见时，七个 schema 会添加固定的请求前缀。每次成功调用都会追加 Provider 约束大小的 JSON 或精确的有界日志文本；失败时则追加受控的工具错误。

#### KV 缓存影响

在插件注册变化前，工具 schema 前缀保持稳定。调用结果追加在该前缀之后，不会重写更早的请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有变更源或聚合日志工具**——部署历史和 Loki 式跨 Pod 搜索仍是未来的 Provider 与 Consumer。
- **仅有通用 UI 卡片**——Web Client 尚无 AIOps 专属图表、拓扑或证据卡片。
