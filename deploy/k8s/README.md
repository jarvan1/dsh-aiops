# Deploying the server on Kubernetes

English | [中文](README.zh.md)

This example runs the AIOps server ([`dsh-aiops.yaml`](dsh-aiops.yaml)) as one Deployment with a persistent `DSH_HOME` volume, and installs the cluster agent from [`agent/deploy/`](../../agent/deploy/) into the same cluster. It is a starting point: TLS termination, ingress authentication, backups, and storage class choice stay deployment-owned.

## Prerequisites

- A built server image from [`Dockerfile`](../../Dockerfile), loaded into the cluster. Without a registry reachable from the nodes:

  ```sh
  docker build -t dsh-aiops:0.2.0-rc.1 .
  docker save dsh-aiops:0.2.0-rc.1 -o /tmp/dsh-aiops.tar
  sudo k3s ctr images import /tmp/dsh-aiops.tar
  ```

- A built agent image from [`Dockerfile.agent`](../../Dockerfile.agent), loaded the same way:

  ```sh
  docker build -f Dockerfile.agent -t aiops-agent:0.2.0-rc.1 .
  docker save aiops-agent:0.2.0-rc.1 -o /tmp/aiops-agent.tar
  sudo k3s ctr images import /tmp/aiops-agent.tar
  ```

- A default StorageClass for the 2 GiB `DSH_HOME` claim, and a model configured in the DSH Web profile if diagnoses should run (the Portal, readiness, and agent gateway work without one).

## Install

1. **Create the webhook secret.** Replace the placeholder in the manifest, or keep the Secret out of the repository:

   ```sh
   kubectl -n aiops create namespace aiops
   kubectl -n aiops create secret generic dsh-aiops-credentials \
     --from-literal=webhook-secret="$(openssl rand -hex 24)"
   ```

   Then delete the Secret block from `dsh-aiops.yaml` before applying.

2. **Set the public and trusted hosts.** `DSH_PUBLIC_URL` is the origin browsers and remote agents use. `DSH_TRUSTED_HOSTS` must contain every authority a client sends: the public host, and the in-cluster Service address agents dial. A missing authority is refused before the WebSocket upgrade and the agent logs `unexpected EOF`.

3. **Apply the server and expose it.**

   ```sh
   kubectl apply -f deploy/k8s/dsh-aiops.yaml
   kubectl -n aiops rollout status deployment/dsh-aiops
   ```

   Put an ingress or reverse proxy with TLS in front of `dsh-aiops:8080`; agents must use `wss://` there. The webhook listener (`:3081`) should only be reachable by Alertmanager.

4. **Create a cluster token.** Open the Portal (or `GET /api/aiops/portal` on the exposed origin), go to **Clusters → Create token**, and name the cluster to match the agent's `--name`.

5. **Install the agent.** Apply the RBAC, create the token Secret, and deploy it with the token:

   ```sh
   kubectl apply -f agent/deploy/rbac.yaml
   kubectl -n aiops create secret generic aiops-agent-token --from-file=token=./agent-token
   kubectl -n aiops apply -f agent/deploy/deployment.yaml
   ```

   Set `AIOPS_AGENT_NAME` to the token's cluster name and `AIOPS_AGENT_SERVER` to the address reachable **from inside the cluster** — for example `ws://dsh-aiops.aiops.svc.cluster.local:8080/api/aiops/agent` for a same-cluster agent, or `wss://aiops.example.com/api/aiops/agent` for a remote one. The agent image in the Deployment must be replaced with the one loaded above.

6. **Verify.** The Portal row turns `connected`; `/api/aiops/readyz` reports `clusters.configured: true` and the connected count. Probe from the Clusters tab.

## Operate

- **Upgrades** are operator-applied. In the Portal use **Prepare upgrade**, enter the target version, then roll the agent image (`kubectl -n aiops set image deployment/aiops-agent agent=<image>:<version>`). In-flight reads finish, new reads fail over while draining, and the replacement agent clears the drain when it connects. **Resume reads** cancels a prepared rollout.
- **Backups**: the `dsh-data` volume holds sessions, SQLite stores, settings, and credentials. Back it up with the workspace, and keep one replica (live sockets are process state).
- **Tokens** are issued in the Portal and stored as digests; a token belongs to one cluster. Revoke to rotate.

## Local k3s notes

- If the cluster cannot pull public images, import the images as shown above. The local-path provisioner also needs a helper image; if provisioning fails, use a StorageClass whose helper image is present or a hostPath volume for a throwaway test.
- If the host intercepts DNS (for example a transparent proxy answering with `198.18.0.0/15` addresses), in-cluster Service names may resolve to the proxy's fake IP. Use the Service ClusterIP or the node address in `AIOPS_AGENT_SERVER` and add that authority to `DSH_TRUSTED_HOSTS`.
- A verified local run deployed the server image into k3s, issued a token through the deployed Portal API, connected an agent Pod with the committed RBAC and its service-account token, probed it, drained it, replaced the binary with 2.0.0, and revoked it.
