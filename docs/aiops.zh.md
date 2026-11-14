# AIOps

[English](aiops.md) | 中文

DSH AIOps 子系统是 Alertmanager 驱动的只读调查、人工反馈与历史闭环，覆盖当前告警、Prometheus 指标、Kubernetes 对象与 Event、有界 Pod 日志以及持久事件记录。它添加认证 webhook 入口、带风暴控制的持久 fingerprint 路由、一个随包诊断 skill、三个可替换的观测 capability、十四个模型工具、插件自有的持久事件/反馈/推送存储、诊断结论 IM 推送，以及 DSH Web 内的专用 Portal，且不修改 `agent-loop`。Session 日志保存诊断叙事；两个插件自有存储域（`aiops_incident`、`aiops_delivery`）保存结构化事件状态与推送决策；SQLite 保存路由协调/审计，RAG 仍不在本版本范围内。

## 运行时流程

```text
Alertmanager POST /alertmanager
             -> Bearer 认证 + 有界 v4 标准化
             -> ctx.webhookRuntime
             -> 持久队列 / fingerprint 分组 / 冷却 / 资源预算
             -> fingerprint / 告警轮次 router + 按告警 label 绑定集群
             -> startsAt 锚点 + 有界绝对查询窗口
             -> 确定性诊断 Session
             -> 加载 aiops-diag
                              |
alertmanager_alerts -> ctx.alertmanager -> Alertmanager HTTP API v2
prometheus_query*   -> ctx.prometheus   -> Prometheus HTTP API
kubernetes_*        -> ctx.kubernetes   -> 绑定到本轮次的集群 agent -> Kubernetes API
             evidence + hypotheses + recommendations
                              |
                 aiops_incident_report
                              |
              aiops_incident 存储域
            （每个 Session 一份持久报告）
                  /        |            \
   aiopsIncidents/   历史工具      aiops-delivery
     changed 事件        |            订阅
        |                 |                 |
 explicit operator verdict |       有界 IM webhook POST
   aiops_incident_feedback |                 |
        |                 |        aiops_delivery 域标记
 aiops_incident            |                 |
   存储域                  |                 |
                  \        |                /
              同源 Portal snapshot
                           |
 overview / detail / route audit / 路由策略 dry-run
```

观测工具返回有界的规范 JSON 或原样有界日志文本，并且不接受变更动词、URL、shell 字符串、不受限的 kubectl 参数或流式模式。agent 把相关观测转换成证据记录，在假设中引用这些 ID、给出明确置信度，并仅把拟议操作存为供人工审核的建议。

## 告警路由

Alertmanager adapter 只接受经过认证且有界的 v4 JSON。它会校验 Provider 提供的 fingerprint，缺失时从排序后的 labels 派生。Router 默认接受所有 alertname，仅过滤配置为已知噪声的精确名称。severity label 通过不区分大小写的映射归一化；缺失或未知值使用配置的默认 severity，而不会被丢弃。完全相同的 delivery 重试是幂等的；使用不同认证内容复用发送方提供的 delivery id 会失败。

SQLite 将 `(source, fingerprint)` 映射到当前告警轮次和确定性 Session ID。符合策略的告警在创建 Agent 前进入持久队列；同 fingerprint/status 的就绪项分组，并受 fingerprint 冷却、队列时效/容量、全局及 severity 并发和在途 Token 预留限制。critical 优先，同 severity 保持 FIFO；重启会恢复处理中工作。每次过滤、延迟、分组、丢弃、启动、完成与失败都有审计。

版本化 `aiops-routing` 设置可在无需重启的情况下修改噪声排除、severity 归一/默认值、冷却、队列/重试、并发与 Token 预算。Portal 要求先成功执行一次无副作用 label dry-run，再以 revision fence 原子保存；Router 校验跨字段上限、实时应用提交，并在持久策略审计中记录前后 hash 与变更字段。

首次 firing 创建第 1 轮；重复 firing 与 resolved 通知追加到同一个 Session；resolved 后再次 firing 会打开新一轮。`resolved` 仅表示告警表达式恢复。每个被接受的决策和标准化告警都会在模型可见 follow-up 前追加为 `aiops/alert-routed` v2。事件把 `startsAt` 规范化为 T0，并携带一组可稳定重放的窗口，以及明确的 Prometheus range、Kubernetes Event 和 Pod 日志参数。

恢复轮次结束后，Router 以确定性的方式关闭生命周期，而不依赖模型自行收尾：它读取该 Session 最近存储的事件记录，若事件尚未 resolved，则以携带原状态的 `resolved` 状态写入，并附一条 `alert-recovery-<receivedAt>` 证据，引用告警名和恢复时间。该写入幂等——已 resolved 的事件保持不动——恢复提示词也明确告知模型不要自行关闭生命周期。若在轮次结束与该写入之间发生崩溃，事件保持 active；下一次 firing 告警会照常打开新一轮。

当 firing 告警打开新一轮（`created` 或 `reopened`）时，Router 还会进行尽力而为的诊断复用：在本工作区事件存储的有界已 resolved 记录中扫描（新增 `history.maxScanRecords`/`history.maxIncidents` 条目设置，默认 200/3），寻找报告文本中提及该告警指纹身份 token（完整值或稳定后缀）的最新事件，并把其首要假设和建议作为明确非权威的线索附到首轮提示词中，供模型对照新证据确认或舍弃。事件存储缺失或读取失败时复用被静默跳过；追加轮次和恢复轮次从不触发复用；复用不产生任何写入——模型仍从全新报告开始。

## Capability 角色

| Capability | Service Definition 与 Provider | Consumer |
|---|---|---|
| 告警投递 | [`dsh-webhook-alertmanager`](../packages/webhook-alertmanager/README.zh.md)、隔离 HTTP listener、`ctx.webhookRuntime` | [`dsh-aiops-incident-router`](../packages/incident-router/README.zh.md)、`ctx.aiopsIncidentRouter` |
| Alertmanager 告警 | [`dsh-aiops-alertmanager`](../packages/aiops-alertmanager/README.zh.md)、`ctx.alertmanager`、HTTP API v2 | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `alertmanager_alerts` |
| Prometheus 观测 | [`dsh-aiops-prometheus`](../packages/aiops-prometheus/README.zh.md)、`ctx.prometheus`、有界 HTTP 查询/发现 API | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `prometheus_query`、`prometheus_query_range`、`prometheus_rules`、`prometheus_targets`、`prometheus_discovery` |
| Kubernetes 读取 | [`dsh-aiops-kubernetes`](../packages/aiops-kubernetes/README.zh.md)、`ctx.kubernetes`、经 `ctx.aiopsAgents` 的类型化读取（Host 无 kubeconfig） | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `kubernetes_get`、`kubernetes_list`、`kubernetes_events`、`kubernetes_logs` |
| 诊断流程 | 全局注册的随包 [`dsh-aiops-skill-k8s-diag`](../packages/skill-k8s-diag/README.zh.md) | `aiops-diag` 动态选择 Alertmanager、Prometheus、服务与 Kubernetes 证据分支 |
| 运维 Portal | [`dsh-aiops-portal`](../packages/aiops-portal/README.zh.md)、固定同源 `/api/aiops/portal` | DSH Web 常驻侧边栏入口、Session 视图、实时数据源/路由设置与 dry-run |
| 产品自观测 | [`dsh-aiops-observability`](../packages/aiops-observability/README.zh.md)、`ctx.aiopsTelemetry` | `/api/aiops/healthz`、`/api/aiops/readyz` 与低基数 `/api/aiops/metrics` |
| 集群 agent | [`dsh-aiops-agents`](../packages/aiops-agents/README.zh.md)、`ctx.aiopsAgents`、`/api/aiops/agent` WebSocket | Portal 集群管理，以及 agent 版的 `ctx.kubernetes` 读取 |

每个 capability 都把 Service Definition 与当前 Provider 合并在一个包中，因为它们目前作为同一关注点演进。出现第二种传输或远程执行 Provider 时再拆分 Provider 包；Consumer 已经只依赖抽象 Service。

## 多集群接入

每个集群（包括运行 DSH 的那个）都通过只主动向外连接的 Go agent 读取，而不是 Host 侧的 kubeconfig。Portal 为每个集群签发一个令牌并只展示一次；`aiops_agent` 存储域只保留其 SHA-256 摘要、末四位、时间戳与最近上报的 agent 版本。agent 连接 `/api/aiops/agent`，用该令牌认证，并声明名称、版本与能力集；server 将名称绑定到令牌，跟踪 `pending`/`connected`/`offline`/`revoked` 状态，并在这条连接上执行类型化的 `get`/`list`/`events`/`logs` 读取与 `probe`。不存在 path、URL、verb 或 exec 透传，server 也不持有任何集群凭据。全新安装在没有集群的情况下正常启动，绝不生成或记录令牌，并在 Portal 中显示首次配置提示；agent 的 server 地址始终显式配置，且必须能从集群内部访问。诊断工具通过该 agent 读取：router 把每个轮次绑定到告警 `cluster` label 指定的集群（router 上的 `clusterLabel`/`defaultCluster`），观测工具透传该绑定，因此一次诊断无法读取其他集群。未知或非法的 label 不绑定任何集群，Kubernetes 证据会显式失败，而不是回退到默认集群。升级由运维执行：Portal 持久化目标版本并 drain agent，让在途读取完成、新读取失败转移，同时给出滚动发布命令；替换 agent 以新版本连接后自动清除 drain。参见[决策记录](decisions/2026-11-14-aiops-cluster-agent-gateway.zh.md)与 [agent 指南](../agent/README.zh.md)。

## 事件状态

结构化事件状态保存在插件自有的 `aiops_incident` 存储域（`ctx.aiopsIncidents` 服务）中，而不是 Session 事件里：DSH 0.2.x 把 `session.append` 的插件记录保留给 Host 自带包，外部插件无法可移植地写入。该域在 `<DSH_HOME>/storages/aiops_incident/` 使用 per-record JSON 布局，每个 Session 一份 zod 校验文档保存最新完整 `AiopsIncidentState`（版本、稳定事件编号、标题、严重级别、状态、完整证据、假设、建议），另有只追加的反馈表。每次报告替换上一份并递增 `revision`；存储校验生命周期连续性（首份报告不能是 `resolved`；身份稳定；resolved 为终态），且 Session 的工作区在首份报告时固定。

事件状态有两个写入方：模型通过 `aiops_incident_report` 写入，incident router 在 Alertmanager 恢复轮次后通过确定性 resolved 转换写入；两者使用同一存储、同一 schema 与同一生命周期校验。只有在当前用户明确确认、修正或否定诊断后，Agent 才能追加操作员反馈；反馈包含确定性 ID、`incidentId`、所审核的 `reportRevision`、verdict 与说明，按反馈 ID 幂等，且新报告会使绑定旧 revision 的反馈失效。修正还包含 correction，且从不改写报告。Session 日志保留完整诊断叙事（路由告警、观测、模型消息、工具调用）；存储域拥有历史工具、Portal、推送与复用所消费的结构化状态。

## 诊断结论推送

`aiops-delivery` 订阅 `aiopsIncidents/changed` 事件，把符合条件的报告推送到一个 IM incoming webhook——飞书交互卡片、钉钉 markdown 或 Slack 文本。webhook URL 通过凭证引用（`webhookUrlEnv`）提供，因此从不进入 patch 或设置存储，且必须是干净的 https URL。低于 `minSeverity` 的报告先跳过，待严重级别升级后重新评估；`aiops_delivery` 域中的已投递标记阻止同一 Session 之后的一切重复推送——包括重启之后——而失败的投递爆发会用带截断失败原因的标记覆盖，让后续报告触发重试。推送只承担信息通知职责：每个决策只追加一条可审计记录，从不改变基础设施。

## 持久化、数据库与 RAG

该子系统保留三类持久状态。DSH Session 持久化（`~/.dsh/sessions` 下的 JSONL）保存诊断叙事：路由告警、模型可见消息与工具观测。`<DSH_HOME>/storages/` 下的插件自有存储域保存结构化状态：`aiops_incident`（事件报告与操作员反馈）和 `aiops_delivery`（终态推送决策）；两者都在持久边界做 schema 校验，无法读取的记录会被备份并跳过，而不会阻塞启动。`aiops-router.sqlite` 拥有 delivery 重放、队列、风暴控制/路由策略审计和 fingerprint 到轮次的协调状态。Bundle 在 `aiops-incidents.sqlite` 启用 `dsh-session-query-sqlite`；`dsh-tool-aiops-history` 通过事件存储将工具读取限制在调用方工作区。Portal 不增加数据库，其接口固定读取 Router 配置的诊断工作区，并对事件和审计扫描设置上限。

RAG 暂缓，因为该闭环从实时运维状态进行诊断，目前还没有经过验证的运维手册语料库。只有在具备维护中的语料、访问策略、引用、时效规则与评测集后才应增加检索；检索应贡献证据或操作员指导，绝不能绕过只读工具与审批策略。

## 安全边界

该包组不包含 Alertmanager 写入、Kubernetes 变更、exec、任意命令、流式日志跟随、自动修复或绕过审批的路径。Portal 永不返回 webhook bearer 明文，只暴露 URL 和是否已配置；连接测试与 dry-run POST 会拒绝跨站浏览器请求。部署仍负责 DSH Host 认证边界、TLS 与反向代理 header、网络 ACL、Alertmanager/Prometheus 访问、agent 令牌签发与吊销，以及 agent 运行时使用的只读 Kubernetes RBAC。详见[生产部署与升级](deployment.zh.md)。

## 当前限制

- 告警：提供认证 Alertmanager v4 入口与当前告警读取；没有静默或变更 API。
- 指标：提供有界 PromQL 即时/范围查询，以及规则、Target、label 与 series 发现；没有 Prometheus 写入或无约束元数据扫描。
- 集群：仅有对象 get/list、绝对窗口 Event 与有界绝对窗口非流式 Pod 日志；没有 watch、发现、exec 或拓扑图。
- 状态：每个告警轮次一个事件；告警表达式恢复后再次 firing 会打开新的 Session 轮次。反馈为显式追加事件，不自动训练模型。跨 Session 历史保持只读并受工作区限制，不提供合并、聚合分析或工单系统同步。
- 体验：Web profile 提供始终可访问的 AIOps Portal、实时持久化数据源设置，以及带 revision fence 的路由策略管理；事件内容仍只读，当前不支持 Electron，也不在 Portal 内提交反馈或修复动作。
- 动作：建议只是供人工审核的文本；没有自动修复。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

以下 API 摘录与包源码保持一致，公开声明变化时必须同步更新。框架继承的 `ctx` 行为遵循 [DSH Cordis 入门文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.zh.md)。

<a id="ctxalertmanager--alertmanagerruntime-abstract-seam"></a>

### `ctx.alertmanager` — `AlertmanagerRuntime` (abstract seam)

Provider-neutral read-only Alertmanager runtime.

```ts cordis-catalog
/**
 * Apply Provider-owned defaults and limits to a current-alert request.
 * @param request - optional alert state, label, and receiver filters.
 * @returns fully specified query for {@link alerts}.
 */
abstract resolveAlerts(request: AlertmanagerAlertsRequest): AlertmanagerAlertsSpec

/**
 * Read current alerts from Alertmanager API v2.
 * @param spec - fully resolved query from {@link resolveAlerts}.
 * @param signal - caller cancellation.
 * @returns detached current alert objects.
 */
abstract alerts(spec: AlertmanagerAlertsSpec, signal?: AbortSignal): Promise<AlertmanagerAlertsResult>
```

Source: [`packages/aiops-alertmanager/src/index.ts`](../packages/aiops-alertmanager/src/index.ts)

<a id="ctxkubernetes--kubernetesruntime-abstract-seam"></a>

### `ctx.kubernetes` — `KubernetesRuntime` (abstract seam)

Provider-neutral read-only Kubernetes runtime.

```ts cordis-catalog
/**
 * Read one named Kubernetes object.
 * @param request - target resource, object name, namespace, and execution directory.
 * @param signal - caller cancellation.
 * @returns Kubernetes API object as lossless JSON.
 */
abstract get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * List Kubernetes objects.
 * @param request - target resource, namespace, selectors, and execution directory.
 * @param signal - caller cancellation.
 * @returns Kubernetes API list as lossless JSON.
 */
abstract list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * List Kubernetes Event objects in chronological order.
 * @param request - namespace and optional server-side selectors.
 * @param signal - caller cancellation.
 * @returns Kubernetes EventList as lossless JSON.
 */
abstract events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

/**
 * Apply Provider-owned defaults and caps to a Pod-log request.
 * @param request - Pod, optional container, time window, and requested line count.
 * @returns a fully specified bounded log request for {@link logs}.
 */
abstract resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec

/**
 * Read one bounded non-streaming Pod-log snapshot.
 * @param spec - fully resolved request from {@link resolveLogs}.
 * @param signal - caller cancellation.
 * @returns selected Provider 返回的有界 Pod 日志文本。
 */
abstract logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult>

/** 探测集群 agent 并报告其能力。 */
abstract testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult>
```

Source: [`packages/aiops-kubernetes/src/index.ts`](../packages/aiops-kubernetes/src/index.ts)

<a id="ctxprometheus--prometheusruntime-abstract-seam"></a>

### `ctx.prometheus` — `PrometheusRuntime` (abstract seam)

Provider-neutral read-only Prometheus runtime.

```ts cordis-catalog
/**
 * Evaluate one PromQL expression at one instant.
 * @param request - expression and optional evaluation time.
 * @param signal - caller cancellation.
 * @returns normalized successful query data.
 */
abstract query(request: PrometheusInstantQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>

/**
 * Evaluate one PromQL expression over a time range.
 * @param request - expression, range, and resolution.
 * @param signal - caller cancellation.
 * @returns normalized successful query data.
 */
abstract queryRange(request: PrometheusRangeQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>
```

Source: [`packages/aiops-prometheus/src/index.ts`](../packages/aiops-prometheus/src/index.ts)
<!-- END GENERATED cordis-surface -->

## 相关文档

- [AIOps 包导航](../packages/README.zh.md)——直接包职责。
- [DSH Session 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.zh.md)——持久事件与持久化语义。
- [DSH Session 投影](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.zh.md)——当前状态折叠与缓存行为。
- [AIOps 基础决策](decisions/2026-09-04-dsh-aiops-read-only-foundation.zh.md)——已接受替代方案与拆分触发条件。
- [Alertmanager Session 路由决策](decisions/2026-09-06-alertmanager-session-routing.zh.md)——重放、轮次与重启语义。
- [时间锚诊断决策](decisions/2026-09-06-time-anchored-diagnosis.zh.md)——T0/窗口派生、有界 Kubernetes 读取与随包 skill 可用性。
- [反馈与告警风暴控制决策](decisions/2026-09-06-operator-feedback-storm-control.zh.md)——追加式审核、队列、资源预算和审计语义。
- [AIOps Portal 决策](decisions/2026-09-06-aiops-portal.zh.md)——同源接口、工作区范围和只读 UI 边界。
- [插件自有事件存储决策](decisions/2026-11-14-aiops-plugin-owned-incident-store.zh.md)——为何事件状态从 Session 事件迁入 DSH 存储域。
- [集群 agent 网关决策](decisions/2026-11-14-aiops-cluster-agent-gateway.zh.md)——为何通过带 server 签发令牌的出站 agent 访问集群。
- [生产部署与升级](deployment.zh.md)——Host/TLS 边界、凭据轮换、迁移与发布流程。
- [可重复 Alertmanager/k3s 矩阵](../deploy/alertmanager/README.zh.md)——带门槛的真实 receiver 与重启流程。
