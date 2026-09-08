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

## 升级与配置迁移

升级前备份 DSH settings 文档、Session workspace、`aiops-router.sqlite` 与凭据文件。Router schema 会接受 F.2 之前的 `alertnameAllowlist`，使旧 profile 能启动并输出弃用警告，同时采用安全的通用默认值：忽略 `Watchdog` 和 `InfoInhibitor`，缺失/未知 severity 映射为 `warning`。启动后应立即把旧字段替换为显式 `routingPolicy`；旧 allowlist 不会被错误解释为排除列表。

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

先在一次性 DSH profile 安装 bundle、检查 `config dump`、用一次性凭据启动、验证健康/就绪/指标和 canary webhook，再执行卸载。升级时使用旧 profile 副本重复验证 Session 历史、队列恢复、设置和 Portal。卸载只移除插件注册，不会静默删除 DSH home、Session JSONL、SQLite、settings 或凭据；这些数据必须按部署保留策略显式归档或删除。

支持的运行时为 Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、Cordis `^4.0.2` 和 DSH `0.1.2-rc.1` 包 API。DSH 包版本变化必须重新执行一次性 profile 升级矩阵。
