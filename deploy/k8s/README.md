# Deploying AIOps on Kubernetes with Helm

English | [中文](README.zh.md)

Two charts cover the deployment:

| Chart | Runs | Scope |
|---|---|---|
| [`deploy/helm/dsh-aiops`](../helm/dsh-aiops/) | The AIOps server: web UI, Portal API, webhook ingress, routing, and the cluster-agent WebSocket gateway | One release per DSH instance |
| [`deploy/helm/dsh-aiops-agent`](../helm/dsh-aiops-agent/) | The outbound-only Go agent that reads one cluster | One release per cluster |

The server holds no cluster credential. Each cluster installs the agent, and the agent dials the server; the server never dials a cluster.

## Prerequisites

- Kubernetes 1.27 or later with Helm 3.12+ (Helm 4 works too).
- The server image built from [`Dockerfile`](../../Dockerfile), pushed to a registry the cluster can pull from, or otherwise present in the cluster's image store.
- The agent image built from [`Dockerfile.agent`](../../Dockerfile.agent), available the same way.
- A default StorageClass for the 2 GiB `DSH_HOME` claim, or `persistence.existingClaim`, or `persistence.enabled=false` for a throwaway test.
- A model configured in the DSH profile if diagnoses should run. The Portal, `/api/aiops/readyz`, token issuance, and the agent gateway all work without one.

## 1. Install the server

Create the webhook secret out of band and reference it, so the value never enters a release history:

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

`dsh.publicUrl` is the origin browsers and remote agents use. Trusted hosts are derived from it, and the in-cluster Service authority is always added. If a client reaches the server through another authority (a node address or port-forward during a test), add it with `--set dsh.trustedHosts={127.0.0.1:8080}`; a missing authority is refused before the WebSocket upgrade.

Keep `replicaCount: 1`. Live agent sockets are process state, so a read only succeeds on the replica holding the connection.

## 2. Expose the server

Put TLS in front of the web port; remote agents must use `wss://`. The chart can render an Ingress:

```sh
helm upgrade dsh-aiops deploy/helm/dsh-aiops -n aiops \
  --reuse-values \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.host=aiops.example.com \
  --set ingress.tlsSecretName=aiops-tls
```

Or use the Gateway API instead of Ingress; TLS is terminated by the parent Gateway listener:

```sh
helm upgrade dsh-aiops deploy/helm/dsh-aiops -n aiops \
  --reuse-values \
  --set gatewayApi.enabled=true \
  --set 'gatewayApi.parentRefs[0].name=gateway' \
  --set 'gatewayApi.parentRefs[0].sectionName=https' \
  --set 'gatewayApi.hostnames[0]=aiops.example.com'
```

The chart renders an `HTTPRoute` that sends `/` to the web Service; enable one of `ingress` or `gatewayApi`. Do not expose the webhook port (`3081`) publicly; only Alertmanager should reach it.

## 3. Create a cluster token

Open the Portal and use **Clusters → Create token**, or call the same-origin API:

```sh
curl -sS -X POST https://aiops.example.com/api/aiops/portal/clusters \
  -H 'content-type: application/json' \
  -d '{"name":"prod-sh"}'
```

The response contains the plaintext token exactly once; the server stores only its digest and last four characters. An invalid or revoked token is refused with HTTP 401.

## 4. Install the agent in the cluster

Run this in each cluster, with `cluster.name` equal to the token's cluster name and `cluster.serverUrl` an address reachable **from inside that cluster**:

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

The chart creates the ServiceAccount, a read-only ClusterRole (the exact resource allowlist), its binding, and the Deployment. Set `rbac.create=false` to manage those objects yourself. For a same-cluster agent, `cluster.serverUrl` can be `ws://dsh-aiops.aiops.svc.cluster.local:8080/api/aiops/agent`; use `wss://` whenever traffic leaves the cluster.

## 5. Verify

```sh
kubectl -n aiops get pods
kubectl -n aiops logs deployment/dsh-aiops-agent --tail=5
```

The Portal row turns `connected`, `GET /api/aiops/readyz` reports `clusters.configured: true` and the connected count, and **Probe** in the Clusters view exercises the live connection.

## 6. Upgrade an agent

Upgrades are operator-applied:

1. In the Portal, **Prepare upgrade** and enter the target version. The server stores it and drains the agent: in-flight reads finish, new reads fail over with `unreachable`.
2. Roll the image:

   ```sh
   helm upgrade dsh-aiops-agent deploy/helm/dsh-aiops-agent -n aiops \
     --reuse-values --set image.tag=<new-version>
   ```

3. The replacement Pod connects with the new version and reads resume automatically. To cancel before the rollout, use **Resume reads** in the Portal; `helm rollback` also works.

## 7. Operate

- **Backups**: `DSH_HOME` holds sessions, SQLite stores, settings, and credentials. Back up the claim with the workspace. `helm uninstall` deletes the chart's PVC; add `persistence.annotations."helm.sh/resource-policy": keep` if the volume must survive an uninstall.
- **Token rotation**: revoke the cluster in the Portal and create a new token, then update the agent Secret and restart the Deployment.
- **Removal**:

  ```sh
  helm uninstall dsh-aiops-agent -n aiops
  helm uninstall dsh-aiops -n aiops
  kubectl delete namespace aiops
  ```

## Values

Key server values:

| Value | Default | Meaning |
|---|---|---|
| `image.repository` / `image.tag` | `dsh-aiops` / chart appVersion | Server image; must match what the cluster can pull |
| `replicaCount` | `1` | Keep at one while agent sockets are process state |
| `dsh.publicUrl` | empty | Origin browsers and remote agents use; trusted hosts derive from it |
| `dsh.trustedHosts` | `[]` | Extra accepted authorities |
| `credentials.existingSecret` | empty | Secret with the webhook bearer value (recommended) |
| `credentials.webhookSecret` | empty | Value used when the chart creates the Secret |
| `persistence.existingClaim` / `storageClass` / `size` | empty / empty / `2Gi` | `DSH_HOME` volume |
| `service.type` / `nodePorts` | `ClusterIP` / empty | Service exposure |
| `ingress.enabled` / `host` / `tlsSecretName` | `false` / `aiops.example.com` / empty | Optional web ingress |
| `gatewayApi.enabled` / `parentRefs` / `hostnames` | `false` / `[]` / `[]` | Optional `HTTPRoute`; at least one parent Gateway reference is required |
| `observability.prometheusUrl` / `alertmanagerUrl` | empty | Optional in-cluster endpoints |

Key agent values:

| Value | Default | Meaning |
|---|---|---|
| `cluster.name` | required | Cluster name whose token was issued |
| `cluster.serverUrl` | required | Agent endpoint reachable from this cluster |
| `token.existingSecret` / `existingSecretKey` | empty / `token` | Secret holding the token (recommended) |
| `token.value` | empty | Value used when the chart creates the Secret |
| `serviceAccount.create` / `name` | `true` / release fullname | Agent identity |
| `rbac.create` / `clusterRoleName` | `true` / `<fullname>-reader` | Read-only ClusterRole and binding |
| `heartbeat` | `15s` | Heartbeat interval |
| `image.repository` / `image.tag` | `aiops-agent` / chart appVersion | Agent image |
