# 用 Helm 在 Kubernetes 上部署 AIOps

[English](README.md) | 中文

部署由两个 chart 组成：

| Chart | 运行内容 | 范围 |
|---|---|---|
| [`deploy/helm/dsh-aiops`](../helm/dsh-aiops/) | AIOps server：Web UI、Portal API、webhook 入口、路由与集群 agent WebSocket 网关 | 每个 DSH 实例一个 release |
| [`deploy/helm/dsh-aiops-agent`](../helm/dsh-aiops-agent/) | 只主动向外连接、读取单个集群的 Go agent | 每个集群一个 release |

server 不持有任何集群凭据：每个集群安装 agent，由 agent 主动连接 server，server 从不主动连接集群。

## 前置条件

- Kubernetes 1.27 及以上，Helm 3.12+（Helm 4 同样可用）。
- 由 [`Dockerfile`](../../Dockerfile) 构建的 server 镜像，已推送到集群可拉取的 registry，或已存在于集群镜像存储中。
- 由 [`Dockerfile.agent`](../../Dockerfile.agent) 构建的 agent 镜像，同样可用。
- 为 2 GiB 的 `DSH_HOME` claim 提供默认 StorageClass，或使用 `persistence.existingClaim`；一次性测试可用 `persistence.enabled=false`。
- 如果需要真正运行诊断，需在 DSH profile 中配置模型。Portal、`/api/aiops/readyz`、令牌签发与 agent 网关在没有模型时都能工作。

## 1. 安装 server

在集群外创建 webhook secret 并引用它，避免该值进入 release 历史：

```sh
kubectl create namespace aiops
kubectl -n aiops create secret generic dsh-aiops-credentials \
  --from-literal=webhook-secret="$(openssl rand -hex 24)"

helm install dsh-aiops deploy/helm/dsh-aiops -n aiops \
  --set image.repository=registry.example.com/dsh-aiops \
  --set image.tag=0.2.0-rc.1 \
  --set credentials.existingSecret=dsh-aiops-credentials \
  --set dsh.publicUrl=https://aiops.example.com

kubectl -n aiops rollout status deployment/dsh-aiops
```

`dsh.publicUrl` 是浏览器与远端 agent 使用的源；可信 Host 由它推导，集群内 Service 的 authority 始终会加入。如果客户端通过其他 authority 访问（测试时的节点地址或 port-forward），用 `--set dsh.trustedHosts={127.0.0.1:8080}` 追加；缺少 authority 会在 WebSocket upgrade 前被拒绝。

`replicaCount` 保持为 1：在线 agent socket 是进程状态，读请求只有在持有该连接的副本上才能成功。

## 2. 暴露 server

在 web 端口前放置 TLS；远端 agent 必须使用 `wss://`。chart 可以直接渲染 Ingress：

```sh
helm upgrade dsh-aiops deploy/helm/dsh-aiops -n aiops \
  --reuse-values \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=aiops.example.com \
  --set ingress.tlsSecretName=aiops-tls
```

也可以使用 Gateway API 代替 Ingress；TLS 由父 Gateway 的 listener 终止：

```sh
helm upgrade dsh-aiops deploy/helm/dsh-aiops -n aiops \
  --reuse-values \
  --set gatewayApi.enabled=true \
  --set 'gatewayApi.parentRefs[0].name=gateway' \
  --set 'gatewayApi.parentRefs[0].sectionName=https' \
  --set 'gatewayApi.hostnames[0]=aiops.example.com'
```

chart 会渲染一条把 `/` 转发到 web Service 的 `HTTPRoute`；`ingress` 与 `gatewayApi` 二选一。不要把 webhook 端口（`3081`）暴露到公网，只让 Alertmanager 可达。

## 3. 创建集群令牌

打开 Portal 使用 **集群 → 创建令牌**，或调用同源 API：

```sh
curl -sS -X POST https://aiops.example.com/api/aiops/portal/clusters \
  -H 'content-type: application/json' \
  -d '{"name":"prod-sh"}'
```

响应中的明文令牌只出现一次；server 只保存其摘要与末四位。无效或已吊销的令牌会收到 HTTP 401。

## 4. 在集群中安装 agent

在每个集群执行，`cluster.name` 必须等于令牌对应的集群名，`cluster.serverUrl` 必须是**从该集群内部**可访问的地址：

```sh
kubectl create namespace aiops
kubectl -n aiops create secret generic aiops-agent-token --from-file=token=./agent-token

helm install dsh-aiops-agent deploy/helm/dsh-aiops-agent -n aiops \
  --set image.repository=registry.example.com/aiops-agent \
  --set image.tag=0.2.0-rc.1 \
  --set cluster.name=prod-sh \
  --set cluster.serverUrl=wss://aiops.example.com/api/aiops/agent \
  --set token.existingSecret=aiops-agent-token
```

chart 会创建 ServiceAccount、只读 ClusterRole（与 agent 资源白名单一致）、绑定与 Deployment。若要自行管理这些对象，设置 `rbac.create=false`。同集群 agent 的 `cluster.serverUrl` 可以用 `ws://dsh-aiops.aiops.svc.cluster.local:8080/api/aiops/agent`；流量离开集群时必须使用 `wss://`。

## 5. 验证

```sh
kubectl -n aiops get pods
kubectl -n aiops logs deployment/dsh-aiops-agent --tail=5
```

Portal 中的行变为 `connected`，`GET /api/aiops/readyz` 报告 `clusters.configured: true` 与在线数量；集群页的**探测**会实际走一次在线连接。

## 6. 升级 agent

升级由运维执行：

1. 在 Portal 点击**准备升级**并填写目标版本。server 保存版本并 drain agent：在途读取完成，新读取以 `unreachable` 失败转移。
2. 滚动镜像：

   ```sh
   helm upgrade dsh-aiops-agent deploy/helm/dsh-aiops-agent -n aiops \
     --reuse-values --set image.tag=<new-version>
   ```

3. 替换 Pod 以新版本连接后读取自动恢复。发布前取消可用 Portal 的**恢复读取**；`helm rollback` 同样有效。

## 7. 运维

- **备份**：`DSH_HOME` 保存 Session、SQLite、设置与凭据，请与工作区一起备份。`helm uninstall` 会删除 chart 创建的 PVC；需要保留时设置 `persistence.annotations."helm.sh/resource-policy": keep`。
- **令牌轮换**：在 Portal 中吊销集群并重新创建令牌，然后更新 agent Secret 并重启 Deployment。
- **卸载**：

  ```sh
  helm uninstall dsh-aiops-agent -n aiops
  helm uninstall dsh-aiops -n aiops
  kubectl delete namespace aiops
  ```

## 配置项

server 主要配置：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `image.repository` / `image.tag` | `dsh-aiops` / chart appVersion | server 镜像，必须与集群可拉取的标签一致 |
| `replicaCount` | `1` | agent socket 是进程状态期间保持单副本 |
| `dsh.publicUrl` | 空 | 浏览器与远端 agent 使用的源，可信 Host 由它推导 |
| `dsh.trustedHosts` | `[]` | 额外接受的 authority |
| `credentials.existingSecret` | 空 | 保存 webhook bearer 的 Secret（推荐） |
| `credentials.webhookSecret` | 空 | chart 自行创建 Secret 时使用的值 |
| `persistence.existingClaim` / `storageClass` / `size` | 空 / 空 / `2Gi` | `DSH_HOME` 卷 |
| `service.type` / `nodePorts` | `ClusterIP` / 空 | Service 暴露方式 |
| `ingress.enabled` / `host` / `tlsSecretName` | `false` / `aiops.example.com` / 空 | 可选的 web Ingress |
| `gatewayApi.enabled` / `parentRefs` / `hostnames` | `false` / `[]` / `[]` | 可选 `HTTPRoute`；至少需要一个父 Gateway 引用 |
| `observability.prometheusUrl` / `alertmanagerUrl` | 空 | 可选的集群内 endpoint |

agent 主要配置：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `cluster.name` | 必填 | 令牌对应的集群名 |
| `cluster.serverUrl` | 必填 | 从本集群可达的 agent endpoint |
| `token.existingSecret` / `existingSecretKey` | 空 / `token` | 保存令牌的 Secret（推荐） |
| `token.value` | 空 | chart 自行创建 Secret 时使用的值 |
| `serviceAccount.create` / `name` | `true` / release fullname | agent 身份 |
| `rbac.create` / `clusterRoleName` | `true` / `<fullname>-reader` | 只读 ClusterRole 与绑定 |
| `heartbeat` | `15s` | 心跳间隔 |
| `image.repository` / `image.tag` | `aiops-agent` / chart appVersion | agent 镜像 |
