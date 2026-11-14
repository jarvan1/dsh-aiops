# 把 AIOps 事件状态迁入插件自有存储域

[English](2026-11-14-aiops-plugin-owned-incident-store.md) | 中文

- **状态：** 已采纳
- **日期：** 2026-11-14
- **上下文：** DSH 0.2.2-rc.1

## 背景

在此变更之前，面向模型的 `aiops_incident_report` 工具通过 `appendPluginRecord` 把每份报告持久化为 Session 插件记录（`plugin:aiops/incident-state`），操作员反馈则记为 `plugin:aiops/operator-feedback`。Session 投影把这些事件重放为 `aiopsIncident` / `aiopsIncidentFeedback` 当前状态，Portal、历史工具、推送与既往诊断复用读取投影或原始事件。

针对 DSH 0.2.2-rc.1 的真实环境 E2E 回归暴露：fixture 中全部十二次报告调用都失败了。其中十一次报 `Receiver must be an instance of class Session`：`appendPluginRecord` 转发到 `session.#appendRecord`，这是类私有方法，其 brand 校验会拒绝由另一份 `dsh-session` 副本创建的接收者。Host（`npx` 依赖树）与插件（workspace `pnpm` store）合法地加载了不同的模块实例，因此对以外部方式部署的插件，这次调用永远无法成功。剩余那次是正确拒绝了一份首报就声称 `resolved` 的报告。

官方插件开发实践给出了同一边界：`appendPluginRecord` “保留给 DSH 的实验性包”，公开的 `session.append()` 无法设置 `ignorable: true`，插件应“从已有事件派生状态，或把插件自有数据保存在通过检查发现的存储服务中”。依赖私有 brand 的插件只有在部署恰好把 `dsh-session` 去重成单一模块实例时才能工作——这是巧合，不是契约。

## 决策

外部 AIOps 状态迁入挂载在 Host 存储栈上的插件自有存储域：

- `aiops_incident`（`per-record` JSON 布局）：每个 Session 一份文档，保存带单调 `revision` 的最新完整事件报告，另有一张只追加的反馈表。`ctx.aiopsIncidents` 服务校验生命周期连续性、等介质持久化后才返回，并发出 `aiopsIncidents/changed`。
- `aiops_delivery`（`per-record` JSON 布局）：每个 Session 的最新终态推送决策，取代原先的 `plugin:aiops/delivery` Session 记录。

两个域都为其表声明 zod schema，因此每条记录都在持久边界被校验，无法读取的记录会被备份并跳过（`invalidRecords: 'backup-and-skip'`），而不会阻塞启动。Session 日志保留完整诊断叙事——路由告警、观测、模型消息、工具调用——不再承载结构化事件状态。

消费方随之调整：

- Portal 同步读取存储，并把最新反馈与事件 `revision` 对齐；快照版本升为 3。
- `dsh-tool-aiops-history` 读取存储，把读取限制在调用方工作区，并以 `(sessionId, revision)` 引用。
- `aiops-delivery` 订阅 `aiopsIncidents/changed`，把标记持久化到 `aiops_delivery`。
- 既往诊断复用改为扫描 `listResolved(workspace, maxScanRecords)`，不再读 Session 历史。
- Router 的确定性恢复收尾通过同一存储与生命周期校验写入。

## 曾考虑的替代方案

- **自带一份 `dsh-session` / 继续使用 `appendPluginRecord`。** 只要 Host 加载自己的副本（`npx` 与容器部署的默认情况）就会失败于私有 brand 校验。不可移植。
- **通过 `session.append` 追加非 ignorable 事件。** 目前可用，但恢复时会重放进模型上下文，改变 Session schema 契约，也无法表达插件自有标记语义。
- **在 `DSH_HOME` 下自建 SQLite。** 持久且可查询，但重复了 DSH 已随包提供的存储层，绕开 Host 的 schema/备份语义，并增加第二套迁移面。
- **继续用 Session 投影作为派生事件之上的读模型。** 不可行：私有写入路径消失后，已不存在可投影的持久事件。

## 后果

正面：

- 无论 Host 与插件依赖树如何解析，事件路径都能工作；E2E 在 `<DSH_HOME>/storages/aiops_incident/` 下写入了持久事件文档。
- 结构化状态在加载与写入时都经 schema 校验，并对漂移提供显式的“备份并跳过”恢复。
- 推送标记天然跨重启存活；原 Session 记录标记虽也如此，但依赖同一条私有路径。
- 消费方共享一个同步、按工作区限定的读取 API，而不是重放事件或查询 SQLite。

负面 / 已接受的代价：

- 部署方必须把 `<DSH_HOME>/storages/` 与 Session workspace、SQLite 一起备份；部署指南已记录。
- 事件状态与 Session 叙事不再同址，需要两者兼顾的审计必须按 Session id 关联。
- 存储是单写者域：写入排在域的写链上，报告的 revision 在那里分配，而不是由事件顺序决定。

## 验证

迁移通过以下方式验证：workspace 测试套件（25 个测试文件、179 个测试，一个需真实集群的 opt-in 测试跳过），其中新增的存储测试运行在真实存储组合上（报告/revision、转换校验、重开后持久性、工作区隔离、反馈幂等与过期 revision 拒绝）；事件包与历史包的真实 Loader 组合测试；以及针对 DSH 0.2.2-rc.1 的 k3s + Alertmanager E2E，产出了持久事件文档、resolved 生命周期收尾与按工作区限定的 Portal 读取。
