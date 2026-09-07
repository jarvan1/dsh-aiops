# @deepseek-ai/dsh-aiops-incident-router

[English](README.md) | 中文

面向 DSH AIOps 的持久 Alertmanager fingerprint 路由。该服务注册一个可信的 `alertmanager` webhook rule，应用精确的 alertname 白名单和 severity 映射，在 SQLite 中串行化路由决策，并驱动确定性的诊断 Session identity。

## 生命周期

- 第一个被接受的 firing 告警创建第 1 轮。
- 后续 firing 通知追加到同一个 Session。
- resolved 通知追加到该 Session，并把告警表达式标记为已恢复；它不会自动关闭 AIOps 事件。
- resolved 之后再次 firing 会创建下一轮和新的 Session。
- 完全相同的 delivery 重试是幂等的。使用不同认证内容复用发送方提供的 delivery id 会失败。
- 并发的首批通知合并到一个确定性 Session；SQLite `BEGIN IMMEDIATE` 串行化 fingerprint 状态变更。
- 同一 fingerprint 的待处理通知按 lifecycle status 分组为一次模型 turn；状态不同的通知保持顺序。
- 进程重启后，处理中工作会恢复为队列项，相同的 SQLite 映射会先恢复已持久化的 Session，再追加下一条通知。

每个符合策略的告警会在创建 Agent 前持久化。Router 按 fingerprint 冷却、全局/分 severity 并发、全局/分 severity Token 预留上限和队列容量决定立即启动、延迟或丢弃；critical 优先，同等级保持 FIFO。每次过滤、分组、延迟、丢弃、启动、完成或失败均写入审计。每个最终被接受的决策都会先写入可忽略的 `aiops/alert-routed` v2 Session 事件，再发送模型可见的 follow-up。事件把 `alert.startsAt` 投影为规范 T0、有界窗口，以及明确的 `prometheus_query_range`、`kubernetes_events` 与 `kubernetes_logs` 时间参数。Session JSONL 仍是诊断事实的唯一来源；router 数据库只拥有 delivery 重放、排队/审计事实以及 fingerprint 到轮次的协调状态。

## 配置

`source` 选择一个 adapter 实例。`statePath` 和 `workspacePath` 必须为绝对路径（仅测试状态可使用 `:memory:`）。`agentPreset` 和 `permissionPreset` 控制 Session 组合。`alertnameAllowlist` 必须非空。`severityMap` 把 Provider label 映射到 `info`、`warning` 或 `critical`，未映射值会被过滤。`modelBudgets` 为每个 severity 设置单次最大输出 token 数。

`stormControl` 配置 fingerprint 冷却秒数、队列大小/时效、失败重试次数/退避、全局和分 severity 并发，以及全局和分 severity 的在途模型 Token 预留上限。单次 `modelBudgets` 必须能放入对应的 Token 上限，severity 并发不能超过全局并发。`diagnosisWindow` 设置锚点前后秒数、Prometheus 分辨率秒数，以及写入每个路由事件的 Pod 日志行数上限。

数据库职责与重启语义见[路由决策](../../docs/decisions/2026-09-06-alertmanager-session-routing.zh.md)，风暴控制与反馈边界见[阶段 E 决策](../../docs/decisions/2026-09-06-operator-feedback-storm-control.zh.md)。
