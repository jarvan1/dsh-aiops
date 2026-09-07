# 阶段 E：追加式反馈与持久告警风暴控制

[English](2026-09-06-operator-feedback-storm-control.md) | 中文

状态：接受

## 决策

值班人员对诊断的确认、修正或否定写成独立的 `aiops/operator-feedback` Session 事件。事件引用当时报告的 `incidentId` 和 `reportSeq`，不会改写或删除 `aiops/incident-state`。只有当前用户明确表达 verdict 后，Agent 才能调用反馈工具；告警恢复、模型置信度或后续观测都不能被自动解释为反馈。

Router 在创建 Agent 前把符合策略的告警持久化到 SQLite 队列，并执行以下控制：

- 同一 `(source, fingerprint, lifecycle status)` 的就绪项合并为一个模型 turn；
- fingerprint 冷却跨进程重启保留；
- critical 优先，同 severity 按接收时间 FIFO；
- 全局与分 severity 并发、全局与分 severity 在途输出 Token 预留同时生效；
- 队列容量、最长等待时间和失败重试次数均有上限；
- 进程启动时将遗留的 `processing` 工作恢复为 `queued`。

过滤、分组、延迟、丢弃、启动、完成和失败 transition 都写入 `route_audit`。Router 数据库只负责协调与审计；已接受的告警、模型消息、工具结果、事件报告和反馈仍以 Session JSONL 为诊断真源。工作区历史工具只读暴露反馈与路由审计，并以精确 `cwd` 限制访问。

## 理由

直接修改既有报告会丢失诊断当时的判断，无法区分模型结论与人工复核。仅在内存中限流则会在重启时重复启动 Agent 或丢失排队工作。将准入事实先落盘，并把 Token 作为并发预留而非事后估算，可以在没有 Provider 计费 API 的情况下提供确定性上界和可重放测试。

## 后果

- `modelBudgets` 表示单个诊断 turn 的最大输出；`stormControl.*ReservedTokens` 表示在途预留上限，不是实际账单。
- 队列已满或过期时允许明确丢弃，但必须留下 reason；调用方可以从历史工具审计。
- 同 fingerprint 分组减少重复模型调用，但每个 delivery 仍产生自己的路由事件并参与报告上下文。
- 本阶段不发送通知，不自动修复，也不把反馈用于在线自学习。

## 未采用方案

- **改写最新报告保存反馈**：破坏报告审计链，无法准确复盘。
- **只依赖 Alertmanager group interval**：无法覆盖多个入口、进程重启和模型侧资源竞争。
- **仅使用全局并发数**：不能防止低价值或大 Token turn 挤压 critical 工作。
- **把 router SQLite 作为事件数据库**：会与 Session 真源形成双写一致性问题。
