---
description: "为只读 DSH AIOps HTTP Provider 共享的有界 GET 与 UTF-8 响应收集。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-http-read

[English](README.md) | 中文

## 概述

`dsh-aiops-http-read` 为 Alertmanager 与 Prometheus Provider 提供一套截止时间传播、禁止重定向的 JSON GET 请求以及完整字节有界 UTF-8 响应收集实现。它是无状态库，不是 Cordis 插件或 capability seam。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

请仅在所属 Provider 校验并解析 URL、截止时间与字节上限后调用 `readAiopsHttp()`。请把 `AiopsHttpReadError` 转换为该 capability 的公开错误类型，使 Consumer 不依赖此传输辅助库。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

该辅助库使用 `Accept: application/json` 发出固定的 `GET` 请求、拒绝重定向，并将调用方取消信号与 Provider 截止时间组合。它会在读取前拒绝声明为过大的正文，并在观测字节数超过配置上限时立即取消流式正文。成功输出包含 `Response` 元数据和完整解码正文。

### 源码导航

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 固定 HTTP 采集、截止时间分类与有界 UTF-8 正文收集 |
| — | 不发布运行时 invariant companion，因为每次调用拥有全部状态并返回一个不可变结果。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Alertmanager Provider](../aiops-alertmanager/README.zh.md)——使用该辅助库读取当前告警。
- [Prometheus Provider](../aiops-prometheus/README.zh.md)——使用该辅助库查询 PromQL。
- [AIOps 子系统](../../docs/aiops.zh.md)——capability 职责与只读限制。

-----

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **只处理完整正文**——该辅助库不暴露流式输出；超过字节上限会使整个请求失败。
- **仅使用面向 JSON 的请求头**——它始终请求 JSON，各 Provider 仍负责解析和校验自身的响应字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作信息——点击展开</summary>

无。

</details>
