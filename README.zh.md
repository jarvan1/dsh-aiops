# DSH AIOps

[English](README.md) | 中文

`dsh-aiops` 是独立构建的、由 Alertmanager 驱动的 DSH 只读 Kubernetes 事件诊断 bundle，提供认证 webhook 入口、带持久队列和资源预算的 fingerprint 到 Session 路由、告警时间锚查询窗口、随包发布的 `k8s-diag` skill、Alertmanager、Prometheus 与 Kubernetes 观测能力、结构化事件报告、追加式值班反馈、工作区范围历史/路由审计，以及 DSH Web 内的专用 AIOps Portal。

本地开发通过相邻的 `deepseek-harness` checkout 提供 package overrides。源码使用正常 package exports 解析，不使用 DSH 的 TypeScript paths。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run pack:bundle
```

本地开发时，从 checkout 中的包把 bundle 安装到 DSH profile：

```sh
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web add link:/path/to/dsh-aiops/packages/aiops
```

发布部署从 registry 安装 `@deepseek-ai/dsh-aiops`。CLI 会把 `@deepseek-ai/dsh-aiops/cordis.patch.yml` 添加到 profile 的 base 与应用层之后。`PROMETHEUS_URL` 和 `ALERTMANAGER_URL` 是可选的组合层默认值，也可以在 AIOps 数据源设置中实时保存或覆盖；`AIOPS_WORKSPACE` 和 `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` 凭据用于配置自动化工作流。Webhook listener 默认位于 `127.0.0.1:3081/alertmanager`；Kubernetes 使用配置的 `kubectl` 命令和部署侧只读凭据。

在 Web profile 中，左侧栏底部始终显示 `AIOps` 入口，可以从任意页面打开全局 Portal；非空 Session 中仍保留 `AIOps` 会话标签。Portal 固定读取 `AIOPS_WORKSPACE`，不会以当前聊天 Session 的工作区扩大查询范围。在 Portal 中保存的 Prometheus 与 Alertmanager URL 会写入 DSH 用户设置并立即生效。

Delivery 生命周期见 [AIOps 子系统说明](docs/aiops.zh.md)，已完成与后续阶段见 [路线图](docs/roadmap.zh.md)。

DSH 主仓库继续拥有通用 Session、查询、Workflow、权限与运行时能力。本仓库只拥有 AIOps 领域包和 bundle。
