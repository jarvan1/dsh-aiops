# DSH AIOps

[English](README.md) | 中文

`dsh-aiops` 是独立构建的、由 Alertmanager 驱动的 DSH 通用只读事件诊断 bundle，提供认证 webhook 入口、带持久队列和资源预算的 fingerprint 到 Session 路由、告警时间锚查询窗口、随包发布的 `aiops-diag` skill、动态选择的 Alertmanager、Prometheus 与 Kubernetes 观测能力、结构化事件报告、追加式值班反馈、工作区范围历史/路由审计，以及 DSH Web 内的专用 AIOps Portal。

## 兼容版本与安装

当前源码 bundle 基于以下版本完成构建与测试：

| 组件 | 适配版本 |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.2-rc.1` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| pnpm | `11.7.0`（需要 `>=10` 的 Git prepare 脚本放行语义） |

直接把 GitHub 仓库安装到 DSH Web profile：

```sh
dsh plugin --profile web add github:jarvan1/dsh-aiops
```

如果没有全局 `dsh` 命令，可使用适配版本的 CLI：

```sh
npx -y @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add github:jarvan1/dsh-aiops
```

pnpm 10 及更高版本会在首次安装时阻止 Git 依赖的 `prepare` 构建。失败信息会输出一个包含实际仓库与 commit 的 `allowBuilds` 条目；请把该**精确键值**复制到 `<DSH_HOME>/profiles/web/pnpm-workspace.yaml`（默认通常为 `~/.dsh/profiles/web/pnpm-workspace.yaml`），然后重新执行安装命令。它的形式如下：

```yaml
allowBuilds:
  'dsh-aiops@https://codeload.github.com/jarvan1/dsh-aiops/tar.gz/<resolved-commit-sha>': true
```

不要把 pnpm 输出的键简化成 `dsh-aiops`；该授权会被有意绑定到具体 Git 来源和 revision。

生产环境建议固定 release tag 或 commit，例如 `github:jarvan1/dsh-aiops#<commit-sha>`。安装完成后重启 DSH。

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

GitHub 安装使用仓库根 bundle 和相对路径构建产物；未来也可以从 registry 安装 `@deepseek-ai/dsh-aiops`。两种形式都会把 AIOps patch 添加到 profile 的 base 与应用层之后。`PROMETHEUS_URL`、`ALERTMANAGER_URL`、`KUBECONFIG` 和 `KUBERNETES_CONTEXT` 是可选的组合层默认值，也可以在 AIOps 数据源设置中实时保存或覆盖；`AIOPS_WORKSPACE` 和 `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` 凭据用于配置自动化工作流。Webhook listener 默认位于 `127.0.0.1:3081/alertmanager`；当 Alertmanager 无法访问该回环地址时，用 `AIOPS_WEBHOOK_PUBLIC_URL` 设置它应使用的地址。Kubernetes 使用官方 Node 客户端和部署侧只读 kubeconfig 凭据，不要求安装 `kubectl`。

在 Web profile 中，左侧栏底部始终显示 `AIOps` 入口，可以从任意页面打开全局 Portal；非空 Session 中仍保留 `AIOps` 会话标签。Portal 固定读取 `AIOPS_WORKSPACE`，不会以当前聊天 Session 的工作区扩大查询范围。Prometheus/Alertmanager URL 以及服务端 kubeconfig 路径/context 会写入 DSH 用户设置并立即生效。三个数据源都必须通过连通性测试，Kubernetes 还会验证最低只读 RBAC 权限。

同一工作台还可管理版本化路由策略。粘贴的标准化 label 必须先完成 dry-run，才能以 settings revision fence 原子保存完整策略；变更立即生效并持久审计。Webhook 凭据始终留在服务端，Portal 只返回是否已配置。

Delivery 生命周期见 [AIOps 子系统说明](docs/aiops.zh.md)，Host/TLS/轮换边界见[生产部署与升级](docs/deployment.zh.md)，真实集群验证见[可重复 Alertmanager/k3s 矩阵](deploy/alertmanager/README.zh.md)，已完成与后续阶段见[路线图](docs/roadmap.zh.md)，重要变更见 [Changelog](CHANGELOG.md)。

DSH 主仓库继续拥有通用 Session、查询、Workflow、权限与运行时能力。本仓库只拥有 AIOps 领域包和 bundle。
