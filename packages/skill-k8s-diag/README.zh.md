# @deepseek-ai/dsh-aiops-skill-k8s-diag

[English](README.md) | 中文

面向告警时间锚、只读 Kubernetes 诊断的版本化 `k8s-diag` 指令包。插件把随包发布的 `SKILL.md` 全局注册到 DSH skill registry，因此诊断 Session 切换到任意 Workspace 后仍可加载。

工作流消费 `dsh-aiops-incident-router` 生成的精确时间上下文，收集有界 Kubernetes 与 Prometheus 证据，检验不同场景的假设，并通过 `aiops_incident_report` 持久化完整报告。它不会授权任何基础设施变更。
