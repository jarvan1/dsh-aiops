# AIOps cluster agent

English | [中文](README.zh.md)

A small Go process installed in each Kubernetes cluster that connects out to one DSH AIOps server and answers bounded, read-only queries. It exists so the AIOps Host no longer needs a kubeconfig per cluster: identity comes from the agent's client name and token, and the network path only ever goes cluster → server.

> **Status.** The agent, protocol v1, image, read-only RBAC, and the server-side gateway are implemented and tested. Tokens are issued in the AIOps Portal, and the server authenticates, tracks, probes, and revokes agents at `/api/aiops/agent`. Diagnosis tools now read through the agent: the router binds each alert round to its `cluster` label and the Kubernetes tools read that cluster. The host kubeconfig provider is gone. Upgrades are operator-applied: the Portal sets the target version and drains the agent, then the operator rolls the image; `resume` restores reads if the rollout is cancelled. See [the protocol](docs/protocol.md) and [TODO](../TODO.md).

## How it works

- Dials `wss://<server>/api/aiops/agent` with `Authorization: Bearer <token>` and sends one `hello` carrying the immutable client name, build version, and capabilities. The server answers `welcome`; a different protocol major version is refused instead of guessed.
- Answers a closed operation set only: `get`, `list`, `events`, `logs`. There is no verb, path, URL, or kubectl passthrough, so a compromised server cannot turn an agent into an arbitrary API client.
- Reads through the pod's service-account token and cluster CA with plain REST calls, not client-go, which keeps the binary small and the surface auditable. The token file is re-read on every request, so projected service-account rotation needs no restart.
- Bounds every answer: response-byte cap, log line cap, concurrency cap, per-read deadline, and inbound message-size cap. Oversized or malformed results become typed errors, never partial JSON.
- Sends heartbeats and WebSocket pings; a server that goes silent is detected and the connection is rebuilt with capped exponential backoff and jitter. `401`/`403` and protocol mismatches are fatal instead of retried.
- Honors `drain`/`resume`: while draining it rejects new reads with `busy` and lets in-flight reads finish, so a rolling upgrade can retire a pod without failing a diagnosis. `upgrade` is refused on purpose — the rollout system applies the new image (path A).

## Install

The agent image is built from [Dockerfile.agent](../Dockerfile.agent) with the repository root as context:

```sh
docker build -f Dockerfile.agent -t registry.example.com/aiops-agent:0.1.0 .
```

Then, in each cluster:

1. **Create the namespace and service account.**

   ```sh
   kubectl create namespace aiops
   kubectl apply -f deploy/rbac.yaml
   ```

   The ClusterRole grants `get`/`list` on exactly the resources in [internal/kube/resource.go](internal/kube/resource.go) plus core Events, and `get` on `pods/log`. It cannot read Secrets or mutate anything.

2. **Issue a token in the Portal.** Open the AIOps view and use **Clusters → Create token** (the home view prompts for it on a fresh install). Enter the cluster name you will pass as `--name`. The plaintext token is shown exactly once; the server keeps only its SHA-256 digest and last four characters. Never commit it or pass it on a command line.

   ```sh
   kubectl -n aiops create secret generic aiops-agent-token --from-file=token=./token
   ```

3. **Apply the Deployment.** Copy [deploy/deployment.yaml](deploy/deployment.yaml), set `AIOPS_AGENT_SERVER`, `AIOPS_AGENT_NAME`, and the image, then apply it. `AIOPS_AGENT_SERVER` must be a URL that resolves and routes **from inside the cluster** — for example `wss://aiops.example.com/api/aiops/agent`. The server never rewrites, infers, or special-cases the address for an agent that happens to be local. The pod runs as non-root with a read-only root filesystem and no Service or Ingress.

4. **Verify.** The Portal row turns `connected` and the agent logs `agent connected`. A rejected token logs `agent token was rejected by the server` and exits non-zero; revoking the cluster closes the live socket immediately and the token stops authenticating.

## Configuration

Flags override environment defaults. The token is only read from a file.

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--server` | `AIOPS_AGENT_SERVER` | — | Server WebSocket URL; `wss` required (`ws` only for a local test server) |
| `--name` | `AIOPS_AGENT_NAME` | — | Immutable client name and cluster identity (DNS label, ≤63 chars) |
| `--token-file` | `AIOPS_AGENT_TOKEN_FILE` | — | File containing the token issued for this client |
| `--max-response-bytes` | — | `2000000` | Maximum Kubernetes response body |
| `--max-tail-lines` | — | `2000` | Log line cap per request |
| `--default-tail-lines` | — | `200` | Log lines when a request omits `tailLines` |
| `--concurrency` | — | `4` | Concurrent reads (1..64); excess reads get `busy` |
| `--heartbeat` | — | `15s` | Heartbeat interval (1s..5m) |
| `--request-timeout` | — | `30s` | Per-read Kubernetes API deadline |
| `--service-account-dir` | — | `/var/run/secrets/kubernetes.io/serviceaccount` | Credential mount; override only to run the agent locally against a cluster |
| `--log-level` | — | `info` | `debug`, `info`, `warn`, or `error` |
| `--version` | — | — | Print the build version and exit |

Reads that omit a namespace use the agent's own namespace. Node, Namespace, and PersistentVolume reads ignore the namespace field.

## Capabilities

| Operation | Request fields | Result |
|---|---|---|
| `get` | `resource`, `name`, optional `namespace` | One Kubernetes object as JSON |
| `list` | `resource`, optional `namespace`, selectors | One page of a Kubernetes list; `truncated` reports a `continue` token |
| `events` | optional `namespace`, selectors, `sinceTime`, `untilTime` | Events sorted by start time and filtered by the inclusive occurrence window |
| `logs` | `pod`, optional `namespace`, `container`, `previous`, `tailLines`, `since`, `sinceTime`, `untilTime`, `timestamps` | Bounded log text; an absolute upper bound filters lines locally |

Resource names follow the native provider: `pod(s)`, `service(s)`, `endpoint(s)`, `configmap(s)`, `pvc`/`persistentvolumeclaim(s)`, `node(s)`, `namespace(s)`, `pv`/`persistentvolume(s)`, `deployment(s)`, `statefulset(s)`, `daemonset(s)`, `replicaset(s)`, `job(s)`, `cronjob(s)`.

Errors use the same codes as the native provider — `invalid_request`, `unsupported_resource`, `not_found`, `forbidden`, `authentication_failed`, `timeout`, `response_too_large`, `invalid_response`, `unreachable` — plus `busy`, which the server maps to `unreachable` so a saturated agent fails over instead of stalling a diagnosis.

## Development

```sh
cd agent
go vet ./...
go test ./...
go build ./cmd/aiops-agent
```

Tests cover protocol validation, the executor against a fake Kubernetes API (allowlist, name validation, status mapping, size caps, event windows, log bounds), the WebSocket loop against a fake server (auth header, hello/welcome, result correlation, probe, drain, upgrade refusal, heartbeat, fatal 401, protocol mismatch, reconnect), and configuration parsing.

To exercise a real cluster without building an image, point `--service-account-dir` at a directory holding a service-account token, the namespace, and `ca.crt`, and connect to a local stub server:

```sh
mkdir -p /tmp/aiops-sa
kubectl -n aiops create token aiops-agent --duration=1h > /tmp/aiops-sa/token
printf 'aiops' > /tmp/aiops-sa/namespace
kubectl config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > /tmp/aiops-sa/ca.crt
KUBERNETES_SERVICE_HOST=127.0.0.1 KUBERNETES_SERVICE_PORT=6443 \
  go run ./cmd/aiops-agent --server ws://127.0.0.1:9099/agent --name local-test \
  --token-file ./server-token --service-account-dir /tmp/aiops-sa
```

`--token-file` is the AIOps server token, not the Kubernetes token in the service-account directory. That token has a different audience and must match what the server expects; only `ws` against a local stub is acceptable, and the stub still must authenticate it.

| Path | Contents |
|---|---|
| `cmd/aiops-agent/` | Flags, signals, logging, build version |
| `internal/protocol/` | Versioned messages, validation, error codes |
| `internal/kube/` | In-cluster REST client, allowlist, bounded executor |
| `internal/agent/` | Dial, handshake, keepalive, dispatch, reconnect |
| `internal/config/` | Flag/environment parsing, token loading |
| `deploy/` | Read-only RBAC and Deployment examples |

## Security notes

- The agent never listens, never executes commands in Pods, and never writes to the cluster.
- The RBAC manifest and the executor allowlist must change together; `kubectl auth can-i --list --as=system:serviceaccount:aiops:aiops-agent` should show only the documented verbs.
- The token file must contain exactly one token. Errors never include the token, the server URL query, or Kubernetes response bodies beyond a bounded status message.
- Cluster identity is the client name bound to the token, not the name in `hello` and not a label in the alert payload. A `hello` that announces a different name is closed with code `4003`.
- Revoking a cluster deletes its digest from the registry, closes the live socket with code `4001`, and refuses every later connection with HTTP 401.

## Limitations

- One agent process holds one connection. If two connections present the same name, the newest handshake wins and the older socket is closed with code `4006`; the server routes reads only to the live one.
- Lists and Event queries return a single API page. A `continue` token sets `truncated` but is not followed automatically, which bounds memory per request.
- Self-upgrade is not implemented by design (path A: the rollout system replaces the image). The server may still send `drain`, wait for in-flight reads, then let the rollout proceed.
- Kubernetes must expose the core `events` API and pod log endpoint; all supported upstream versions do.
