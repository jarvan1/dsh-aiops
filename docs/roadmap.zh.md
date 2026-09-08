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
- 阶段 F.3.1：Prometheus Provider 与模型工具现已提供有界告警规则、Target 健康及 label/series 发现。规则查询按 alertname 恢复精确表达式并比较标识 label；Target 查询在不暴露 URL 凭据的前提下返回抓取健康与错误；元数据发现必须提供具体 selector 和有界绝对时间窗。同源 Prometheus `generatorURL` 只在本地提取表达式，绝不抓取。`aiops-diag` 会先执行发现，再考虑证据不足，且不编造 PromQL。
- 阶段 F.3.2：新增第十三个包，提供精确存活检查、组件感知的就绪检查和低基数 Prometheus 指标。Alertmanager 入口与事件 Router 发布有界 webhook 结果、队列深度/时效、分组/延迟/丢弃工作、活动诊断、调度失败、模型 Token 预留和固定桶诊断延迟，不使用告警派生标签。
- 阶段 F.3.3：新增带显式安全门槛的运行器，在独立 k3s namespace 创建和清理 Prometheus Operator 规则、AlertmanagerConfig、经 stdin 提交的 bearer Secret 与 CrashLoop Pod；执行 receiver 矩阵，并验证路由审计、Session/报告证据、重试、生命周期、风暴控制和重启恢复。filtered `Watchdog` 探针证明真实 Prometheus → Alertmanager → 认证 receiver 链路。
- 阶段 F.3.4：Portal 现可管理版本化实时路由设置，包括噪声排除、severity 归一/默认值、冷却、队列/重试、并发与 Token 预算。候选策略必须先通过无副作用的标准化 label dry-run，再以 revision fence 原子保存；每次提交均持久审计。
- 阶段 F.3.5：移除 Portal 凭据披露；浏览器 POST 探测拒绝跨站请求；补充部署方 TLS、Host 认证、轮换、迁移、保留和发布流程。旧 allowlist schema 可用安全默认值和弃用警告启动，并以隔离 DSH profile 验证支持版本上的全新安装、启动、重启、密钥轮换与卸载。

阶段 D 默认验证覆盖 17 个通过的测试文件和 108 个通过的测试，另有一个按需真实集群测试，并通过 skill 结构校验、相对文档链接、全部十一个 package tarball，以及隔离 DSH Web profile 的安装、配置 dump、真实启动和卸载检查。真实演练使用产品 Kubernetes Provider 读取一个现有 CrashLoopBackOff Pod、绝对窗口 Event、当前与 previous 有界日志，全程没有修改集群。

阶段 E 默认验证覆盖 17 个通过的测试文件和 118 个通过的测试，另有一个按需真实集群测试；完整 TypeScript 构建、相对文档链接、bundle tarball，以及四个受影响 package 的 tarball 内容检查均通过。

阶段 F 默认验证覆盖 19 个通过的测试文件和 128 个通过的测试，另有一个按需真实集群测试；完整 TypeScript 构建、Portal Host/Web 双产物、自包含 Host 入口回归、全局侧边栏/会话视图注册回归、Provider 实时设置测试、相对文档链接、Portal 与 bundle 的 tarball 内容检查，以及不提供数据源环境变量的隔离 DSH Web profile 真实启动和 Portal API 读取均通过。

阶段 F.1 验证包含本地模拟 Kubernetes API 演练，覆盖 kubeconfig 加载、namespace 原生对象读取、精确绝对时间 Pod 日志、版本探测和三项 SelfSubjectAccessReview，并覆盖 Portal 保存门槛与 RBAC 失败场景。

阶段 F.2 验证覆盖已配置噪声排除、任意 alertname、缺失/未知 severity 回退、severity 映射大小写归一、动态证据源指令、skill 注册和包级 TypeScript 检查。

阶段 F.3.1 验证覆盖规范化规则与 Target 解码、精确 label 比较、结果截断、URL 清理、安全 generator 解析、受限 series/label 发现、十工具 Loader 组合及更新后的 skill 工作流。默认套件通过 21 个测试文件和 145 个测试，另有一个按需真实集群测试跳过；在本地 k3s 启用该测试后，全部 22 个文件和 146 个测试通过。真实用例现在会跨过容器重启瞬间的短暂状态，轮询到 `CrashLoopBackOff` 后再继续。

阶段 F.3.2 验证覆盖就绪状态转换、精确 Web 路由注册与方法处理、低基数指标输出、累积延迟桶和 webhook/router 埋点。默认套件通过 22 个测试文件和 148 个测试，另有一个按需真实集群测试跳过；完整 TypeScript 构建与 GitHub 源码包准备也通过。

阶段 F.3.3–F.3.5 验证覆盖运行器安全门槛与场景契约、实时策略迁移/校验/dry-run/审计、带 revision fence 的 Portal 保存、无密钥响应和跨站拒绝。默认套件通过 23 个测试文件和 155 个测试，另有一个按需真实集群测试跳过。本地 k3s 已加载规则与 AlertmanagerConfig，通过认证 receiver 把 `Watchdog` 探针写入路由审计，并通过原生 CrashLoopBackOff 只读演练。隔离 DSH Web profile 在 Node 24、pnpm 11.7 上通过 bundle 添加/config dump/启动、健康/就绪/指标与 Portal 探测、凭据轮换后重启及卸载。

## 下一步：阶段 G——可评测的 RAG 试点（暂缓）

先建立有 owner 的 runbook/复盘语料和固定评测集，再把 WeKnora 作为可替换的只读检索 Provider 试点。知识只能作为指导或先验，不能成为事件真源；报告应把引用文档版本和检索时间与实时证据分开保存。使用相同告警比较有/无检索时的召回、引用准确率、陈旧文档误导、越权泄漏、延迟和 Token 成本；禁止自动摄入未经人工复核的模型报告。

聚合日志、告警关联、拓扑/变更证据、受审批写操作、ITSM adapter、高可用和多租户治理仍属于后续平台工作。
