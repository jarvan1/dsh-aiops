# Reach every cluster through an outbound agent

English | [中文](2026-11-14-aiops-cluster-agent-gateway.zh.md)

- **Status:** Accepted
- **Date:** 2026-11-14
- **Context:** DSH 0.2.2-rc.1

## Context

The original design read one cluster through the in-process `aiops-kubernetes` provider: the AIOps Host held a kubeconfig (or an exec-credential) and ran `kubectl` locally. Multi-cluster access that way would require one kubeconfig per cluster on the Host, a per-alert mapping from the alert payload to a context name, and inbound reachability from the Host to every cluster API server. The first two are credential-management problems on a single host; the third contradicts the usual network posture in which clusters can dial out but are not dialed into.

The alternative discussed early — an Alertmanager label selecting a kubeconfig context — solves naming, not credentials, and depends on Alertmanager reaching a Host that can reach every API server.

## Decision

Each cluster runs a small outbound-only Go agent. The AIOps server holds no cluster credential:

- The Portal issues one token per cluster. A token is `dsha_` plus 32 random bytes; the server persists only its SHA-256 digest and last four characters in the `aiops_agent` storage domain, alongside the cluster name, timestamps, and the last reported agent version.
- The plaintext is shown exactly once, in the creation response, with the install steps. It never enters the snapshot, a log line, a URL, or browser storage.
- The agent dials `wss://<server>/api/aiops/agent` with a bearer token and sends a `hello` carrying its name, version, and capabilities. The server authenticates the digest, requires the `hello` name to equal the token's cluster, answers `welcome`, and routes typed reads to that socket.
- The protocol surface is closed: `get`, `list`, `events`, `logs`, and `probe`. There is no path, URL, verb, or exec passthrough, so a compromised server cannot turn an agent into an arbitrary API client. The agent keeps its own allowlist and RBAC; the server cannot widen it.
- **The native kubeconfig provider is retired (M2, done), including for the cluster that runs DSH.** There is no local fallback and no provider-selection abstraction. One token belongs to one cluster; revoke-and-create is the only rotation.
- **Onboarding is a normal startup with zero clusters.** The server never generates or logs a token at boot. The Portal home view shows a first-run card prompting token creation, and `/readyz` stays ready while reporting `components.clusters` plus `configured`/`total`/`connected`.
- **The agent's server URL is always explicit.** The server never infers, rewrites, or special-cases a same-cluster or loopback address. An agent in the DSH cluster follows the same URL and network path as a remote one, and deployment documentation states that the URL must be reachable from inside the cluster.
- One cluster has at most one live connection. A newer handshake replaces the older socket (close `4006`); revocation closes the live socket (`4001`) and removes the digest, so later upgrades receive HTTP 401.

## Alternatives considered

- **Keep the native provider for the local cluster and use agents only for remote ones.** Two code paths, two config surfaces, and a permanent temptation to treat the local cluster specially. Rejected: workspace-as-cluster identity should hold uniformly.
- **A provider-selection abstraction (native or agent per cluster).** Adds an interface and a settings dimension whose only purpose is to preserve a path that is being deleted.
- **Long-lived per-cluster kubeconfigs on the Host with a label→context map.** Keeps cluster credentials on the AIOps host, requires Host→API-server reachability, and gives no liveness story for a cluster that disappears.
- **Token rotation on a schedule.** The token identifies a cluster, not a user session; revocation plus re-creation is simpler and auditable. A connected cluster cannot re-issue in place, which prevents silently invalidating a running agent.
- **Automatic `hello`-driven naming.** The token binds the name; trusting the announced name would let one token claim another cluster's identity.
- **Inferring the agent URL from the browser's Host header.** A reverse proxy, NAT, or split-horizon DNS makes the browser's view an unreliable guess for in-cluster egress. An explicit URL has one failure mode — a wrong value the operator can see — instead of a hidden one.

## Consequences

Positive:

- The AIOps Host needs no kubeconfig, no exec credential, and no inbound path to any cluster API server.
- Credential issuance, visibility, and revocation are one Portal flow; the durable row answers "is this cluster attached?" without a probe.
- Cluster identity is a server-issued token, so it survives agent restarts, pod rescheduling, and multiple agent pods.
- The closed protocol keeps the compromise surface on both sides small and lets the agent run with a read-only ClusterRole.

Negative / accepted costs:

- Every deployment, including a single local cluster, gains a bootstrap step: create a token, install the agent, set a reachable server URL.
- Live sockets are process state. With several server replicas, a read only succeeds on the replica holding the agent's socket until shared connection routing exists; deployments should run one replica or route diagnosis traffic accordingly.
- The server and the agent must be released together for any protocol change; the major version is checked at handshake, and there is no in-place self-upgrade.
- Removing the native provider deleted the host kubeconfig surface, the `KUBECONFIG`/`KUBERNETES_CONTEXT` composition defaults, the kubectl compatibility subpath, and the Portal Kubernetes credential form; cluster connectivity is now an agent probe.

## Verification

The agent is covered by `go test ./...` (41 top-level tests, 60 with subtests) and a k3s v1.36 run through the committed RBAC. The server half is covered by the workspace suite (28 test files, 203 tests passed, one opt-in real-cluster test skipped) for token issuance and hashing, registry lifecycle across a restart, full handshake and probe through the registered upgrade route, auth/name/protocol rejection, result correlation and timeout, revocation and replacement, the Portal cluster routes (one-time token, cross-site rejection, no digest in the snapshot), and readiness with zero clusters. A cross-language smoke ran the real Go agent against the real TypeScript gateway: token authentication, `hello`/`welcome`, `probe` capabilities, `unsupported_resource` and `unreachable` mapping, and a `4001` revocation drop.
