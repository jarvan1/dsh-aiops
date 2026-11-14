# 生产部署与升级

[English](deployment.md) | 中文

## 信任边界

DSH AIOps 是只读诊断插件，不是面向公网的认证网关。主 DSH Web 及 `/api/aiops/*` 必须置于部署方拥有的 Host 认证边界后。Alertmanager 专用 receiver 只能绑定受保护接口，并仅允许 Alertmanager 或其反向代理访问。

Portal 永不返回 webhook bearer 明文，只返回公开 receiver URL 和“凭据是否存在”。连接测试与路由 dry-run POST 会根据 `Sec-Fetch-Site` 和同 Host `Origin` 拒绝跨站浏览器请求；持久设置写入继续使用 DSH 带 revision fence 的 Settings API。反向代理必须覆盖而不是追加来自客户端的不可信 `X-Forwarded-Host`。

## TLS 反向代理

应在自有反向代理终止 TLS 并完成认证。NGINX 最小结构见 [English 文档](deployment.md#tls-reverse-proxy)；生产配置还需设置证书、现代 TLS 协议，并把 `/alertmanager` 限制在 Alertmanager 网络身份范围内。

使用 `/api/aiops/healthz` 做存活检查、`/api/aiops/readyz` 做流量就绪检查、`/api/aiops/metrics` 做 Prometheus 抓取。不要把指标接口暴露到公网。

## 凭据轮换

`AIOPS_ALERTMANAGER_WEBHOOK_SECRET` 只能保存在权限为 `0600` 的 `<DSH_HOME>/.credentials.yaml` 或外部 secret manager，不能进入 patch、URL、浏览器、日志或仓库。轮换步骤：

1. 生成足够长的随机新值，更新 Kubernetes Secret 或 Alertmanager secret store。
2. 原子更新 DSH credential reference 对应值。
3. 重启或滚动重启 DSH，使 credential Provider 重新加载。
4. 发送一次认证 canary，核对 accepted webhook 指标与路由审计。
5. 确认旧值返回 `401`，再从来源 secret manager 删除旧值。

本版本刻意不提供 Portal secret 显示或写入接口，因此不存在需要授权、审计或 CSRF 防护的明文 reveal 事件。

## 诊断结论推送

`aiops-delivery` 把完成的诊断推送到一个 IM incoming webhook（飞书、钉钉或 Slack）。https webhook URL 作为 `AIOPS_DELIVERY_WEBHOOK_URL` credential reference 的值，保存在权限为 `0600` 的 `<DSH_HOME>/.credentials.yaml` 或外部 secret manager，不能进入 patch、设置存储或仓库。Provider（`provider`）、严重级别闸门（`minSeverity`）、Portal 深链（`portalBaseUrl`）以及有界的超时/重试上限都是 entry 设置，由 Web 设置界面投影；提交编辑会重载该 entry。凭证值在每次投递时重新解析，因此轮换 IM webhook token 无需重启：更新引用值并发送一次 canary 事件即可。

验证方式：路由一次 canary 告警，确认消息出现在目标 IM 会话，且 `aiops_delivery` 域中该 Session 存在 outcome 为 `delivered` 的标记（`<DSH_HOME>/storages/aiops_delivery/markers/<session-id>.json`）。

## 本地开发运行

在一次性 DSH Web profile 中先跑通，再接触共享环境：

```sh
pnpm install
pnpm run build:github

# 从本地 checkout 安装进隔离的 profile home。
DSH_HOME=~/.dsh-aiops-dev \
  npx -y @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add link:"$PWD/packages/aiops"
```

link 安装加载的是构建后的 `lib/` 产物，因此每次改代码后都要重新 build 并重启 DSH。若 pnpm 拦截 Git 依赖的 `prepare` 脚本，把打印的精确 `allowBuilds` key 复制进 profile 的 `pnpm-workspace.yaml` 后重跑 add 命令。

在 `<DSH_HOME>/.credentials.yaml`（权限 `0600`）中放置凭证：

```yaml
AIOPS_ALERTMANAGER_WEBHOOK_SECRET: '<长随机串>'   # webhook 接收端 Bearer
AIOPS_DELIVERY_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/<token>'  # IM 机器人 URL
```

飞书自定义机器人在群设置 → 群机器人 → 自定义机器人中创建并复制 webhook URL；钉钉与 Slack 机器人的 URL 形状相同。`provider`、`minSeverity`、`portalBaseUrl` 在 AIOps 设置界面中配置（提交编辑会重载 entry）；可选设置 `AIOPS_PORTAL_PUBLIC_URL`，让推送卡片带可用的 Portal 按钮。

启动 Web profile，检查 `/api/aiops/healthz`、`/api/aiops/readyz` 并打开侧边栏 AIOps Portal。webhook 接收端默认监听 `127.0.0.1:3081/alertmanager`；canary 不需要真实 Alertmanager：

```sh
curl -s -X POST http://127.0.0.1:3081/alertmanager \
  -H "Authorization: Bearer $AIOPS_ALERTMANAGER_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"version":"4","alerts":[{"status":"firing","startsAt":"2026-11-08T10:00:00Z","labels":{"alertname":"HighLatency","severity":"critical","service":"checkout"},"annotations":{"description":"p99 latency above 4s"}}]}'
```

canary 会走完整链路：认证 ingress → 路由轮次 → 确定性诊断 Session（profile 内需已配置模型）→ `aiops_incident_report` → `aiops_incident` 存储域 → 推送 → IM 会话消息加一条 `aiops_delivery` `delivered` 标记。诊断质量依赖 Prometheus/Alertmanager/Kubernetes 连通性，但 delivery 冒烟只需要模型产出事件报告。切换 provider 直接在设置中改 `provider`；轮换 IM webhook token 只需更新凭证值——投递每次尝试都重新解析，无需重启。

## 集群接入

Kubernetes 证据不再通过 Host 侧 kubeconfig 读取。每个集群（包括运行 DSH 的那个）都安装 [`agent/`](../agent/README.zh.md) 中的 Go agent，并在 Portal 中注册：

1. 打开 AIOps 视图 → **集群** → 为集群名创建令牌（在 agent 连接前状态为 `pending`）。
2. 部署 `agent/deploy/rbac.yaml` 与 Deployment，`AIOPS_AGENT_NAME` 设为该名称，`AIOPS_AGENT_SERVER` 设为**从集群内部**可访问的 `/api/aiops/agent` 地址。
3. 让告警携带集群名。incident router 默认读取 `cluster` 告警 label（`aiops-incident-router` 条目的 `clusterLabel`），把每个轮次绑定到该 agent；观测工具随后只读取该集群。`AIOPS_DEFAULT_CLUSTER`（router 与 `aiops-kubernetes` 共用）用于没有该 label 的告警；留空可让未标注集群的告警显式退化为 Alertmanager/Prometheus 证据，而不是读取默认集群。

server 不持有任何集群凭据。在 Portal 中吊销集群会立即断开其在线 agent；只有从未连接过的集群才能重签令牌。零集群时 `/api/aiops/readyz` 仍为 ready，并报告 `components.clusters` 与 `configured`/`total`/`connected`。

## 容器镜像

仓库自带多阶段 `Dockerfile`：在 `node:24-slim` 上构建 GitHub 源码 bundle，构建期预置 DSH Web profile，并由 `docker-entrypoint.sh` 启动——容器首次启动无需网络。Session、SQLite 存储、设置和 `.credentials.yaml` 全部位于 `DSH_HOME` 卷（`/data`）：

```sh
docker build -t dsh-aiops:dev .
docker run -d --name dsh-aiops -p 8080:8080 -p 3081:3081 \
  -v dsh-aiops-data:/data \
  -e AIOPS_ALERTMANAGER_WEBHOOK_SECRET='<long-random-value>' \
  dsh-aiops:dev
curl -s http://127.0.0.1:8080/api/aiops/healthz
```

用 `-e` 注入的凭证由环境回退解析；持久轮换应把它们移入 `/data/.credentials.yaml`（权限 `0600`）。DSH 拒绝通配绑定地址，所以 entrypoint 把 DSH Web 端口（`DSH_WEB_PORT`，默认 8080）和 Alertmanager 接收器（`AIOPS_WEBHOOK_PORT`，默认 3081）都绑定到容器主网卡地址；发布端口后宿主机仍可访问两者。在反向代理或编排器后面时，设置 `DSH_PUBLIC_URL` 并按空格分隔重复填写 `DSH_TRUSTED_HOSTS`（多个 authority），DSH 才信任外部 Host。上文 TLS 反向代理与信任边界的规则同样适用。

## 升级与配置迁移

升级前备份 DSH settings 文档、Session workspace、`<DSH_HOME>/storages/`（`aiops_incident` 与 `aiops_delivery` 域）、`aiops-router.sqlite` 与凭据文件。存储域就是 `storages/<domain>/<table>/<key>.json` 下的普通 JSON；在 DSH 停止时整体复制 `storages/` 目录，恢复时保持属主一致与 `0600`/`0700` 权限。启动时不再匹配当前 schema 的记录会被移走并跳过，而不会阻塞启动，因此务必保留升级前的副本作为恢复点。Router schema 会接受 F.2 之前的 `alertnameAllowlist`，使旧 profile 能启动并输出弃用警告，同时采用安全的通用默认值：忽略 `Watchdog` 和 `InfoInhibitor`，缺失/未知 severity 映射为 `warning`。启动后应立即把旧字段替换为显式 `routingPolicy`；旧 allowlist 不会被错误解释为排除列表。

路由设置以 `aiops-routing` version 1 保存。Portal 写入带 revision fence，原子提交完整策略，保存前要求 dry-run，并记录到 `routing_policy_audit`。非法的并发或 Token 预算关系会在持久化前拒绝。

可复制的字段值和 dry-run labels 见[路由策略 JSON 示例](examples/README.zh.md)。

全新安装或升级应依次执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm exec vitest run
pnpm run build:github
node scripts/check-links.mjs
pnpm --filter @deepseek-ai/dsh-aiops pack
```

先在一次性 DSH profile 安装 bundle、检查 `config dump`、用一次性凭据启动、验证健康/就绪/指标和 canary webhook，再执行卸载。升级时使用旧 profile 副本重复验证事件存储（`aiops_incident`）、推送标记（`aiops_delivery`）、Session 历史、队列恢复、设置和 Portal。卸载只移除插件注册，不会静默删除 DSH home、存储域、Session JSONL、SQLite、settings 或凭据；这些数据必须按部署保留策略显式归档或删除。

支持的运行时为 Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、Cordis `^4.1.0` 和 DSH `0.2.2-rc.1` 包 API。DSH 包版本变化必须重新执行一次性 profile 升级矩阵。
