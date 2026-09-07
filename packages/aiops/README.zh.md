---
description: "为 DSH 表层添加 Alertmanager 驱动的只读诊断、持久事件路由与历史搜索的可安装 profile 层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-aiops

[English](README.md) | 中文

## 概述

本 bundle 为现有 DSH profile 添加 Alertmanager 驱动的只读 AIOps 工作流。它挂载专用 webhook listener、带持久队列/冷却/资源预算的 fingerprint router、随包发布的 `k8s-diag` skill、三个观测 Provider、七个观测工具、报告与反馈写入工具、五个工作区范围历史/审计工具，以及 Web Portal。随附 profile 默认都不包含它。启动需要 `ALERTMANAGER_URL`、`PROMETHEUS_URL` 和 `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`；Kubernetes 读取还需要 kubectl 与只读集群凭据。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

把当前 checkout 中的包添加到长期运行的 profile，然后提供数据端点、webhook 凭据和诊断 workspace：

```sh
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web add link:/path/to/dsh-aiops/packages/aiops
DSH_HOME=/path/to/profile-home AIOPS_ALERTMANAGER_WEBHOOK_SECRET=change-me AIOPS_WORKSPACE=/srv/aiops-workspace \
  ALERTMANAGER_URL=http://127.0.0.1:9093 PROMETHEUS_URL=http://127.0.0.1:9090 \
  pnpm dsh web
DSH_HOME=/path/to/profile-home pnpm dsh plugin --profile web remove @deepseek-ai/dsh-aiops
```

`AIOPS_ALERTMANAGER_WEBHOOK_SECRET` 也可以持久化在 DSH 的私有凭据文件 `<DSH_HOME>/.credentials.yaml` 中，而不必每次启动时导出。`cordis.patch.yml` 中的 `secretEnv` 仍只填写引用名，不填写密钥值：

```yaml
version: 1
refs:
  AIOPS_ALERTMANAGER_WEBHOOK_SECRET: replace-with-a-long-random-secret
records: {}
```

如果文件已经存在，只需合并 `refs` 条目，不要覆盖其他凭据；POSIX 系统上该文件必须保持仅属主可读写（`chmod 600`）。

plugin 命令会把本包及其依赖协调到 profile，并激活其声明的 `dsh.bundle.patch`。如果缺少 patch 声明或必需的 HTTP 端点，启动会明确失败，而不会运行不完整的 AIOps 工具集。

### 获得的能力

该层插入通用 webhook runtime、确定性 incident router、全局注册的 `k8s-diag` 指令、隔离 Alertmanager listener、三个观测 Provider、观测/报告/反馈/历史工具，以及只读 `AIOps` Web 标签。`AIOPS_WORKSPACE` 选择诊断 Workspace 与 Portal 的固定服务端范围。Bundle 把路由状态、队列与审计保存在 Harness home 下的 `aiops-router.sqlite`，把可丢弃历史索引保存在 `aiops-incidents.sqlite`。默认风暴策略包含 60 秒 fingerprint 冷却、100 项/15 分钟队列、3 次尝试、全局 4 个在途 turn，以及 severity 并发/Token 预留上限。

Alertmanager webhook receiver 需要发送带 `Authorization: Bearer <secret>` 的 JSON。可选的 `X-DSH-Delivery-ID` 提供由发送方控制的重试 identity；未提供时使用已认证请求体摘要。随附策略接受 [`cordis.patch.yml`](cordis.patch.yml) 中列出的高信号 alertname，映射 severity，并应用分级模型与风暴控制预算；后续 profile patch 可以替换这些策略值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

该 patch 是后置 profile 层：它插入 AIOps 行 ID，并有意替换 base 的 session-query 配置以启用全文搜索。Provider 行位于 Consumer 之前，Cordis 注入也会让 Consumer 等待所需 Service 可用。资源上限是显式 bundle 值，后续用户 patch 仍可通过替换完整行配置来覆盖它们。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 入口、路由/时间策略、随包 skill、诊断 Provider 与工具，以及派生索引启用 |
| [`src/index.ts`](src/index.ts) | 空模块入口；manifest 声明的 patch 是本包的运行时实质 |
| — | 不发布 invariant companion，因为 bundle 只负责组合；插入的包各自约束其关系 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 包导航](../README.zh.md)——本层提供的各个包。
- [AIOps 子系统](../../docs/aiops.zh.md)——架构与第一版边界。
- [DSH Profile 启动](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.zh.md)——bundle 顺序与用户 patch 语义。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

通过本 patch 层插入的 `k8s-diag` skill、观测、事件与事件历史包间接生效；这些包负责指令、工具 schema 与结果。

#### KV 缓存影响

添加或移除该层会改变可见工具 schema 前缀；只改变 Provider 环境值不会改变 schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **该层需要现有应用 profile**——它不包含 `dsh-base`、LLM Provider 或任务运行器。
- **Listener 不提供 TLS**——保持默认 loopback 绑定并放在 TLS 反向代理之后；如果明确绑定全部接口，需要用网络策略保护。
- **环境支持的端点属于启动配置**——更改后需要重启 profile，因为本层面向仅启动时加载的 headless 表层。
- **只读凭据仍由部署负责**——bundle 无法证明外部 Alertmanager/Prometheus ACL 或 Kubernetes RBAC 权限。
- **索引路径由单一进程拥有**——不要让另一个正在运行的 Session Query Provider 指向同一个 `aiops-incidents.sqlite` 文件。
