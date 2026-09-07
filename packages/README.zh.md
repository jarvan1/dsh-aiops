---
description: "AIOps 包组：认证告警入口、持久路由、只读观测、事件状态与历史搜索。"
kind: "package-group"
---

# aiops/ — 只读运维调查

[English](README.md) | 中文

## 摘要

`aiops/` 包组接收经过认证的 Alertmanager 通知，通过持久队列、分组、冷却和资源预算将稳定 fingerprint 路由为诊断 Session 轮次，让 Agent 收集有界证据、持久化结构化事件，让值班人员追加审核 verdict，并查询或在 Portal 中查看报告、反馈和路由审计。该系列保持只读，不包含自动修复或 RAG。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发说明](#dev-note)

-----

<a id="packages"></a>
## 包

十二个包覆盖入口、路由、采集、模型交互、随包诊断 skill、持久状态、历史读取、Portal 与组合。

| 包 | 职责 | ctx key 或贡献 |
|---|---|---|
| [`aiops-http-read/`](aiops-http-read/README.zh.md) | 共享的有界只读 HTTP 采集 | 无状态库 |
| [`aiops-alertmanager/`](aiops-alertmanager/README.zh.md) | 只读当前告警 Service Definition 与 HTTP Provider | `ctx.alertmanager` |
| [`aiops-prometheus/`](aiops-prometheus/README.zh.md) | 只读 PromQL Service Definition 与 HTTP Provider | `ctx.prometheus` |
| [`aiops-kubernetes/`](aiops-kubernetes/README.zh.md) | 默认直连 Kubernetes API、可选 kubectl 兼容的只读 Provider | `ctx.kubernetes` |
| [`tool-aiops-observe/`](tool-aiops-observe/README.zh.md) | 七个面向模型的观测工具 | `ctx.tools` |
| [`aiops-incident/`](aiops-incident/README.zh.md) | 完整报告、追加式反馈、投影与写入工具 | `aiops/incident-state`、`aiops/operator-feedback` |
| [`tool-aiops-history/`](tool-aiops-history/README.zh.md) | 工作区范围的报告、反馈与路由审计工具 | 基于 `ctx.sessionQuery` 与 router 的 `ctx.tools` |
| [`aiops-portal/`](aiops-portal/README.zh.md) | Web 内只读事件概览、筛选、详情与路由审计 | `conversation.view`、`/api/aiops/portal` |
| [`webhook-alertmanager/`](webhook-alertmanager/README.zh.md) | Bearer 认证、有界的 Alertmanager v4 HTTP adapter | `ctx.webhookRuntime.dispatch()` |
| [`incident-router/`](incident-router/README.zh.md) | fingerprint 轮次、重放防护、持久队列、风暴控制与确定性 Session 生命周期 | `ctx.aiopsIncidentRouter` |
| [`skill-k8s-diag/`](skill-k8s-diag/README.zh.md) | 跨 Workspace 可用的版本化告警时间锚 Kubernetes 诊断流程 | `k8s-diag` skill |
| [`aiops/`](aiops/README.zh.md) | 包含运行时行并启用派生索引的可安装 profile patch | `dsh.bundle.patch` |

<a id="related-documentation"></a>
## 相关文档

- [AIOps 子系统](../docs/aiops.zh.md)——完整运行时流程、状态模型与第一版边界。
- [AIOps 基础决策](../docs/decisions/2026-09-04-dsh-aiops-read-only-foundation.zh.md)——包拓扑与安全依据。
- [Packages](../README.zh.md)——顶层 workspace 导航。

<a id="dev-note"></a>
## 开发说明

无。
