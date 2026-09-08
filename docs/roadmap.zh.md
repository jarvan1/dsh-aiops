# DSH AIOps 路线图

[English](roadmap.md) | 中文

更新时间：2026-09-08

## 已完成

- 阶段 A：DSH Session Query 事件文本提取扩展，AIOps 自己拥有领域提取器。
- 阶段 B：独立 `dsh-aiops` workspace、初始八包 bundle 系列，以及本地安装、构建、测试、打包与卸载流程。
- 阶段 C：新增入口与路由两个包，使 workspace 达到十个包；实现认证 Alertmanager v4 入口、有界载荷标准化、稳定 fingerprint 派生、精确 delivery 重放防护、持久 fingerprint/轮次/Session 映射、高信号 alertname 与 severity 策略、确定性创建/追加/恢复/再触发、并发合并、进程重启后恢复，以及可审计的 `aiops/alert-routed` Session 事件。
- 阶段 D：`aiops/alert-routed` v2 携带规范 `startsAt` T0 和有界可重放窗口；明确的 Prometheus、Kubernetes Event 与 Pod 日志时间参数；Event 和日志闭区间上界过滤；新增第十一个包，在切换 Workspace 后仍全局注册版本化诊断指令（现暴露为 `aiops-diag`）；场景指南；无模型 key 的告警到报告 Session 重放；以及一次真实只读 CrashLoopBackOff Provider 演练。
- 阶段 E：新增追加式 `aiops/operator-feedback` 事件和确认、修正、否定工具；按 source/fingerprint 持久分组与冷却；有界可恢复队列；全局及 severity 并发与模型 Token 预留上限；延迟、分组、丢弃、启动、完成和失败审计；以及工作区范围的反馈和路由审计查询。突发、重启恢复、队列饱和、冷却和反馈重放均有确定性测试覆盖。
- 阶段 F：新增第十二个双面包 `dsh-aiops-portal`；在 DSH Web 注册常驻侧边栏入口和原生 Session `AIOps` 视图；提供持久化且实时生效的 Prometheus 与 Alertmanager 地址设置；用固定同源只读接口汇总 Router 配置工作区；提供事件/活跃/严重/复核概览、结构化搜索与筛选、事件主从详情、人工反馈、路由审计、空白/加载/错误状态、手动及 30 秒刷新和响应式布局。Portal 不新增数据库，也不接受客户端工作区参数。
- 阶段 F.1：默认 Kubernetes Provider 改用官方原生客户端直接读取 kubeconfig，不再要求主机安装 `kubectl`，同时保留显式兼容子路径。Portal 持久化服务端 kubeconfig 路径/context，并以 API 身份及 Pod、Event、Pod 日志 RBAC 检查作为保存门槛；kubeconfig 内容和凭据不会进入浏览器。
- 阶段 F.2：路由从 alertname 白名单模式改为通用模式。默认接受所有 alertname，精确噪声排除为可选配置，未知或缺失的 severity label 使用配置的回退值；全局注册的 `aiops-diag` 工作流根据现有标签动态选择 Alertmanager、Prometheus、服务和 Kubernetes 证据分支。

阶段 D 默认验证覆盖 17 个通过的测试文件和 108 个通过的测试，另有一个按需真实集群测试，并通过 skill 结构校验、相对文档链接、全部十一个 package tarball，以及隔离 DSH Web profile 的安装、配置 dump、真实启动和卸载检查。真实演练使用产品 Kubernetes Provider 读取一个现有 CrashLoopBackOff Pod、绝对窗口 Event、当前与 previous 有界日志，全程没有修改集群。

阶段 E 默认验证覆盖 17 个通过的测试文件和 118 个通过的测试，另有一个按需真实集群测试；完整 TypeScript 构建、相对文档链接、bundle tarball，以及四个受影响 package 的 tarball 内容检查均通过。

阶段 F 默认验证覆盖 19 个通过的测试文件和 128 个通过的测试，另有一个按需真实集群测试；完整 TypeScript 构建、Portal Host/Web 双产物、自包含 Host 入口回归、全局侧边栏/会话视图注册回归、Provider 实时设置测试、相对文档链接、Portal 与 bundle 的 tarball 内容检查，以及不提供数据源环境变量的隔离 DSH Web profile 真实启动和 Portal API 读取均通过。

阶段 F.1 验证包含本地模拟 Kubernetes API 演练，覆盖 kubeconfig 加载、namespace 原生对象读取、精确绝对时间 Pod 日志、版本探测和三项 SelfSubjectAccessReview，并覆盖 Portal 保存门槛与 RBAC 失败场景。

阶段 F.2 验证覆盖已配置噪声排除、任意 alertname、缺失/未知 severity 回退、severity 映射大小写归一、动态证据源指令、skill 注册和包级 TypeScript 检查。

## 下一步：阶段 F.3——通用诊断加固

1. 增加有界的 Prometheus rule、target、label 与 series 发现能力，让 `aiops-diag` 能为任意非 Kubernetes 告警恢复表达式和目标，且不编造 PromQL。
2. 增加健康/就绪检查和低基数 Prometheus 指标，覆盖 webhook 投递、认证失败、队列深度/时效、调度结果、活动诊断、延迟与 Token 预留。
3. 把真实 Alertmanager/k3s 演练变成可重复测试，覆盖 Kubernetes、target-down、任意 alertname、缺失 severity、生命周期、重试、突发和重启场景。
4. 在 Portal 增加版本化路由策略设置与 dry-run，覆盖噪声排除、severity 归一/默认值、冷却、队列、并发和 Token 预算。
5. 加固凭据披露、Host 权限、CSRF、密钥轮换、TLS 指南、配置迁移，以及全新安装/升级验证。

详细接续说明与验收条件见 [`CODEX_HANDOFF.md`](../CODEX_HANDOFF.md)。

## 后续：阶段 G——可评测的 RAG 试点（暂缓）

先建立有 owner 的 runbook/复盘语料和固定评测集，再把 WeKnora 作为可替换的只读检索 Provider 试点。知识只能作为指导或先验，不能成为事件真源；报告应把引用文档版本和检索时间与实时证据分开保存。使用相同告警比较有/无检索时的召回、引用准确率、陈旧文档误导、越权泄漏、延迟和 Token 成本；禁止自动摄入未经人工复核的模型报告。

聚合日志、告警关联、拓扑/变更证据、受审批写操作、ITSM adapter、高可用和多租户治理仍属于后续平台工作。
