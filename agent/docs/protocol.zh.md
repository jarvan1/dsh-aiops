# Agent 协议 v1

[English](protocol.md) | 中文

一个集群 agent 与 DSH AIOps server 之间的契约。它刻意保持很小：一条仅向外发起的 WebSocket，承载版本化握手、保活消息与封闭的有界读请求集合。不存在通用 RPC，server 不能指定路径或 URL，也不存在任何写操作。

实现位置：[`internal/protocol`](../internal/protocol/messages.go)、[`internal/agent`](../internal/agent/client.go)、[`internal/kube`](../internal/kube/executor.go)。

## 传输与认证

| 属性 | 取值 |
|---|---|
| 端点 | `wss://<server>/api/aiops/agent`（仅本地测试允许 `ws`） |
| 方向 | agent 主动连接 server。server 从不反向连接集群。 |
| 认证 | WebSocket upgrade 请求上的 `Authorization: Bearer <token>` |
| 令牌 | 不透明、由 server 签发、绑定一个 client name；agent 从文件读取 |
| 帧格式 | JSON 文本消息，一条消息一帧 |
| 入站上限 | 每条消息 1 MiB（实际请求远小于此） |
| 保活 | 每 `--heartbeat`（默认 15s）发送心跳，每半个间隔发送 ping |
| 存活检测 | 每条消息与 pong 都刷新读截止时间；静默超过三个心跳即重建连接 |

令牌是唯一凭据。用错误的 client name 出示令牌会得到 `401`；只有通过认证的 `hello` 中携带的 name 才标识集群。server 必须用存储的哈希而非明文比对令牌，并拒绝同一令牌用于第二个 name。

## 生命周期

```text
agent                                   server
  | -- upgrade + Authorization: Bearer -->|
  |<-------------- 101 Switching Protocols|
  | -- hello {protocol,name,version,caps}>|
  |<-- welcome {protocol,clientId,...} ---|
  | -- heartbeat ------------------------>|  每个间隔
  |<-- read {id,op,...} ------------------|
  | -- result {id,ok,data|code} --------->|
  |<-- drain -----------------------------|  可选，升级前
  | -- result {id,busy} 拒绝新读请求 ----->|
  |<-- resume ----------------------------|
  | -- close / 带退避重连 ---------------->|
```

连接关闭、超时或写入失败后会被丢弃，并以带上限的指数退避（1s → 60s，抖动最高 50%）重建。`401`/`403` 与任何协议不匹配属于致命错误，不重试；进程以非零状态退出，让 Kubernetes 暴露该故障。

## 消息

所有消息都是带 `type` 判别字段的 JSON 对象。未知或格式错误的 **server** 消息会关闭连接：静默忽略会让某个请求永远得不到回答。

### agent → server

#### `hello`

```json
{
  "type": "hello",
  "protocol": 1,
  "name": "prod-east",
  "version": "0.1.0",
  "capabilities": {
    "resources": ["configmaps", "pods", "..."],
    "events": true,
    "logs": true,
    "maxResponseBytes": 2000000,
    "maxTailLines": 2000
  }
}
```

`name` 是不可变的 client name（DNS label）。多个 Pod 可以共用它，server 将其视为一个逻辑客户端。`capabilities.resources` 列出可通过 `get`/`list` 访问的规范名称，`events` 与 `logs` 声明专用查询，两个上限让 server 无需往返即可拒绝不可能完成的请求。

#### `heartbeat`

```json
{ "type": "heartbeat", "version": "0.1.0", "inflight": 2 }
```

`inflight` 是当前正在执行的读请求数。

#### `result`

```json
{ "type": "result", "id": "7f3c", "ok": true, "data": { }, "truncated": false }
{ "type": "result", "id": "7f3d", "ok": false, "code": "forbidden", "message": "Kubernetes denied the requested read operation." }
```

每个请求 id 恰好收到一条结果。`get`/`list`/`events` 的 `data` 是 Kubernetes JSON 对象，`logs` 是字符串，`probe` 是对象。`message` 上限 512 字符。

### server → agent

#### `welcome`

```json
{ "type": "welcome", "protocol": 1, "clientId": "cli_01", "desiredVersion": "0.1.0" }
```

`protocol` 必须等于 agent 的主版本。`clientId` 是 server 为本次注册分配、用于日志与 Portal 的 id。`desiredVersion` 仅作提示，让 server 展示版本漂移，而不允许 agent 自行替换。

#### `read`

```json
{
  "type": "read",
  "id": "7f3c",
  "op": "logs",
  "namespace": "payments",
  "pod": "api-1",
  "container": "api",
  "tailLines": 200,
  "since": "15m",
  "timestamps": true
}
```

| 字段 | 适用操作 | 规则 |
|---|---|---|
| `id` | 全部 | 1..128 个 `[A-Za-z0-9._:-]` 字符 |
| `op` | 全部 | `get`、`list`、`events`、`logs` 之一 |
| `resource` | `get`、`list` | 必填；必须在 agent allowlist 中 |
| `name` | `get` | 必填；DNS subdomain，≤253 字符 |
| `namespace` | `get`、`list`、`events`、`logs` | 可选；缺省为 agent 自身命名空间；必须是 DNS label |
| `labelSelector` | `list`、`events` | ≤1024 字符 |
| `fieldSelector` | `list`、`events` | ≤1024 字符 |
| `sinceTime` / `untilTime` | `events`、`logs` | RFC3339；闭区间；`sinceTime` 不得晚于 `untilTime` |
| `pod` | `logs` | 必填；DNS subdomain |
| `container` | `logs` | 可选；DNS label |
| `previous` | `logs` | 可选；读取上一个已终止实例 |
| `tailLines` | `logs` | 可选正整数；钳制到 agent 上限 |
| `since` | `logs` | 可选 Kubernetes duration `30s`/`15m`/`2h`/`1d`；与 `sinceTime` 互斥 |
| `timestamps` | `logs` | 可选；存在 `untilTime` 时强制开启 |

`events` 忽略 `resource`，始终读取命名空间内的核心 `v1` Event。`logs` 读取 `/api/v1/namespaces/<ns>/pods/<pod>/log`，不 follow。

#### `probe`

```json
{ "type": "probe", "id": "7f3e" }
```

回答 `{ name, version, protocol, capabilities }`，让 server 无需额外往返即可渲染连接检查结果。

#### `upgrade`

```json
{ "type": "upgrade", "id": "7f3f", "targetVersion": "0.2.0" }
```

始终回答 `ok: false`、`code: invalid_request`、message 为 `self-upgrade is disabled; apply the rollout out of band`。path A 让 agent 保持只读：由发布系统替换镜像，server 用 `drain`/`resume` 协调。

#### `drain` / `resume`

无字段、无确认。drain 期间新读请求得到 `busy`；已执行的读请求正常完成并返回真实结果。server 应等待在途结果（或心跳中的 `inflight` 归零）后再让发布终止 Pod。

#### `error`

```json
{ "type": "error", "code": "forbidden", "message": "client name does not match token" }
```

终止连接。agent 记录 code 与 message（两者都不允许包含令牌）。

## 错误码

封闭集合与 TypeScript Provider 一致，因此远端集群的失败方式与进程内 Provider 相同。server 将 `busy` 映射为 `unreachable`，从诊断工具的视角看是可重试的。

| code | 含义 | 典型来源 |
|---|---|---|
| `invalid_request` | 请求或名称/时长校验失败 | agent，在调用 API 之前 |
| `unsupported_resource` | 资源不在 allowlist 中 | agent |
| `not_found` | 对象不存在 | API server `404` |
| `forbidden` | RBAC 拒绝读取 | API server `403` |
| `authentication_failed` | service-account 令牌被拒或 CA 不匹配 | API server `401`、TLS |
| `timeout` | 超过单次读截止时间 | agent |
| `response_too_large` | 响应体超过 `--max-response-bytes` | agent |
| `invalid_response` | Kubernetes 返回非 JSON 或意外结构 | agent |
| `unreachable` | 网络失败或 API server `5xx` | agent |
| `busy` | 并发耗尽或 agent 正在 drain | agent |

错误消息有界，且不得包含令牌、Secret 内容或无界的 API 响应体。

## 版本策略

- `protocol` 是主版本。server 在 `welcome` 中声明版本；agent 拒绝任何不一致的版本并退出。
- 非破坏性新增（新的可选请求字段、已记录集合内的新错误码）保持在 v1；双方必须忽略未知字段。
- 破坏性变更提升主版本。滚动升级期间，server 必须同时支持上一个主版本，直到所有已注册客户端都报告新版本；agent 从不做猜测兼容。
- server 应记录 `hello` 中的 `version`，并与每个客户端的期望版本比较。应用新版本是运维动作（path A），不是自动推送。

## 边界

| 边界 | 默认值 | 执行方 |
|---|---|---|
| Kubernetes 响应体 | 2,000,000 字节 | agent，在 JSON 解码前 |
| 日志行数 | 默认 200，上限 2,000 | agent 查询参数 |
| 单连接并发读 | 4 | agent；超出返回 `busy` |
| 单次读截止时间 | 30s | agent |
| 入站协议消息 | 1 MiB | agent WebSocket 读限制 |
| 结果消息 | 错误消息 512 字符 | agent |
| Selector | 1,024 字符 | agent |

list 与 Event 响应只返回一页。`metadata.continue` 非空时置位 `truncated`；agent 不自动翻页，以保证单次请求内存有界。

## 关闭码

server 使用应用层关闭码，让双方能区分“策略决定”与“传输失败”。除令牌本身被拒外，agent 会把任何关闭都当作重连信号。

| code | 含义 |
|---|---|
| `4001` | 集群令牌被吊销；吊销时立即断开在线连接 |
| `4002` | 协议主版本不一致；在此之前会先收到一条 `error` |
| `4003` | `hello` 声明的集群与令牌不一致 |
| `4004` | 握手截止时间内没有收到合法 `hello` |
| `4005` | 协议违规：非 JSON、二进制帧、`hello` 格式错误或意外的消息类型 |
| `4006` | 被同一集群名称的新连接替换 |
| `4007` | server 正在关闭 |

在 upgrade 之前被拒绝的 agent 收到纯 HTTP `401` 并以非零状态退出 —— 在运维安装有效令牌之前，重试没有意义。

## 令牌签发与吊销

- server 在 Portal 中签发令牌，而不是由 agent 申请。令牌格式为 `dsha_` 加 32 字节随机数的 base64url。
- 持久化只保留 SHA-256 摘要与末四位，存放在 `aiops_agent` 存储域，同时记录集群名称、创建时间与最近一次握手。
- 明文只在创建响应中返回一次，永远不会进入快照、日志或 URL。
- 从未完成握手的集群可以重签令牌；完成握手后，唯一的轮换方式是吊销后重新创建。
- 吊销会从内存索引中删除摘要、以 `4001` 关闭在线连接，并让此后的 upgrade 收到 `401`；持久记录保留用于审计，状态显示为 `revoked`。

## server 实现（本仓库）

- `packages/aiops-agents` 在精确路径 `/api/aiops/agent` 完成 upgrade，并在任何协议消息之前认证 bearer 令牌。
- 集群记录在 `pending`（已签发未连接）、`connected`、`offline`、`revoked` 之间流转；Portal 只渲染这些状态，永远拿不到令牌或摘要。
- 读请求按 `id` 关联并带截止时间（默认 30s）；`busy` 翻译为 `unreachable`。连接缺失或被替换同样返回 `unreachable`，使诊断失败转移而不是挂起。
- 入站帧上限为 4 MiB，对应 agent 2 MB 的 Kubernetes 响应上限加 JSON 开销。
- server 每 30s 发送一次 ping；超过空闲窗口即终止连接。`drain`/`resume` 与升级状态机属于 M3。
- server 记录 `clientId`、`name`、`version` —— 绝不记录令牌。
