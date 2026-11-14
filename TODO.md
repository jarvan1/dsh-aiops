# DSH AIOps TODO

Snapshot: 2026-11-14, after the DSH 0.2.2-rc.1 upgrade, aiops-delivery, alert-recovery linkage, the container image, the plugin-owned incident store migration, the real-environment k3s + Alertmanager E2E regression, the Go cluster agent, the server-side agent gateway (M1), agent-only Kubernetes reads (M2), and the operator-applied agent upgrade flow (M3).

## Now

- [ ] **带真实 agent 的完整 k3s 矩阵。** M2/M3 已用本机 k3s 验证读取与升级链路，并把 server 与 agent 同时部署进 k3s（Portal 签发令牌 → agent Pod 回连 → 探测 → drain → 替换版本 → 吊销；见 [`deploy/k8s/`](deploy/k8s/README.zh.md)）。仍需在配置了模型的真实环境中跑一轮完整的 `setup → exercise → verify → cleanup`，确认告警 label 绑定与 Kubernetes 证据在完整链路中成立。
- [ ] **多副本连接归属。** 在线 socket 是进程内状态；多副本部署时读请求只在持有该连接的副本上成功。在引入共享连接路由（或固定单副本）之前，需在部署文档中写明约束。
- [ ] **aiops-delivery real-IM smoke test.** Implementation is complete (see CHANGELOG 2026-11-08); remaining: one manual end-to-end push against a real Feishu/钉钉/Slack webhook in a disposable profile or the container image, including token rotation without restart.

## Next

- [ ] **Route-event ignorable marker (blocked upstream).** `aiops/alert-routed` events are appended through the `session.append` cast, which drops `{ignorable: true}` on real sessions, so they replay into model context on resume. Porting them to the `plugin:` grammar is not available to an external plugin: `appendPluginRecord` rejects cross-realm receivers (see the incident store decision). Treat these events as part of the diagnostic narrative and revisit only if DSH exposes a public ignorable append or a portable plugin-record writer.

## Done (this snapshot)

- [x] **多集群 agent — M3：升级状态机。** `upgradeCluster` 持久化目标版本并 drain 在线 agent（drain 期间网关以 `unreachable` 拒绝新读取，替换连接不继承 drain），`resumeCluster` 取消发布；Portal 集群页显示“升级中”/待应用版本，提供目标版本表单、恢复读取与 `kubectl set image` 滚动提示。server 从不替换镜像（path A）。真实 k3s 验证：1.0.0 agent → drain → 2.0.0 二进制重连 → 读取恢复；以及升级后 resume 恢复。
- [x] **多集群 agent — M2：agent 版 Provider。** `ctx.kubernetes` 只走 `ctx.aiopsAgents`：router 按告警 `cluster` label（`clusterLabel`，默认 `cluster`）把每个轮次绑定到 agent，非法 label 不回退，观测工具按 `sessionId` 透传绑定；router SQLite v5 新增 `cluster` 列并就地迁移/回填。删除 native kubeconfig Provider、`./kubectl` 子路径、`@kubernetes/client-node`、`kubeconfig`/`context` 设置与 `KUBECONFIG`/`KUBERNETES_CONTEXT` 默认值；Portal 只测试 Prometheus/Alertmanager，集群连通性改为**集群**页的 agent 探测。k3s 矩阵改为部署真实 agent 并在清理时吊销。
- [x] **多集群 agent server 侧（M1）.** 新增 `packages/aiops-agents`：`aiops_agent` 存储域（名称、令牌 SHA-256 摘要、末四位、时间戳、最近 agent 版本）、一次性令牌签发/重签/吊销、`/api/aiops/agent` WebSocket 网关（bearer 认证、hello/welcome、名称绑定、协议主版本校验、按 id 关联与超时、心跳/ping、连接替换、`4001` 吊销关闭）、Portal 集群标签页与首页首次配置提示。快照 v4 携带 `clusters`/`needsCluster`；`/readyz` 在零集群时保持 ready 并报告 `components.clusters` 与 `clusters` 块。启动时不生成或记录令牌，明文只展示一次。真实 Go agent 已与真实 TS 网关完成跨语言冒烟（握手、probe、错误码映射、吊销）。
- [x] **多集群 agent 客户端（M0）.** Outbound-only Go agent under `agent/`: protocol v1 with a closed read set (`get`/`list`/`events`/`logs`), in-cluster REST client with per-request token re-read, bounded executor (2 MB response cap, log tail cap, request deadline), heartbeat/ping keepalive, capped reconnect backoff, `drain`/`resume`, deliberate self-upgrade refusal (path A), `Dockerfile.agent`, and a read-only RBAC + Deployment example. No client-go dependency. Validated against a local k3s v1.36 through a temporary protocol stub — list/get/logs/events plus drain/resume — which found the `pods/log` `Accept: text/plain` 406 and fixed it.
- [x] **Real-environment E2E regression.** k3s + Alertmanager fixture E2E against DSH 0.2.2-rc.1 passed the receiver, lifecycle, retry, burst, Session, evidence, and report matrix after the storage migration; it caught the cross-realm `appendPluginRecord` failure that motivated the plugin-owned store.
- [x] **插件自有事件存储迁移.** Incident reports and operator feedback moved from Session plugin records to the `aiops_incident` storage domain; delivery markers moved to `aiops_delivery`; Portal snapshot v3, history tools, delivery, reuse, and router recovery closure all read/write the store. See [the decision record](docs/decisions/2026-11-14-aiops-plugin-owned-incident-store.md).
- [x] **aiops-delivery — 诊断结论推送.** IM webhook push with durable `aiops_delivery` markers, severity gate, per-attempt credential re-resolution.
- [x] **告警恢复联动.** After a recovery turn settles, the router reports the carried-forward `resolved` incident state through the incident store with `alert-recovery-*` evidence; idempotent, same lifecycle validation as model reports, recovery prompt defers closure to the router.
- [x] **Container image.** Multi-stage `Dockerfile` + entrypoint: build-time profile seed (offline first boot), `DSH_HOME` volume, proxy/trusted-host env support; documented in the bilingual deployment guide.
- [x] **诊断复用.** Firing alerts opening a new round get bounded workspace-store reads (`listResolved`) that attach the latest matching resolved incident's hypotheses/recommendations as lead-only context; an absent store or failed read skips reuse silently, and no writes occur.

## Deferred (explicitly)

- [ ] **变更部署关联证据** — deferred by product decision; revisit after delivery + resolution linkage.

## Notes

- Old 0.1.x sessions with non-ignorable `aiops/*` event types refuse to load under 0.2.x — no migration path; fresh sessions only.
- Structured incident and delivery state now lives in `<DSH_HOME>/storages/` (`aiops_incident`, `aiops_delivery`); back it up with the Session workspace and SQLite.
- Never commit a real `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`, kubeconfig, bearer token, IM webhook URL, or other credential.
