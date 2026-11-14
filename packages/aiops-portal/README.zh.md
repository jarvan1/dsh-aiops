# @deepseek-ai/dsh-aiops-portal

[English](README.md) | 中文

DSH Web 中的 AIOps 工作台。集群视图依赖 `aiops-agents` 服务（bundle 已挂载），缺少该服务时无法组合。它注册始终可见的侧边栏 `AIOps` 入口，同时保留 Session 内的会话视图标签，并通过应用 Web Server 上固定的同源接口 `/api/aiops/portal` 汇总当前 Router 配置工作区内的最新诊断报告、对应人工反馈、路由审计、当前路由策略与策略变更审计。

Portal 不保存副本、不修改 Session，也不提供修复操作。插件自有事件存储（`ctx.aiopsIncidents`）仍是诊断真源，Router SQLite 仍是路由审计真源。接口最多扫描 `maxScanIncidents` 条已存事件，返回 `maxIncidents` 个最新事件和 `maxAuditRecords` 条审计记录；默认分别为 500、100 和 250。快照版本为 4，展示每条已存事件的 `revision` 与 `updatedAt`、最近路由绑定的集群，以及已注册的集群 agent 行。

全局工作台提供 `aiops-prometheus`、`aiops-alertmanager` 和版本化 `aiops-routing` namespace 的实时设置。两个 endpoint 候选值必须通过无副作用的服务端探测才能保存；Kubernetes 只走 agent，其连通性位于**集群**页，而不是凭据表单。路由策略只有在无副作用的标准化 labels dry-run 成功后，才以 settings revision fence 原子保存；Router 会在持久化前校验并发与 Token 上限的跨字段关系。提交后实时生效并持久审计。

**集群** 标签页管理集群 agent：为每个集群创建令牌，明文与安装步骤只展示一次，之后只显示集群状态（`pending`、`connected`、`offline`、`revoked`）、agent 版本与最近连接时间。全新安装时首页会显示首次配置卡片，提示创建令牌；启动时不会生成或记录任何令牌。只有从未连接过的集群才提供“重签”；连接之后只能吊销并重新创建。探测操作会实际走一次在线连接，并返回延迟、agent 版本与声明能力。已连接的集群提供**准备升级**：填写目标版本后 agent 进入 drain（状态显示“升级中”，新的 Kubernetes 读取失败转移），界面给出应执行的 `kubectl set image` 命令；替换 agent 连接后状态自动恢复。**恢复读取** 可在同一 agent 上取消已准备的发布。创建、重签、吊销与探测的 POST 都会拒绝跨站请求。

设置页显示已配置的 Alertmanager Webhook 地址，并只显示凭据是否存在。凭据值绝不会返回或保存在浏览器中；请通过部署 secret manager 或 `<DSH_HOME>/.credentials.yaml` 轮换并重启 DSH。当 Alertmanager 需要使用默认 `http://127.0.0.1:3081/alertmanager` 以外的地址时，设置 `AIOPS_WEBHOOK_PUBLIC_URL`。连接测试和 dry-run 的浏览器 POST 会拒绝跨站请求；整个 Web 表层仍必须置于部署方的 Host 认证边界之后。

该客户端模块当前仅支持 DSH Web。它在 `webServer` 可用时注册接口，因此不会破坏无 Host 的 headless 组合；隔离的 Alertmanager webhook listener 不提供此接口。

可复制的字段模板见[路由策略 JSON 示例](../../docs/examples/README.zh.md)；TLS、凭据轮换、配置迁移和发布验证见[生产部署与升级](../../docs/deployment.zh.md)。
