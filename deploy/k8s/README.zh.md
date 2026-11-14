# 在 Kubernetes 上部署 server

[English](README.md) | 中文

本示例把 AIOps server（[`dsh-aiops.yaml`](dsh-aiops.yaml)）作为单副本 Deployment 运行，并把 `DSH_HOME` 放在持久卷上；同时把集群 agent（[`agent/deploy/`](../../agent/deploy/)）装进同一个集群。它是起点，不是完整方案：TLS 终止、入口认证、备份与存储类选择仍由部署方负责。

## 前置条件

- 由 [`Dockerfile`](../../Dockerfile) 构建的 server 镜像，并已加载进集群。清单中的 `image:` 标签必须与你构建、导入的标签一致；不一致会让 Pod 停在 `ImagePullBackOff` 并尝试从 Docker Hub 拉取。若节点无法访问公网 registry：

  ```sh
  docker build -t dsh-aiops:0.2.0-rc.1 .
  docker save dsh-aiops:0.2.0-rc.1 -o /tmp/dsh-aiops.tar
  sudo k3s ctr images import /tmp/dsh-aiops.tar
  ```

- 由 [`Dockerfile.agent`](../../Dockerfile.agent) 构建的 agent 镜像，同样加载：

  ```sh
  docker build -f Dockerfile.agent -t aiops-agent:0.2.0-rc.1 .
  docker save aiops-agent:0.2.0-rc.1 -o /tmp/aiops-agent.tar
  sudo k3s ctr images import /tmp/aiops-agent.tar
  ```

- 为 2 GiB 的 `DSH_HOME` claim 提供默认 StorageClass；如果需要真正运行诊断，还需在 DSH Web profile 中配置模型（Portal、就绪检查与 agent 网关在没有模型时也能工作）。

## 安装

1. **创建 webhook secret。** 替换清单中的占位值，或把 Secret 移出仓库：

   ```sh
   kubectl create namespace aiops
   kubectl -n aiops create secret generic dsh-aiops-credentials \
     --from-literal=webhook-secret="$(openssl rand -hex 24)"
   ```

   随后在 apply 前删除 `dsh-aiops.yaml` 中的 Secret 段。

2. **设置公开地址与可信 Host。** `DSH_PUBLIC_URL` 是浏览器与远端 agent 使用的源；`DSH_TRUSTED_HOSTS` 必须包含客户端实际发送的每个 authority：公开域名，以及集群内 agent 回连的 Service 地址。缺少 authority 会在 WebSocket upgrade 之前被拒绝，agent 日志表现为 `unexpected EOF`。

3. **应用 server 并暴露。**

   ```sh
   kubectl apply -f deploy/k8s/dsh-aiops.yaml
   kubectl -n aiops rollout status deployment/dsh-aiops
   ```

   在 `dsh-aiops:8080` 前放置带 TLS 的 ingress 或反向代理；agent 应使用 `wss://`。Webhook listener（`:3081`）只应对 Alertmanager 可达。

4. **创建集群令牌。** 打开 Portal（或在公开源上 `GET /api/aiops/portal`），进入 **集群 → 创建令牌**，名称与 agent 的 `--name` 一致。

5. **安装 agent。** 应用 RBAC、创建令牌 Secret，并用该令牌部署：

   ```sh
   kubectl apply -f agent/deploy/rbac.yaml
   kubectl -n aiops create secret generic aiops-agent-token --from-file=token=./agent-token
   kubectl -n aiops apply -f agent/deploy/deployment.yaml
   ```

   `AIOPS_AGENT_NAME` 填令牌对应的集群名，`AIOPS_AGENT_SERVER` 填**从集群内部**可访问的地址 —— 同集群 agent 可用 `ws://dsh-aiops.aiops.svc.cluster.local:8080/api/aiops/agent`，远端 agent 用 `wss://aiops.example.com/api/aiops/agent`。Deployment 中的镜像要换成上面加载的镜像。

6. **验证。** Portal 中该行变为 `connected`；`/api/aiops/readyz` 报告 `clusters.configured: true` 与在线数量。可在集群页执行探测。

## 运维

- **升级**由运维执行。在 Portal 中点击**准备升级**、填写目标版本，然后滚动 agent 镜像（`kubectl -n aiops set image deployment/aiops-agent agent=<image>:<version>`）。在途读取完成、新读取在 drain 期间失败转移，替换 agent 连接后自动清除 drain。**恢复读取** 可取消已准备的发布。
- **备份**：`dsh-data` 卷保存 Session、SQLite、设置与凭据，请与工作区一起备份；保持单副本（在线 socket 是进程内状态）。
- **令牌**在 Portal 中签发、仅保存摘要，一个令牌属于一个集群；轮换用吊销后重建。

## 本机 k3s 说明

- 集群无法拉取公网镜像时，按上面步骤导入镜像。`local-path` provisioner 还会用 `rancher/mirrored-library-busybox:1.37.0` 创建 helper pod（见 `kube-system/local-path-config`），该镜像也要导入，否则 PVC 会停在 Pending 并记录 `trying and failing to pull image`。PVC 为 `WaitForFirstConsumer`，只有 Pod 挂载后才会绑定。
- 若宿主机拦截 DNS（例如透明代理返回 `198.18.0.0/15` 的 fake IP），集群内 Service 名可能解析到代理地址；此时在 `AIOPS_AGENT_SERVER` 中使用 Service ClusterIP 或节点地址，并把该 authority 加入 `DSH_TRUSTED_HOSTS`。
- 已在本机 k3s 验证：部署 server 镜像（先用 hostPath，导入 helper 镜像后改用清单中的真实 PVC）、通过部署后的 Portal API 签发令牌、以 Pod 运行 agent（使用已提交 RBAC 与 service-account 令牌）并探测、drain 后替换为 2.0.0、最后吊销。
