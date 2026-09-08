# 路由策略 JSON 示例

[`routing-policy.example.json`](routing-policy.example.json) 是完整的 version 1 策略参考。在 Portal 中，把其中 `severityMap`、`modelBudgets` 和 `stormControl` 的值分别复制到同名 JSON 编辑框；`routingPolicy.ignoredAlertnames` 按每行一项填写，`routingPolicy.defaultSeverity` 通过选择框设置。

[`routing-policy-labels.example.json`](routing-policy-labels.example.json) 可直接复制到 dry-run labels 编辑框。请把示例 label 替换为一条标准化 Alertmanager 告警；dry-run 只校验并评估候选策略，不会入队或创建 Session。

预留值是上限而非使用目标。每个 `modelBudgets` 值必须同时小于等于对应的 `severityReservedTokens` 和 `globalReservedTokens`，每个 severity 并发值不能超过 `globalConcurrency`。
