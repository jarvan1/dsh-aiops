# Alertmanager 通知使用持久确定性 Session 路由

[English](2026-09-06-alertmanager-session-routing.md) | 中文

日期：2026-09-06

状态：已实现

## 决策

Alertmanager adapter 负责 HTTP 方法、媒体类型、Bearer 认证、字节与批次上限、Provider 字段校验和标准化 delivery 构造。它只通过通用 DSH webhook runtime 分发经过认证的 `alertmanager` 事件。

AIOps incident router 负责高信号策略和一个 SQLite 协调数据库。`(source, fingerprint)` 标识当前告警轮次；source、fingerprint 与轮次的 SHA-256 生成 DSH Session ID，因此即使进程在路由完成后、Session 发布前崩溃，也能在不分配另一个 identity 的情况下修复。SQLite immediate transaction 串行化状态变更；进程内 Promise 表合并相同 identity 的竞争 Agent 创建。

首次 firing 通知创建第 1 轮。后续 firing 与 resolved 通知追加到该 Session。resolved 后再次 firing 会增加轮次并创建新 Session。进程重启后，router 恢复持久化 Session。完全相同的 delivery 重试保持第一次的逐告警结果，即使之后路由策略发生变化也不会改变；使用不同认证内容复用 delivery id 会失败。

每个被接受的路由都会在模型可见 follow-up 之前作为 `aiops/alert-routed` 写入 Session JSONL。该事件携带标准化告警和决策。被过滤的告警只保留审计行，不启动 Agent。Router 数据库只对重放与路由协调具有权威性；它不是事件数据库，也不能替代 Session 历史。

## 影响

- Alertmanager 重试不会创建重复的诊断 Session。
- 告警表达式恢复与事件关闭仍是不同事实。
- Bundle 的入口 WebServer 经过隔离，可以与 Web 应用并存。
- 明确绑定全部接口时，部署仍必须提供 TLS、网络策略和密钥轮换。
- 未来采用多进程 router 前，必须用共享事务协调器替换本地 SQLite 单写者假设。
