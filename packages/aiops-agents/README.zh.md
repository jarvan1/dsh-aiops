---
description: "server 侧集群 agent 注册表与 WebSocket 网关：为每个集群签发一个令牌，跟踪 agent 存活状态，并通过 Go agent 执行有界只读查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-agents

[English](README.md) | 中文

## 概要

本包承载多集群 agent 的 server 半部分。它在插件自有的 `aiops_agent` 存储域中为每个集群保留一条持久记录（名称、令牌 SHA-256 摘要、末四位、时间戳、最近上报的 agent 版本），提供令牌创建、重签与吊销，并在 `/api/aiops/agent` 终止每个 Go agent 主动发起的 WebSocket。`ctx.aiopsAgents` 服务提供 `probe` 与类型化读取，按请求 id 关联结果，并把 agent 的封闭错误码映射到统一的 Kubernetes 查询错误码。server 不持有任何 kubeconfig、不会主动连接集群，除创建响应外也不会再看到明文令牌。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

与存储栈一起挂载；host 提供 webserver 时，它会自行注册 agent WebSocket 路由。

```yaml
- id: aiops-agents
  name: '@deepseek-ai/dsh-aiops-agents'
  config:
    maxClusters: 50
    requestTimeoutMs: 30000
    handshakeTimeoutMs: 10000
    pingIntervalMs: 30000
    idleTimeoutMs: 90000
    maxPendingRequests: 32
```

AIOps Portal 挂载本服务并暴露运维入口：快照中的集群列表，以及 `POST /api/aiops/portal/clusters`（创建）、`/clusters/token`（重签）、`/clusters/revoke`、`/clusters/probe`。只有创建与重签的响应会携带明文令牌，且仅一次。

接入集群：先在 Portal 中签发令牌，然后按 [`agent/`](../../agent/README.zh.md) 的说明，用该令牌和**从集群内部可访问**的 server 地址安装 agent。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 —— 点击展开</summary>

令牌为 `dsha_` 加 32 字节随机数的 base64url。持久记录只保留摘要与末四位；内存中的“摘要 → 名称”索引在存储域打开时重建，以常数时间服务 upgrade 路径。网关在 upgrade 之前认证 bearer 令牌，要求在握手截止时间内收到合法 `hello`，拒绝名称与令牌所属集群不一致的 `hello`，并以最新连接替换同名旧连接（关闭码 `4006`）。读请求携带生成的 id、单请求截止时间与取消信号，由 pending 表关联结果；连接关闭或被替换时，所有在途读以 `unreachable` 失败。吊销会删除摘要、以 `4001` 关闭在线连接，并让之后的 upgrade 收到 HTTP 401。心跳最多每分钟刷新一次 `lastSeenAt`，避免空闲集群频繁写盘。状态是派生的：`revoked` 优先，其次在线为 `connected`，首次握手前为 `pending`，之后为 `offline`。

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 协议消息、能力集、集群视图、错误码分类 |
| [`src/tokens.ts`](src/tokens.ts) | 令牌生成、摘要比较、bearer 解析 |
| [`src/gateway.ts`](src/gateway.ts) | upgrade、握手、保活、结果关联、关闭码 |
| [`src/store.ts`](src/store.ts) | `aiops_agent` 存储域定义与 `ctx.aiopsAgents` 服务 |
| [`src/index.ts`](src/index.ts) | 插件入口、配置 schema、导出 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Agent 协议 v1](../../agent/docs/protocol.zh.md) —— 消息、错误码、关闭码与边界。
- [Agent 安装指南](../../agent/README.zh.md) —— 镜像、RBAC、Deployment 与令牌文件。
- [Portal 包](../aiops-portal/README.zh.md) —— 调用本服务的运维界面。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **连接归属单个副本。** 在线 socket 是进程内状态。多副本部署时，读请求只有在持有该 agent socket 的副本上才能成功；在共享连接路由出现之前，请把诊断流量路由到该副本，或只运行一个副本。
- **诊断读取已接入（M2）。** `dsh-aiops-kubernetes` 解析轮次的集群绑定并通过本服务执行读取；`probe` 支撑 Portal 中的集群连通性。
- **没有升级状态机。** `desiredVersion` 会被保存并在 `welcome` 中下发，但 `drain`/`resume` 协调与 Portal 升级流程属于 M3；agent 按设计拒绝自升级。
- **TLS 由部署方负责。** 路由使用 host webserver 的监听器；请通过 host 的 `tls` 配置或反向代理终止 TLS，让 agent 可以使用 `wss`。
- **令牌没有轮换周期。** 一个令牌属于一个集群，直到被吊销；已连接过的集群通过“吊销后重新创建”完成轮换。
