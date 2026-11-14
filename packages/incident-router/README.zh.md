# @deepseek-ai/dsh-aiops-incident-router

[English](README.md) | 中文

面向 DSH AIOps 的持久 Alertmanager fingerprint 路由。该服务注册一个可信的 `alertmanager` webhook rule，默认接受任意 alertname，仅应用显式噪声排除与 severity 归一化，在 SQLite 中串行化路由决策，并驱动确定性的诊断 Session identity。

## 生命周期

- 第一个被接受的 firing 告警创建第 1 轮。
- 后续 firing 通知追加到同一个 Session。
- resolved 通知追加到该 Session，并把告警表达式标记为已恢复；模型被明确要求不要自行关闭 AIOps 事件。该恢复轮次结束后，Router 会确定性地追加携带原状态的 `resolved` 事件状态并附一条 `alert-recovery-*` 证据——幂等执行，且仅在存在报告且尚未 resolved 时写入。
- resolved 之后再次 firing 会创建下一轮和新的 Session。
- 完全相同的 delivery 重试是幂等的。使用不同认证内容复用发送方提供的 delivery id 会失败。
- 并发的首批通知合并到一个确定性 Session；SQLite `BEGIN IMMEDIATE` 串行化 fingerprint 状态变更。
- 同一 fingerprint 的待处理通知按 lifecycle status 分组为一次模型 turn；状态不同的通知保持顺序。
- 进程重启后，处理中工作会恢复为队列项，相同的 SQLite 映射会先恢复已持久化的 Session，再追加下一条通知。

每个轮次绑定一个集群 agent：Router 读取告警的 cluster label（`clusterLabel`，默认 `cluster`），并把名称与轮次一起持久化；label 缺失时回退到 `defaultCluster`，label 值非法时不绑定任何集群，而不是回退。首轮提示会声明绑定的集群，`clusterForSession()` 供观测工具解析该名称，因此一次诊断只能读取它的告警所指集群。升级前已存在的轮次会采纳它看到的第一个可用绑定。

每个符合策略的告警会在创建 Agent 前持久化。Router 按 fingerprint 冷却、全局/分 severity 并发、全局/分 severity Token 预留上限和队列容量决定立即启动、延迟或丢弃；critical 优先，同等级保持 FIFO。每次过滤、分组、延迟、丢弃、启动、完成或失败均写入审计。每个最终被接受的决策都会先写入可忽略的 `aiops/alert-routed` v2 Session 事件，再发送模型可见的 follow-up。事件把 `alert.startsAt` 投影为规范 T0、有界窗口，以及明确的 `prometheus_query_range`、`kubernetes_events` 与 `kubernetes_logs` 时间参数。Session JSONL 仍是诊断叙事；router 数据库拥有 delivery 重放、排队/审计事实以及 fingerprint 到轮次的协调状态；结构化事件状态位于 `aiops_incident` 存储域。

每个模型 turn 都会读取 DSH 持久化的 `locale.preference`，要求 Agent 使用该语言编写面向用户的说明和持久化事件报告文本。Host 偏好未设置或不可用时回退为英文，与 DSH Host 侧 locale fallback 一致；标识符与观测值保持原样。

恢复轮次结束后，Router 会在插件自有事件存储（`ctx.aiopsIncidents`）中以确定性方式关闭生命周期：若最近存储的报告尚未 `resolved`，则以携带原状态的 `resolved` 状态写入，并附一条 `alert-recovery-<receivedAt>` 证据。该写入幂等，并与模型自己的 `aiops_incident_report` 共用同一 schema 与生命周期校验。

当 firing 告警打开新一轮时，Router 会附加诊断复用上下文：通过事件存储在本工作区有界的已 resolved 记录中（`history.maxScanRecords`，默认 200），寻找报告文本提及指纹身份 token 的最新事件，并在首轮提示词中列出其首要假设与建议，作为需对照新证据确认或舍弃的线索。事件存储缺失或读取失败时复用被静默跳过；追加轮次和恢复轮次不会查询；复用不产生写入——新轮次仍从全新报告开始。

## 配置

`source` 选择一个 adapter 实例。`statePath` 和 `workspacePath` 必须为绝对路径（仅测试状态可使用 `:memory:`）。`agentPreset` 和 `permissionPreset` 控制 Session 组合。`clusterLabel` 指定用于选择集群 agent 的告警 label，必须是 Prometheus 风格的 label 名；`defaultCluster` 是回退的 agent 名称（空表示不设置），设置时必须是合法的小写 DNS label。`routingPolicy.ignoredAlertnames` 是仅用于已确认噪声的精确匹配列表；空列表接受所有 alertname。`severityMap` 不区分大小写地把 Provider label 映射到 `info`、`warning` 或 `critical`；缺失或未知值使用 `routingPolicy.defaultSeverity`。`modelBudgets` 为每个 severity 设置单次最大输出 token 数。

`stormControl` 配置 fingerprint 冷却秒数、队列大小/时效、失败重试次数/退避、全局和分 severity 并发，以及全局和分 severity 的在途模型 Token 预留上限。单次 `modelBudgets` 必须能放入对应的 Token 上限，severity 并发不能超过全局并发。`diagnosisWindow` 设置锚点前后秒数、Prometheus 分辨率秒数，以及写入每个路由事件的 Pod 日志行数上限。

运行时 Router 会在组合值之上注册 `aiops-routing` version 1 设置。Portal 对噪声排除、severity 归一/默认值、模型预算、冷却、队列、并发和预留的修改会先校验并使用 revision fence，随后实时生效，并写入不含 secret 的 `routing_policy_audit`。`dryRun()` 只评估标准化 labels，不写队列、审计或 Session。包含旧 `alertnameAllowlist` 的 F.2 前 profile 仍能以安全通用默认值启动并输出弃用警告；升级后应把旧字段替换成显式 `routingPolicy`。

数据库职责与重启语义见[路由决策](../../docs/decisions/2026-09-06-alertmanager-session-routing.zh.md)，风暴控制与反馈边界见[阶段 E 决策](../../docs/decisions/2026-09-06-operator-feedback-storm-control.zh.md)。
