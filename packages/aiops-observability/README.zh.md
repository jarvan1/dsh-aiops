---
description: "DSH AIOps 运行时的低基数健康、就绪与 Prometheus 遥测。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-observability

[English](README.md) | 中文

该 Cordis 服务提供不含告警派生标签的产品级运行信号：

- `GET|HEAD /api/aiops/healthz` 报告进程存活。
- `GET|HEAD /api/aiops/readyz` 仅在 Alertmanager 入口与事件 Router 都完成注册后返回 `200`；否则返回 `503` 和有界的组件状态。
- `GET|HEAD /api/aiops/metrics` 以 Prometheus 文本格式返回 webhook 结果、队列深度与最老项时效、分组/延迟/丢弃工作、活动诊断、模型 Token 预留、调度失败和诊断延迟。

所有指标标签值都来自固定枚举。指标刻意不包含 alertname、fingerprint、delivery ID、Session ID、URL、namespace 或其他无界值。计数器和延迟桶属于进程生命周期遥测；持久路由事实与审计仍由 incident-router SQLite 保存。

## 配置

`healthPath`、`readinessPath` 和 `metricsPath` 可以替换三个默认路径。每个值都必须是互不相同的绝对非根精确路径，且不能包含尾随斜杠、query 或 fragment。

## 集成

该服务提供 `ctx.aiopsTelemetry`。Alertmanager adapter 记录每个请求的单一有界结果并标记入口就绪；事件 Router 记录队列转换、调度失败、诊断延迟与当前 gauge，并标记 Router 就绪。

完整运行流程和安全边界见 [AIOps 子系统](../../docs/aiops.zh.md)。
