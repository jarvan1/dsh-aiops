---
description: "面向 DSH AIOps 的只读有界 Prometheus 查询、告警规则、Target 健康与时序元数据发现。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-prometheus

[English](README.md) | 中文

## 概述

本包让 DSH 读取 Prometheus 指标、告警规则、Target 健康与有界时序元数据。它适用于可信的 Prometheus HTTP 端点，并对响应实施大小限制与取消。它提供 `ctx.prometheus`；面向模型的工具名与渲染由 `dsh-tool-aiops-observe` 负责。该 Provider 不执行写入，也不跟随重定向。

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

挂载一个 Provider 行，然后让与 Provider 无关的 Consumer 调用 `ctx.prometheus`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-aiops-prometheus'
  config:
    baseUrl: http://prometheus.internal:9090
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | 可信的 Prometheus HTTP(S) 端点及可选路径前缀 |
| `timeoutMs` | `30000` | 每次请求的截止时间 |
| `maxResponseBytes` | `2000000` | 完整响应体字节上限 |
| `defaultDiscoveryLimit` | `20` | 规则、Target 或元数据的默认结果数 |
| `maxDiscoveryLimit` | `100` | 调用方可请求的硬结果数上限 |
| `maxMatcherCount` | `20` | 单次请求的精确 label 或 series selector 上限 |
| `maxInputChars` | `2000` | 单个发现输入值的最大长度 |
| `maxDiscoveryWindowSeconds` | `86400` | label/series 发现的最大绝对时间窗 |

上表完整列出了所有可接受字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

`PrometheusRuntime` 定义即时/范围查询以及告警规则、抓取 Target 和 label/series 发现。默认的 `PrometheusHttpRuntime` 只使用 Prometheus GET API，校验配置和请求边界，对参数进行百分号编码，把禁止重定向的有界采集委托给 `dsh-aiops-http-read`，并返回规范化且限制结果数的数据。规则查询排除活动告警展开；Target URL 会移除凭据、查询与 fragment。传入的 `generatorURL` 只允许指向已配置的同源 Prometheus graph 端点，仅在本地提取 PromQL，绝不发起抓取。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service、HTTP Provider、配置与响应校验 |
| [`src/types.ts`](src/types.ts) | 与 Provider 无关的请求和结果 |
| — | 不发布 invariant companion，因为每次调用只有一个响应，不存在可独立变化并发生分歧的可变观测 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 子系统](../../docs/aiops.zh.md)——端到端观测与事件流程。
- [AIOps 包导航](../README.zh.md)——所有包及其职责。
- [观测工具](../tool-aiops-observe/README.zh.md)——面向模型的 Consumer。
- [AIOps HTTP 读取辅助库](../aiops-http-read/README.zh.md)——共享截止时间与响应字节限制。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-aiops-observe` 间接生效；该 Consumer 渲染规范化的 Prometheus 查询结果与受控的 Provider 失败。

#### KV 缓存影响

没有直接失效；上述 Consumer 负责工具 schema 与结果消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚未实现认证**——第一版面向可信内部端点；Bearer token 与 mTLS Provider 需要独立的凭据感知设计。
- **不允许任意或全局发现**——元数据调用必须包含具体 selector 和有界绝对时间窗；Target 调用必须包含精确 label 或 scrape pool。
