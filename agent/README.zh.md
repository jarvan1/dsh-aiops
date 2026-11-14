# AIOps 集群 agent

[English](README.md) | 中文

安装在每个 Kubernetes 集群中的小型 Go 进程，主动连接一个 DSH AIOps server，并回答有界的只读查询。它的目的是让 AIOps Host 不再需要为每个集群维护 kubeconfig：集群身份来自 client name 与令牌，网络连接始终是集群 → server 方向。

> **状态。** agent、协议 v1、镜像、只读 RBAC 与 server 侧网关均已实现并有测试覆盖。令牌在 AIOps Portal 中签发，server 在 `/api/aiops/agent` 完成认证、状态跟踪、探测与吊销。诊断工具现在通过 agent 读取：router 按告警的 `cluster` label 把每个轮次绑定到集群，Kubernetes 工具读取该集群；Host 侧 kubeconfig Provider 已删除。滚动升级流程属于 M3。参见[协议说明](docs/protocol.md)与 [TODO](../TODO.md)。

## 工作方式

- 使用 `Authorization: Bearer <token>` 连接 `wss://<server>/api/aiops/agent`，并发送一条 `hello`，携带不可变的 client name、构建版本与能力集。server 返回 `welcome`；协议主版本不一致时直接拒绝，不做猜测兼容。
- 只回答封闭的操作集合：`get`、`list`、`events`、`logs`。不存在随意 verb、path、URL 或 kubectl 透传，因此即使 server 被攻破，也无法把 agent 变成任意 API 客户端。
- 通过 Pod 的 service-account 令牌与集群 CA 直接发 REST 请求（不使用 client-go），让二进制更小、可审计面更窄。每次请求都会重新读取令牌文件，因此 projected token 轮换无需重启。
- 对每个回答设界：响应字节上限、日志行数上限、并发上限、单次读超时、入站消息大小上限。超限或格式错误会映射为类型化错误，绝不返回半截 JSON。
- 发送心跳与 WebSocket ping；server 长时间静默会被识别，并以带上限与抖动的指数退避重连。`401`/`403` 与协议不兼容属于致命错误，不重试。
- 响应 `drain`/`resume`：drain 期间以 `busy` 拒绝新读请求，等待在途请求完成，使滚动升级不会打断一次诊断。`upgrade` 会被明确拒绝 —— 由发布系统替换镜像（path A）。

## 安装

agent 镜像使用仓库根目录作为构建上下文，由 [Dockerfile.agent](../Dockerfile.agent) 构建：

```sh
docker build -f Dockerfile.agent -t registry.example.com/aiops-agent:0.1.0 .
```

然后在每个集群中执行：

1. **创建命名空间与 service account。**

   ```sh
   kubectl create namespace aiops
   kubectl apply -f deploy/rbac.yaml
   ```

   ClusterRole 仅授予 [internal/kube/resource.go](internal/kube/resource.go) 中资源的 `get`/`list`、核心 Events 的 `get`/`list`，以及 `pods/log` 的 `get`，不能读取 Secret，也不能修改任何对象。

2. **在 Portal 中签发令牌。** 打开 AIOps 视图，进入 **集群 → 创建令牌**（全新安装时首页会直接提示）。名称必须与之后传入的 `--name` 一致。明文令牌只展示一次，server 只保留它的 SHA-256 摘要与末四位。不要提交到仓库，也不要通过命令行参数传递。

   ```sh
   kubectl -n aiops create secret generic aiops-agent-token --from-file=token=./token
   ```

3. **应用 Deployment。** 复制 [deploy/deployment.yaml](deploy/deployment.yaml)，填写 `AIOPS_AGENT_SERVER`、`AIOPS_AGENT_NAME` 与镜像地址后应用。`AIOPS_AGENT_SERVER` 必须是**从集群内部**可解析、可路由的地址，例如 `wss://aiops.example.com/api/aiops/agent`；server 不会因为 agent 恰好在本机而推断、改写或特殊处理回连地址。Pod 以非 root 运行、根文件系统只读，不需要 Service 或 Ingress。

4. **验证。** Portal 中该集群状态变为 `connected`，agent 日志出现 `agent connected`。令牌被拒时日志为 `agent token was rejected by the server`，进程以非零状态退出；吊销集群会立即关闭在线连接，该令牌随即失效。

## 配置

命令行参数覆盖环境变量默认值。令牌只从文件读取。

| 参数 | 环境变量 | 默认值 | 含义 |
|---|---|---|---|
| `--server` | `AIOPS_AGENT_SERVER` | — | server WebSocket URL；要求 `wss`（仅本地测试允许 `ws`） |
| `--name` | `AIOPS_AGENT_NAME` | — | 不可变的 client name，即集群身份（DNS label，≤63 字符） |
| `--token-file` | `AIOPS_AGENT_TOKEN_FILE` | — | 保存本 client 令牌的文件 |
| `--max-response-bytes` | — | `2000000` | Kubernetes 响应体上限 |
| `--max-tail-lines` | — | `2000` | 单次请求日志行数上限 |
| `--default-tail-lines` | — | `200` | 请求未提供 `tailLines` 时的行数 |
| `--concurrency` | — | `4` | 并发读上限（1..64）；超出的请求返回 `busy` |
| `--heartbeat` | — | `15s` | 心跳间隔（1s..5m） |
| `--request-timeout` | — | `30s` | 单次 Kubernetes API 读超时 |
| `--service-account-dir` | — | `/var/run/secrets/kubernetes.io/serviceaccount` | 凭据挂载目录；仅在本机对集群调试时覆盖 |
| `--log-level` | — | `info` | `debug`、`info`、`warn`、`error` |
| `--version` | — | — | 打印构建版本后退出 |

读请求未提供 namespace 时使用 agent 自身所在命名空间。Node、Namespace、PersistentVolume 属于集群级资源，会忽略 namespace 字段。

## 能力

| 操作 | 请求字段 | 结果 |
|---|---|---|
| `get` | `resource`、`name`、可选 `namespace` | 单个 Kubernetes 对象的 JSON |
| `list` | `resource`、可选 `namespace`、selector | 一页列表；`truncated` 表示存在 `continue` 令牌 |
| `events` | 可选 `namespace`、selector、`sinceTime`、`untilTime` | 按开始时间排序并按闭区间发生时间过滤的 Event |
| `logs` | `pod`、可选 `namespace`、`container`、`previous`、`tailLines`、`since`、`sinceTime`、`untilTime`、`timestamps` | 有界日志文本；绝对上界在本地过滤 |

资源名称与原生 Provider 一致：`pod(s)`、`service(s)`、`endpoint(s)`、`configmap(s)`、`pvc`/`persistentvolumeclaim(s)`、`node(s)`、`namespace(s)`、`pv`/`persistentvolume(s)`、`deployment(s)`、`statefulset(s)`、`daemonset(s)`、`replicaset(s)`、`job(s)`、`cronjob(s)`。

错误码与原生 Provider 相同 —— `invalid_request`、`unsupported_resource`、`not_found`、`forbidden`、`authentication_failed`、`timeout`、`response_too_large`、`invalid_response`、`unreachable` —— 另加 `busy`，server 会把它映射为 `unreachable`，使过载的 agent 被快速失败切换而不是拖住诊断。

## 开发

```sh
cd agent
go vet ./...
go test ./...
go build ./cmd/aiops-agent
```

测试覆盖协议校验、executor 对假 Kubernetes API 的行为（allowlist、名称校验、状态码映射、大小上限、Event 时间窗、日志边界）、WebSocket 循环对假 server 的行为（认证头、hello/welcome、结果关联、probe、drain、拒绝 upgrade、心跳、401 致命、协议不匹配、重连）以及配置解析。

不构建镜像也可以对真实集群验证：把 `--service-account-dir` 指向一个包含 service-account 令牌、命名空间与 `ca.crt` 的目录，并连接本地 stub server：

```sh
mkdir -p /tmp/aiops-sa
kubectl -n aiops create token aiops-agent --duration=1h > /tmp/aiops-sa/token
printf 'aiops' > /tmp/aiops-sa/namespace
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > /tmp/aiops-sa/ca.crt
KUBERNETES_SERVICE_HOST=127.0.0.1 KUBERNETES_SERVICE_PORT=6443 \
  go run ./cmd/aiops-agent --server ws://127.0.0.1:9099/agent --name local-test \
  --token-file ./server-token --service-account-dir /tmp/aiops-sa
```

`--token-file` 是 AIOps server 的令牌，不是 service-account 目录中的 Kubernetes 令牌，两者受众不同，且必须与 server 期望的值一致；只有连接本地 stub 时才允许使用 `ws`，stub 也必须校验令牌。

| 路径 | 内容 |
|---|---|
| `cmd/aiops-agent/` | 参数、信号、日志与构建版本 |
| `internal/protocol/` | 版本化消息、校验、错误码 |
| `internal/kube/` | 集群内 REST 客户端、allowlist、有界 executor |
| `internal/agent/` | 拨号、握手、保活、分发、重连 |
| `internal/config/` | 参数/环境变量解析、令牌加载 |
| `deploy/` | 只读 RBAC 与 Deployment 示例 |

## 安全说明

- agent 不监听端口、不在 Pod 内执行命令、不向集群写入任何内容。
- RBAC 清单与 executor 的 allowlist 必须同步修改；`kubectl auth can-i --list --as=system:serviceaccount:aiops:aiops-agent` 应当只显示文档中列出的动词。
- 令牌文件只能包含一个令牌。错误信息不会包含令牌、server URL 的查询参数，也不会包含超出有界状态消息的 Kubernetes 响应体。
- 集群身份是令牌绑定的 client name，而不是 `hello` 中的名称，也不是告警 payload 里的 label；`hello` 声明的名称不一致时以 `4003` 关闭连接。
- 吊销集群会从注册表删除摘要、以 `4001` 关闭在线连接，并让此后所有连接收到 HTTP 401。

## 限制

- 一个 agent 进程持有一条连接。若两个连接使用同一名称，最新握手获胜，旧连接以 `4006` 关闭；server 只向存活的那一条路由读请求。
- list 与 Event 查询只返回单页。存在 `continue` 令牌时会置位 `truncated`，但不会自动翻页，以保证单次请求的内存有界。
- 按设计不实现自升级（path A：由发布系统替换镜像）。server 仍可发送 `drain`，等待在途读完成后让发布继续。
- Kubernetes 需提供核心 `events` API 与 Pod 日志端点；所有受支持的上游版本都具备。
