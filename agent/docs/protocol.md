# Agent protocol v1

English | [中文](protocol.zh.md)

The contract between one cluster agent and the DSH AIOps server. It is deliberately small: an outbound-only WebSocket carrying a versioned handshake, liveness messages, and a closed set of bounded read requests. There is no generic RPC, no path or URL supplied by the server, and no write operation of any kind.

Implementation: [`internal/protocol`](../internal/protocol/messages.go), [`internal/agent`](../internal/agent/client.go), [`internal/kube`](../internal/kube/executor.go) for the agent; [`packages/aiops-agents`](../../packages/aiops-agents/) for the server.

## Transport and authentication

| Property | Value |
|---|---|
| Endpoint | `wss://<server>/api/aiops/agent` (`ws` only for a local test server) |
| Direction | Agent dials the server. The server never dials the cluster. |
| Authentication | `Authorization: Bearer <token>` on the upgrade request |
| Token | Opaque, server-issued, bound to one client name; stored by the agent in a file |
| Framing | JSON text messages, one message per WebSocket frame |
| Inbound cap | 1 MiB per message (requests are far smaller) |
| Keepalive | Agent heartbeat every `--heartbeat` (default 15s) and a ping every half interval |
| Liveness | Agent resets its read deadline on every message and pong; silence longer than three heartbeats rebuilds the connection |

The token is the only credential. A token presented with the wrong client name is rejected with `401`; only the name carried in the authenticated `hello` identifies the cluster. The server must compare the presented token against a stored hash, not plaintext, and must reject a second name using the same token.

## Lifecycle

```text
agent                                   server
  | -- upgrade + Authorization: Bearer -->|
  |<-------------- 101 Switching Protocols|
  | -- hello {protocol,name,version,caps}>|
  |<-- welcome {protocol,clientId,...} ---|
  | -- heartbeat ------------------------>|  every interval
  |<-- read {id,op,...} ------------------|
  | -- result {id,ok,data|code} --------->|
  |<-- drain -----------------------------|  optional, before a rollout
  | -- result {id,busy} for new reads --->|
  |<-- resume ----------------------------|
  | -- close / reconnect with backoff --->|
```

A connection that is closed, times out, or fails a write is discarded and rebuilt with capped exponential backoff (1s → 60s, with up to 50% jitter). `401`/`403` and any protocol mismatch are fatal and are not retried; the process exits non-zero so Kubernetes surfaces the failure.

## Messages

All messages are JSON objects with a `type` discriminator. Unknown or malformed **server** messages close the connection: silently ignoring one would leave a request unanswered.

### Agent → server

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

`name` is the immutable client name (DNS label). Multiple pods may share it; the server treats them as one logical client. `capabilities.resources` lists the canonical names answerable through `get`/`list`, `events` and `logs` advertise the dedicated queries, and the two maxima let the server reject an impossible request without a round trip.

#### `heartbeat`

```json
{ "type": "heartbeat", "version": "0.1.0", "inflight": 2 }
```

`inflight` is the number of reads currently executing.

#### `result`

```json
{ "type": "result", "id": "7f3c", "ok": true, "data": { }, "truncated": false }
{ "type": "result", "id": "7f3d", "ok": false, "code": "forbidden", "message": "Kubernetes denied the requested read operation." }
```

Every request id receives exactly one result. `data` is a Kubernetes JSON object for `get`/`list`/`events`, a string for `logs`, and an object for `probe`. `message` is capped at 512 characters.

### Server → agent

#### `welcome`

```json
{ "type": "welcome", "protocol": 1, "clientId": "cli_01", "desiredVersion": "0.1.0" }
```

`protocol` must equal the agent's major version. `clientId` is the server-assigned id for this registration and is used in logs and the Portal. `desiredVersion` is informational; it lets the server show drift without letting the agent replace itself.

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

| Field | Applies to | Rules |
|---|---|---|
| `id` | all | 1..128 characters of `[A-Za-z0-9._:-]` |
| `op` | all | one of `get`, `list`, `events`, `logs` |
| `resource` | `get`, `list` | required; must be in the agent allowlist |
| `name` | `get` | required; DNS subdomain, ≤253 characters |
| `namespace` | `get`, `list`, `events`, `logs` | optional; defaults to the agent's own namespace; must be a DNS label |
| `labelSelector` | `list`, `events` | ≤1024 characters |
| `fieldSelector` | `list`, `events` | ≤1024 characters |
| `sinceTime` / `untilTime` | `events`, `logs` | RFC3339; inclusive; `sinceTime` must not be after `untilTime` |
| `pod` | `logs` | required; DNS subdomain |
| `container` | `logs` | optional; DNS label |
| `previous` | `logs` | optional; reads the previous terminated instance |
| `tailLines` | `logs` | optional positive integer; clamped to the agent maximum |
| `since` | `logs` | optional Kubernetes duration `30s`/`15m`/`2h`/`1d`; mutually exclusive with `sinceTime` |
| `timestamps` | `logs` | optional; forced on when `untilTime` is present |

`events` ignores `resource` and always reads core `v1` Events in a namespace. `logs` reads `/api/v1/namespaces/<ns>/pods/<pod>/log` without following.

#### `probe`

```json
{ "type": "probe", "id": "7f3e" }
```

Answered with `{ name, version, protocol, capabilities }`, letting the server render a connection check without an extra round trip.

#### `upgrade`

```json
{ "type": "upgrade", "id": "7f3f", "targetVersion": "0.2.0" }
```

Always answered with `ok: false`, `code: invalid_request`, message `self-upgrade is disabled; apply the rollout out of band`. Path A keeps the agent read-only: the rollout system replaces the image, and the server coordinates with `drain`/`resume` instead.

#### `drain` / `resume`

No fields, no acknowledgement. While draining, new reads get `busy`; reads already executing finish and return their real result. The server should wait for in-flight results (or the heartbeat `inflight` counter to reach zero) before letting the rollout terminate the pod.

#### `error`

```json
{ "type": "error", "code": "forbidden", "message": "client name does not match token" }
```

Terminates the connection. The agent logs the code and message (neither is allowed to contain the token).

## Error codes

The closed set matches the TypeScript provider so a remote cluster fails the same way an in-process one does. The server maps `busy` to `unreachable`, which is retryable from the diagnostic tool's point of view.

| Code | Meaning | Typical source |
|---|---|---|
| `invalid_request` | The request or a name/duration failed validation | Agent, before any API call |
| `unsupported_resource` | Resource is not in the allowlist | Agent |
| `not_found` | Object does not exist | API server `404` |
| `forbidden` | RBAC denied the read | API server `403` |
| `authentication_failed` | Service-account token rejected, or CA mismatch | API server `401`, TLS |
| `timeout` | Per-read deadline exceeded | Agent |
| `response_too_large` | Body exceeded `--max-response-bytes` | Agent |
| `invalid_response` | Kubernetes returned non-JSON or an unexpected shape | Agent |
| `unreachable` | Network failure or API server `5xx` | Agent |
| `busy` | Concurrency exhausted or agent draining | Agent |

Response messages are bounded and must not include tokens, Secret contents, or unbounded API bodies.

## Versioning

- `protocol` is a major version. The server advertises its version in `welcome`; the agent refuses anything other than its own and exits.
- Any non-breaking addition (a new optional request field, a new error code in the documented set) stays within v1; both sides must ignore unknown fields.
- A breaking change bumps the major version. During a rollout the server must support the previous major version until every registered client has reported the new one; an agent never guesses.
- The server should record `version` from `hello` and compare it to its desired version per client. Applying that version is an operator action (path A), not an automatic push.

## Bounds

| Bound | Default | Enforced by |
|---|---|---|
| Kubernetes response body | 2,000,000 bytes | Agent, before JSON decoding |
| Log lines | 200 default, 2,000 maximum | Agent query |
| Concurrent reads per connection | 4 | Agent; excess gets `busy` |
| Per-read deadline | 30s | Agent |
| Inbound protocol message | 1 MiB | Agent WebSocket read limit |
| Result message | 512 characters for errors | Agent |
| Selectors | 1,024 characters | Agent |

List and Event responses return a single API page. A non-empty `metadata.continue` sets `truncated`; the agent does not follow pagination, which keeps per-request memory bounded.

## Close codes

The server closes with an application code so both sides can tell a policy decision from a transport failure. The agent treats every close as a reconnect unless the token itself was refused.

| Code | Meaning |
|---|---|
| `4001` | Cluster token revoked; the live socket is dropped on revocation |
| `4002` | Protocol major version mismatch; an `error` frame precedes it |
| `4003` | `hello` names a different cluster than the token |
| `4004` | No valid `hello` within the handshake deadline |
| `4005` | Protocol violation: non-JSON, binary, malformed `hello`, or an unexpected message type |
| `4006` | Replaced by a newer connection that presented the same cluster name |
| `4007` | Server shutting down |

An agent that is refused before the upgrade sees plain HTTP `401` and exits non-zero, because retrying cannot help until an operator installs a valid token.

## Token issuance and revocation

- The server issues tokens from the Portal, not from the agent. A token is `dsha_` plus 32 random bytes in base64url.
- Only the SHA-256 digest and the last four characters are persisted, in the `aiops_agent` storage domain, together with the cluster name, creation time, and last handshake.
- The plaintext is returned once, in the creation response. It never enters the snapshot, the logs, or a URL.
- A cluster that has never completed a handshake may have its token re-issued; after that the only rotation is revoke-and-create.
- Revocation removes the digest from the in-memory lookup, closes a live connection with `4001`, and refuses later upgrades with `401`. The durable row remains for audit and shows as `revoked`.

## Server implementation (this repository)

- `packages/aiops-agents` terminates the upgrade at the exact `/api/aiops/agent` path and authenticates the bearer token before any protocol message.
- Cluster rows move through `pending` (token issued, never connected), `connected`, `offline`, and `revoked`; the Portal renders them and never receives a token or digest.
- Reads are correlated by `id` with a request deadline (30s default); `busy` is translated to `unreachable`. A missing or replaced connection also answers `unreachable`, so a diagnosis fails over instead of stalling.
- The inbound frame cap is 4 MiB, sized for the agent's 2 MB Kubernetes body cap plus JSON overhead.
- Server pings run every 30s; silence past the idle window terminates the socket.
- Upgrades are operator-applied (path A): setting a target version persists `desiredVersion`, sends `drain`, and advertises the version in the next `welcome`; the gateway refuses new reads while draining, the rollout replaces the Pod, and the replacement connection starts outside any drain. `resume` restores reads when a rollout is cancelled.
- The server logs `clientId`, `name`, and `version` — never the token.
