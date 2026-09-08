# @deepseek-ai/dsh-aiops-skill-k8s-diag

English | [中文](README.zh.md)

Packaged, versioned `aiops-diag` instructions for alert-time-anchored, read-only diagnosis of general Alertmanager alerts. The package name remains `dsh-aiops-skill-k8s-diag` for installation compatibility, while the plugin registers `aiops-diag` into the DSH skill registry globally so diagnostic Sessions can load it regardless of their Workspace path.

The workflow consumes the exact time context emitted by `dsh-aiops-incident-router`, selects Alertmanager, Prometheus, service, or Kubernetes evidence branches from available labels, tests scenario-specific hypotheses, and persists a complete report through `aiops_incident_report`. Kubernetes is optional rather than assumed, and the workflow never authorizes infrastructure mutation.
