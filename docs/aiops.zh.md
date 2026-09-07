# AIOps

[English](aiops.md) | 中文

DSH AIOps 子系统是 Alertmanager 驱动的只读调查、人工反馈与历史闭环，覆盖当前告警、Prometheus 指标、Kubernetes 对象与 Event、有界 Pod 日志以及持久事件记录。它添加认证 webhook 入口、带风暴控制的持久 fingerprint 路由、一个随包诊断 skill、三个可替换的观测 capability、十四个模型工具、持久路由/事件/反馈，以及 DSH Web 内的专用 Portal，且不修改 `agent-loop`。Session 日志仍是诊断真源；SQLite 分别保存路由协调/审计和可重建的跨 Session 搜索索引，RAG 仍不在本版本范围内。

## 运行时流程

```text
Alertmanager POST /alertmanager
             -> Bearer 认证 + 有界 v4 标准化
             -> ctx.webhookRuntime
             -> 持久队列 / fingerprint 分组 / 冷却 / 资源预算
             -> fingerprint / 告警轮次 router
             -> startsAt 锚点 + 有界绝对查询窗口
             -> 确定性诊断 Session
             -> 加载 k8s-diag
                              |
alertmanager_alerts -> ctx.alertmanager -> Alertmanager HTTP API v2
prometheus_query*   -> ctx.prometheus   -> Prometheus HTTP API
kubernetes_*        -> ctx.kubernetes   -> 原生 kubeconfig 客户端 -> Kubernetes API
             evidence + hypotheses + recommendations
                              |
                 aiops_incident_report
                              |
                aiops/incident-state
                              |
       explicit operator verdict -> aiops_incident_feedback
                              |
                 aiops/operator-feedback
                       /             \
          Session persistence   aiopsIncident projection
                    |
       disposable SQLite session-query index
                    |
 incident history / feedback history / routing audit
                    |
       same-origin read-only Portal snapshot
                    |
       overview / filters / detail / route audit
```

观测工具返回有界的规范 JSON 或原样有界日志文本，并且不接受变更动词、URL、shell 字符串、不受限的 kubectl 参数或流式模式。agent 把相关观测转换成证据记录，在假设中引用这些 ID、给出明确置信度，并仅把拟议操作存为供人工审核的建议。

## 告警路由

Alertmanager adapter 只接受经过认证且有界的 v4 JSON。它会校验 Provider 提供的 fingerprint，缺失时从排序后的 labels 派生。Router 在消耗任何模型资源前应用精确的高信号 alertname 白名单和显式 severity 映射。完全相同的 delivery 重试是幂等的；使用不同认证内容复用发送方提供的 delivery id 会失败。

SQLite 将 `(source, fingerprint)` 映射到当前告警轮次和确定性 Session ID。符合策略的告警在创建 Agent 前进入持久队列；同 fingerprint/status 的就绪项分组，并受 fingerprint 冷却、队列时效/容量、全局及 severity 并发和在途 Token 预留限制。critical 优先，同 severity 保持 FIFO；重启会恢复处理中工作。每次过滤、延迟、分组、丢弃、启动、完成与失败都有审计。

首次 firing 创建第 1 轮；重复 firing 与 resolved 通知追加到同一个 Session；resolved 后再次 firing 会打开新一轮。`resolved` 仅表示告警表达式恢复。每个被接受的决策和标准化告警都会在模型可见 follow-up 前追加为 `aiops/alert-routed` v2。事件把 `startsAt` 规范化为 T0，并携带一组可稳定重放的窗口，以及明确的 Prometheus range、Kubernetes Event 和 Pod 日志参数。

## Capability 角色

| Capability | Service Definition 与 Provider | Consumer |
|---|---|---|
| 告警投递 | [`dsh-webhook-alertmanager`](../packages/webhook-alertmanager/README.zh.md)、隔离 HTTP listener、`ctx.webhookRuntime` | [`dsh-aiops-incident-router`](../packages/incident-router/README.zh.md)、`ctx.aiopsIncidentRouter` |
| Alertmanager 告警 | [`dsh-aiops-alertmanager`](../packages/aiops-alertmanager/README.zh.md)、`ctx.alertmanager`、HTTP API v2 | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `alertmanager_alerts` |
| Prometheus 查询 | [`dsh-aiops-prometheus`](../packages/aiops-prometheus/README.zh.md)、`ctx.prometheus`、HTTP 查询 API | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `prometheus_query`、`prometheus_query_range` |
| Kubernetes 读取 | [`dsh-aiops-kubernetes`](../packages/aiops-kubernetes/README.zh.md)、`ctx.kubernetes`、官方原生 API 客户端（另有可选 kubectl 兼容子路径） | [`dsh-tool-aiops-observe`](../packages/tool-aiops-observe/README.zh.md) 中的 `kubernetes_get`、`kubernetes_list`、`kubernetes_events`、`kubernetes_logs` |
| 诊断流程 | 全局注册的随包 [`dsh-aiops-skill-k8s-diag`](../packages/skill-k8s-diag/README.zh.md) | 每个被路由诊断 Session 加载的 `k8s-diag` |
| 运维 Portal | [`dsh-aiops-portal`](../packages/aiops-portal/README.zh.md)、固定同源 `/api/aiops/portal` | DSH Web 常驻侧边栏入口、Session 视图与实时数据源设置 |

每个 capability 都把 Service Definition 与当前 Provider 合并在一个包中，因为它们目前作为同一关注点演进。出现第二种传输或远程执行 Provider 时再拆分 Provider 包；Consumer 已经只依赖抽象 Service。

## 事件状态

每个 `aiops/incident-state` 事件都包含完整当前 `AiopsIncidentState`：版本、稳定事件编号、标题、严重级别、状态、完整证据、假设与建议。只有在当前用户明确确认、修正或否定诊断后，Agent 才能追加 `aiops/operator-feedback`。反馈包含确定性 ID、`incidentId`、所审核的 `reportSeq`、verdict 与说明；修正还包含 correction，且从不改写报告。两条写入路径都在追加前后执行 Session 持久化检查点。

`aiopsIncident` 投影采用最后一个有效写入，并校验恢复的缓存值及重放的每个事件。不提供单独的 invariant companion，因为不存在第二个权威观测：投影解码的事件本身就是持久事实来源，而工具会在提交下一事件前检查生命周期连续性。

## 持久化、数据库与 RAG

该子系统复用 DSH Session 持久化保存诊断真源。JSONL 存储路由告警事件、模型可见消息、工具观测、事件状态和操作员反馈；`ctx.sessionProjections` 提供当前状态。`aiops-router.sqlite` 拥有 delivery 重放、队列、风暴控制审计和 fingerprint 到轮次的协调状态。Bundle 在 `aiops-incidents.sqlite` 启用 `dsh-session-query-sqlite`；`dsh-tool-aiops-history` 将工具读取限制在调用方工作区。Portal 不增加数据库，其接口固定读取 Router 配置的诊断工作区，并对会话、事件和审计扫描设置上限。

RAG 暂缓，因为该闭环从实时运维状态进行诊断，目前还没有经过验证的运维手册语料库。只有在具备维护中的语料、访问策略、引用、时效规则与评测集后才应增加检索；检索应贡献证据或操作员指导，绝不能绕过只读工具与审批策略。

## 安全边界

该包组不包含 Alertmanager 写入、Kubernetes 变更、exec、任意命令、流式日志跟随、自动修复或绕过审批的路径。部署仍负责网络 ACL、Alertmanager 与 Prometheus 访问、kubeconfig 选择及只读 Kubernetes RBAC。Provider 配置属于可信应用组合，而模型输入会在 I/O 前受到约束与校验。

## 当前限制

- 告警：提供认证 Alertmanager v4 入口与当前告警读取；没有静默或变更 API。
- 指标：仅有 PromQL 即时与范围查询；没有规则或元数据 API。
- 集群：仅有对象 get/list、绝对窗口 Event 与有界绝对窗口非流式 Pod 日志；没有 watch、发现、exec 或拓扑图。
- 状态：每个告警轮次一个事件；告警表达式恢复后再次 firing 会打开新的 Session 轮次。反馈为显式追加事件，不自动训练模型。跨 Session 历史保持只读并受工作区限制，不提供合并、聚合分析或工单系统同步。
- 体验：Web profile 提供始终可访问的只读 AIOps Portal，以及实时生效并持久化的 Prometheus/Alertmanager 设置；当前不支持 Electron，也不在 Portal 内提交反馈或修复动作。
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

/** 验证 kubeconfig/API 连通性与诊断所需只读权限。 */
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
