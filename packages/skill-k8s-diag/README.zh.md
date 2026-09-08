# @deepseek-ai/dsh-aiops-skill-k8s-diag

[English](README.md) | 中文

面向告警时间锚、通用 Alertmanager 告警只读诊断的版本化 `aiops-diag` 指令包。为保持安装兼容性，包名仍是 `dsh-aiops-skill-k8s-diag`；插件会把 `aiops-diag` 全局注册到 DSH skill registry，因此诊断 Session 切换到任意 Workspace 后仍可加载。

工作流消费 `dsh-aiops-incident-router` 生成的精确时间上下文，根据现有标签选择 Alertmanager、Prometheus、服务或 Kubernetes 证据分支，检验不同场景的假设，并通过 `aiops_incident_report` 持久化完整报告。Kubernetes 是可选证据源而非默认假设，工作流不会授权任何基础设施变更。
