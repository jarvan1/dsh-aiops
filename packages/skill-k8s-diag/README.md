# @deepseek-ai/dsh-aiops-skill-k8s-diag

English | [中文](README.zh.md)

Packaged, versioned `k8s-diag` instructions for alert-time-anchored, read-only Kubernetes diagnosis. The plugin registers the bundled `SKILL.md` into the DSH skill registry globally, so diagnostic Sessions can load it regardless of their Workspace path.

The workflow consumes the exact time context emitted by `dsh-aiops-incident-router`, collects bounded Kubernetes and Prometheus evidence, tests scenario-specific hypotheses, and persists a complete report through `aiops_incident_report`. It never authorizes infrastructure mutation.
