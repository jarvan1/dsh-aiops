---
description: "Server-side cluster-agent registry and WebSocket gateway: issues one token per cluster, tracks agent liveness, and runs bounded reads through the Go agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-agents

English | [中文](README.zh.md)

## Summary

This package owns the server half of the multi-cluster agent. It keeps one durable row per cluster in the plugin-owned `aiops_agent` storage domain (name, SHA-256 token digest, last four characters, timestamps, last reported agent version), serves token creation, re-issue, and revocation, and terminates the `/api/aiops/agent` WebSocket that every Go agent dials outbound. The `ctx.aiopsAgents` service answers `probe` and typed reads, correlating results by request id and mapping the agent's closed error taxonomy onto the shared Kubernetes query codes. The server never holds a kubeconfig, never dials a cluster, and never sees a plaintext token after the creation response.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it with the storage stack; it registers the agent WebSocket route itself when the host webserver is present.

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

The AIOps Portal mounts it and exposes the operator surface: cluster list in the snapshot, `POST /api/aiops/portal/clusters` (create), `/clusters/token` (re-issue), `/clusters/revoke`, and `/clusters/probe`. Only the create and re-issue responses carry a plaintext token, and only once.

To attach a cluster, issue a token in the Portal, then install the agent from [`agent/`](../../agent/README.md) with that token and a server URL reachable from inside the cluster.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A token is `dsha_` plus 32 random bytes in base64url. The durable row keeps its digest and last four characters only; an in-memory digest→name index, rebuilt when the domain opens, answers the upgrade path in constant time. The gateway authenticates the bearer token before upgrading, requires a valid `hello` within the handshake deadline, rejects a `hello` whose name differs from the token's cluster, and replaces an older socket for the same name (close `4006`). Reads carry a generated id, a per-request deadline, and an abort signal; a pending map resolves them, and a closed or replaced connection fails every pending read with `unreachable`. Revocation removes the digest, closes the live socket with `4001`, and refuses later upgrades with HTTP 401. Heartbeats refresh `lastSeenAt` at most once a minute so a quiet cluster does not churn disk. Status is derived: `revoked`, else `connected` for a live socket, else `pending` before the first handshake and `offline` after it.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Wire messages, capabilities, cluster views, error taxonomy |
| [`src/tokens.ts`](src/tokens.ts) | Token generation, digest comparison, bearer parsing |
| [`src/gateway.ts`](src/gateway.ts) | Upgrade handling, handshake, keepalive, read correlation, close codes |
| [`src/store.ts`](src/store.ts) | `aiops_agent` domain spec and the `ctx.aiopsAgents` service |
| [`src/index.ts`](src/index.ts) | Plugin entry, config schema, exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent protocol v1](../../agent/docs/protocol.md) — messages, error codes, close codes, bounds.
- [Agent install guide](../../agent/README.md) — image, RBAC, Deployment, token file.
- [Portal package](../aiops-portal/README.md) — the operator UI that calls this service.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **One replica owns a connection.** Live sockets are process state. With several server replicas, a read only succeeds on the replica holding the agent's socket; route diagnosis traffic to that replica (or run one replica) until shared connection routing exists.
- **Diagnosis reads are wired (M2).** `dsh-aiops-kubernetes` resolves the round's cluster binding and executes reads through this service; `probe` backs cluster connectivity in the Portal.
- **No upgrade state machine.** `desiredVersion` is stored and advertised in `welcome`, but `drain`/`resume` coordination and the Portal upgrade flow are M3; the agent refuses self-upgrade by design.
- **TLS is deployment-owned.** The route uses the host webserver's listener; terminate TLS with the host's `tls` config or a reverse proxy so agents can use `wss`.
- **No token rotation schedule.** A token belongs to one cluster until revoked; a cluster that has connected is rotated by revoking and creating it again.
