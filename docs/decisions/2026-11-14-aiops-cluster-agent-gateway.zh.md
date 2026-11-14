# 通过出站 agent 访问每个集群

[English](2026-11-14-aiops-cluster-agent-gateway.md) | 中文

- **状态：** 已接受
- **日期：** 2026-11-14
- **背景：** DSH 0.2.2-rc.1

## 背景

最初的设计通过进程内的 `aiops-kubernetes` Provider 读取一个集群：AIOps Host 持有一个 kubeconfig（或 exec-credential），并在本机执行 `kubectl`。若用这种方式做多集群，Host 上需要为每个集群各准备一份 kubeconfig、需要把告警 payload 映射到 context 名称，并且需要 Host 能主动连到每个集群的 API server。前两项是单机凭据管理问题，第三项与常见的网络姿态相反：集群可以主动向外连接，但不接受外部主动连接。

早期讨论过的另一个方案 —— 用 Alertmanager label 选择 kubeconfig context —— 只解决了命名问题，没有解决凭据问题，并且依赖 Alertmanager 能访问一个能访问所有 API server 的 Host。

## 决定

每个集群运行一个只主动向外连接的小型 Go agent，AIOps server 不持有任何集群凭据：

- Portal 为每个集群签发一个令牌。令牌为 `dsha_` 加 32 字节随机数；server 只在 `aiops_agent` 存储域中保留其 SHA-256 摘要与末四位，同时记录集群名称、时间戳与最近上报的 agent 版本。
- 明文只在创建响应中展示一次，并附带安装步骤；它不会进入快照、日志、URL 或浏览器存储。
- agent 携带 bearer 令牌连接 `wss://<server>/api/aiops/agent`，发送包含名称、版本与能力集的 `hello`。server 认证摘要，要求 `hello` 名称与令牌所属集群一致，返回 `welcome`，并把类型化读请求路由到该连接。
- 协议面是封闭的：`get`、`list`、`events`、`logs`、`probe`。不存在 path、URL、verb 或 exec 透传，因此即使 server 被攻破，也无法把 agent 变成任意 API 客户端。agent 自己持有 allowlist 与 RBAC，server 无法扩大它。
- **原生 kubeconfig Provider 将在 M2 删除，包括运行 DSH 的那个集群。** 不保留本地回退，也不做 Provider 选择抽象。一个令牌属于一个集群；吊销后重新创建是唯一的轮换方式。
- **首次接入就是零集群的正常启动。** server 绝不在启动时生成或记录令牌。Portal 首页显示首次配置卡片提示创建令牌，`/readyz` 保持 ready，并报告 `components.clusters` 与 `configured`/`total`/`connected`。
- **agent 的 server 地址始终由部署方显式配置。** server 不会推断、改写或特殊处理同集群/loopback 地址。位于 DSH 所在集群的 agent 与远端 agent 使用相同的 URL 与网络路径，部署文档明确要求该地址必须能从集群内部访问。
- 一个集群最多一条在线连接。更新的握手会替换旧 socket（关闭码 `4006`）；吊销会关闭在线 socket（`4001`）并删除摘要，之后的 upgrade 收到 HTTP 401。

## 考虑过的替代方案

- **本地集群保留原生 Provider，只有远端集群走 agent。** 两套代码路径、两套配置面，并且长期诱惑人们对本地集群做特殊处理。否决：workspace 即集群身份应当一致适用。
- **做 Provider 选择抽象（每个集群可选 native 或 agent）。** 引入一个接口和一维设置，只为保留一条即将删除的路径。
- **在 Host 上长期保存每集群 kubeconfig 并用 label→context 映射。** 集群凭据留在 AIOps Host 上，要求 Host 能连到各 API server，并且对消失的集群没有存活状态可讲。
- **令牌按周期轮换。** 令牌标识的是集群而不是用户会话；吊销后重建更简单、更可审计。已连接的集群不能原地重签，从而避免悄悄让运行中的 agent 失效。
- **信任 `hello` 中声明的名称。** 令牌绑定名称；信任声明会让一个令牌冒领另一个集群的身份。
- **从浏览器 Host 头推断 agent 地址。** 反向代理、NAT 或分裂 DNS 会让浏览器的视角对集群内出站不可靠。显式地址只有一种失败模式（运维能看到的错误值），而不是隐藏的推断错误。

## 影响

正面：

- AIOps Host 不再需要 kubeconfig、exec 凭据，也不需要任何指向集群 API server 的入站路径。
- 凭据签发、可观测性与吊销集中在 Portal 一个流程；持久记录无需探测即可回答“这个集群是否已接入”。
- 集群身份由 server 签发的令牌确定，因此能跨 agent 重启、Pod 重新调度与多副本 agent 保持稳定。
- 封闭协议让两侧的攻击面都很小，agent 可以用只读 ClusterRole 运行。

负面 / 接受的代价：

- 每个部署（包括单个本地集群）多了一步引导：创建令牌、安装 agent、设置可从集群内访问的 server URL。
- 在线 socket 是进程内状态。多副本部署时，在共享连接路由出现之前，读请求只会在持有该连接的副本上成功；部署应运行单副本或按此路由诊断流量。
- 任何协议变更都要求 server 与 agent 一起发布；主版本在握手时校验，并且不支持原地自升级。
- M2 落地前，诊断工具仍走原生 Provider，因此部署会短暂同时存在两套接口。

## 验证

agent 侧由 `go test ./...`（41 个顶层测试，含子测试 60 个）与使用已提交 RBAC 的 k3s v1.36 运行覆盖。server 侧由工作区测试覆盖：令牌签发与哈希、跨重启的注册表生命周期、经注册 upgrade 路由的完整握手与 probe、认证/名称/协议拒绝、结果关联与超时、吊销与连接替换、Portal 集群路由（一次性令牌、跨站拒绝、快照不含摘要）以及零集群 readiness。跨语言冒烟用真实 Go agent 连接真实 TypeScript 网关：令牌认证、`hello`/`welcome`、`probe` 能力集、`unsupported_resource` 与 `unreachable` 映射，以及 `4001` 吊销断开。
