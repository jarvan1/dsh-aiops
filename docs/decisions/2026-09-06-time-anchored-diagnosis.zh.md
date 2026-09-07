# 时间锚诊断与随包 Kubernetes skill

状态：已接受，2026-09-06

## 背景

Alertmanager 通知包含 `startsAt`，但阶段 C 只把它作为标准化告警中的一个字段暴露。Agent 因此可能在执行时选择相对“最近 15 分钟”的查询；延迟投递、重启或重放会让同一个告警发生点检查到不同证据。仅放在仓库中的 skill 也会在 `AIOPS_WORKSPACE` 指向运维人员选择的其他目录后消失。

## 决策

- `dsh-aiops-incident-router` 写入 `aiops/alert-routed` v2，从 `alert.startsAt` 派生规范 T0 和明确的有界观测窗口。
- 窗口从 T0 减去配置的前视范围开始，终点采用 delivery 接收时间，并限制在 T0 与配置的告警后范围之间。这样既不查询未来，也不会让延迟通知无限放宽窗口。
- 事件包含 Prometheus range、Kubernetes Event 与 Pod 日志的工具形状参数。同一对象出现在模型可见 follow-up 中，并能随 Session 重放恢复。
- Kubernetes Event 读取接受闭区间绝对边界，保留发生区间与窗口重叠的 Event。Pod 日志读取接受绝对下界；由于 Kubernetes 没有服务端日志结束时间，指定上界时会强制时间戳，并在本地移除更晚或无时间戳的行。
- `k8s-diag` 是发布在 `@deepseek-ai/dsh-aiops-skill-k8s-diag` 中的版本化 `SKILL.md`。其插件把指令注册到 DSH 全局 skill 层，因此诊断 Workspace 变化后仍然可用。
- Skill 只允许只读证据收集，要求假设引用证据并写入完整 `aiops_incident_report`，同时覆盖首批高信号告警场景。

## 结果

同一 delivery 在重启或无模型 key 重放后会重建相同诊断时间参数。运维人员只需调整 router 策略，而不依赖提示词解释。Event 和日志上界过滤发生在有界 kubectl 响应之后；请求上界时，无时间戳日志行会被排除。Bundle 增加一个包，并依赖 DSH 已提供的宿主 skill registry。

观测窗口描述 delivery 被接收时可获得的证据。后续 firing delivery 会在配置范围内扩展它自己的终点，但不会重写更早的 Session 事实。历史 Event 保留和 Pod 日志轮转仍可能让证据不可用，报告必须明确说明这种缺口。
