# Agent Note：只读 DSH AIOps 基础

状态：已实现

[English](2026-09-04-dsh-aiops-read-only-foundation.md) | 中文

## 问题

AIOps 产品需要多种实时运维证据、面向模型的调查工作流和持久事件状态。把所有关注点放进一个工具会耦合端点传输、模型 schema、持久化与未来 UI 工作；从自动修复起步还会在观测质量和审批策略获得证据前授予变更权限。该子系统需要一个符合插件架构且无需修改 `agent-loop` 即可演进的实用闭环。

## 决策

该子系统保持只读，在 `packages/aiops/` 下包含八个包：`dsh-aiops-http-read` 共享有界 GET 采集，但不拥有 capability；`dsh-aiops-alertmanager` 通过 HTTP API v2 提供带当前告警的 `ctx.alertmanager`；`dsh-aiops-prometheus` 通过 HTTP 提供带即时/范围 PromQL 的 `ctx.prometheus`；`dsh-aiops-kubernetes` 通过 kubectl 与 `ctx.subprocess` 提供带对象 get/list、Event 与有界非流式 Pod 日志的 `ctx.kubernetes`；`dsh-tool-aiops-observe` 负责七个面向模型的观测工具；`dsh-aiops-incident` 负责完整状态事件、投影与报告工具；`dsh-tool-aiops-history` 负责三个工作区范围的事件历史工具；`dsh-aiops` 是可安装 profile patch。

Alertmanager、Prometheus 与 Kubernetes 包都把 Service Definition 和当前唯一 Provider 合并在一起。这不是永久耦合：出现第二个 Provider、远程执行底座或需要独立版本化的传输时，应把实现迁入 Provider 包，同时保持抽象 Service 与 Consumer schema 不变。在此之前进行拆分只会增加没有独立演进职责的包。

所有采集工具在结构上都是只读的。Alertmanager Provider 只对当前告警发出 GET 请求；Kubernetes Consumer 不暴露原始命令或不受限参数，其 Provider 只构造固定的 get、list、Event 与有界非流式日志读取；Prometheus 也只暴露查询端点。部署仍负责端点 ACL、kubeconfig 与只读 RBAC。

每次接受的事件写入都在 `aiops/incident-state` 中携带完整当前 `AiopsIncidentState`。稳定的品牌化事件与证据 ID、证据引用检查、不可变事件 ID 和终态 `resolved` 都在追加前校验；Session 持久化会在写入前后各建立一次检查点。`aiopsIncident` 投影解码该持久事件并使用最后一个有效状态。

现有 Session 日志与投影栈负责该子系统的持久化。独立事件数据库不是权威来源，而且在具备维护中的运维手册语料库、访问规则、引用、时效策略与评测前不引入 RAG 流水线。SQLite 跨 Session 索引是基于 Session 事件的可重建读模型，具体由[事件历史决策](2026-09-05-aiops-cross-session-incident-history.zh.md)规定。

## 考虑过的替代方案

- **单体 AIOps 插件**——不采用，因为 Provider 传输、模型 API、持久状态与组合已经拥有不同的职责和测试。
- **立即拆分 Service Definition 与 Provider 包**——推迟到第二种实现使它们的发布节奏真正独立时。
- **从聚合日志、RAG、Portal 与自动修复起步**——推迟，因为当前调查闭环使用直接的有界 Pod 日志已经足够，而自动修复需要显式审批与策略设计。
- **使用新事件数据库作为事实来源**——第一版不采用，因为它会重复 Session 事件日志，并在存在跨 Session 查询需求前制造一致性问题。

## 结果

该 profile 可以调查当前告警、指标、Kubernetes 对象与 Event 以及有界 Pod 日志；持久化结构化结论；从 Session 日志恢复并搜索；并在不改变观测工具名的情况下增加后续 Provider。它不能查询聚合日志或变更历史、渲染专用 Portal、聚合事件分析，也不能执行建议。后续能力必须保持只读采集边界，或引入由显式审批治理的动作 capability，而不能直接向观测工具添加变更操作。
