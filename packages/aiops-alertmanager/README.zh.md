---
description: "供部署配置 DSH AIOps 告警证据的只读 Alertmanager API v2 当前告警查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-alertmanager

[English](README.md) | 中文

## 概述

本包让 DSH 使用状态、标签与接收器过滤条件读取 Alertmanager 当前告警。它适用于可信的 Alertmanager HTTP 端点，并对完整响应与查询表达式实施限制。它提供 `ctx.alertmanager`；面向模型的 schema 与渲染由 `dsh-tool-aiops-observe` 负责。该 Provider 只暴露 `GET /api/v2/alerts`，不执行写入，也不跟随重定向。

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

挂载一个 Provider 行，然后让与 Provider 无关的 Consumer 调用 `ctx.alertmanager`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-aiops-alertmanager'
  config:
    baseUrl: http://alertmanager.internal:9093
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | 可信的 Alertmanager HTTP(S) 端点及可选路径前缀 |
| `timeoutMs` | `30000` | 每次请求的截止时间 |
| `maxResponseBytes` | `2000000` | 完整响应体字节上限 |
| `maxFilterCount` | `20` | 告警与接收器标签匹配表达式的合计数量上限 |
| `maxQueryValueChars` | `1000` | 每个匹配表达式或接收器表达式的字符上限 |

上表完整列出了所有可接受字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

`AlertmanagerRuntime` 在查询前解析 Provider 负责的 API 默认值与有界过滤条件。默认的 `AlertmanagerHttpRuntime` 对重复匹配表达式进行百分号编码、拒绝凭据、把禁止重定向的有界采集委托给 `dsh-aiops-http-read`，并且只接受由告警对象组成的无损 JSON 数组。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Service、HTTP Provider、请求限制与响应校验 |
| [`src/types.ts`](src/types.ts) | 与 Provider 无关的请求、已解析 spec 与结果类型 |
| — | 不发布 invariant companion，因为每次调用只有一个响应，不存在可独立变化并发生分歧的可变观测 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 子系统](../../docs/aiops.zh.md)——从告警到事件的调查流程。
- [AIOps 包导航](../README.zh.md)——只读工作流中的各个包。
- [观测工具](../tool-aiops-observe/README.zh.md)——面向模型的 Consumer。
- [AIOps HTTP 读取辅助库](../aiops-http-read/README.zh.md)——共享截止时间与响应字节限制。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-aiops-observe` 间接生效；该 Consumer 渲染分离的当前告警与受控的 Provider 失败。

#### KV 缓存影响

没有直接失效；上述 Consumer 负责工具 schema 与结果消息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **尚未实现认证**——本包面向可信内部端点；Bearer token 与 mTLS Provider 需要凭据感知设计。
- **仅提供当前告警**——本包不暴露静默、告警组、接收器、状态或任何 Alertmanager 写端点。
