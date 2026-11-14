# Changelog

All notable changes to DSH AIOps are documented in this file.

The project follows semantic-versioning conventions. Changes that have not yet been assigned a release tag remain under **Unreleased**.

## Unreleased — 2026-11-14 — Agent upgrade state machine (M3)

### Added

- Added operator-applied agent upgrades (path A). `POST /api/aiops/portal/clusters/upgrade` persists the target version, sends `drain` to the live agent, and returns the cluster row; the gateway refuses new reads with `unreachable` while draining and a replacement connection never inherits the drain. `POST /clusters/resume` restores reads on the same agent when a rollout is cancelled.
- The cluster view now reports `draining` and the persisted `desiredVersion`; the Portal's Clusters tab shows `Draining` status, the pending target version, a target-version form, a Resume action, and the `kubectl set image` rollout to apply. The replacement agent connects with the new version and the status recovers; the server never replaces the image itself.
- `welcome` already advertised `desiredVersion`; it is now set through the Portal flow and covered end to end.

### Validation

- New gateway tests cover drain/resume frames, read refusal while draining, no-op drain without a connection, and a replacement connection starting outside the drain; registry tests cover target persistence, invalid version rejection, and resume. The Portal route test covers both new endpoints. The workspace suite passes 26 files and 203 tests.
- A k3s deployment run placed the real agent in a Pod inside the local cluster (committed RBAC, in-cluster service-account token, distroless image, statically linked agent binary mounted through hostPath) pointed at the server on the node IP over `ws`: the Pod connected, probed, read kube-system pods, rejected a Secrets read with `unsupported_resource`, and exited after revocation. The namespace, RBAC, token, and Pod were removed afterwards.
- A real k3s v1.36 acceptance run drove the whole flow: agent 1.0.0 connected and read kube-system pods, `upgradeCluster('local','2.0.0')` drained it and reads failed with `unreachable`, the 1.0.0 process exited, a 2.0.0 binary connected with the same token, reads resumed, and a second upgrade followed by `resume` restored reads on the still-running agent. The agent/RBAC resources were removed afterwards.

## Unreleased — 2026-11-14 — Cluster-agent Kubernetes reads (M2)

### Changed

- `ctx.kubernetes` is now agent-only. Every object, Event, and Pod-log read is one typed request over the WebSocket of the cluster agent registered for that diagnosis; the DSH host holds no kubeconfig and cannot reach a cluster API server directly. The provider keeps the closed request surface, the resource allowlist, log-request shaping, and the error taxonomy, and maps the agent's failure codes onto `KubernetesQueryError` unchanged.
- Each alert round is bound to one cluster: the incident router reads the `cluster` alert label (new `clusterLabel`, default `cluster`), persists the name with the round, states it in the first-turn prompt, and exposes `clusterForSession()` for the observation tools. A missing label falls back to the new router `defaultCluster`; an invalid label value binds nothing rather than silently reading another cluster, so Kubernetes evidence fails explicitly and the diagnosis degrades to Alertmanager/Prometheus evidence.
- The router's SQLite schema is version 5: `incident_rounds` and `route_audit` gain a `cluster` column, a v4 database migrates in place, and a legacy round adopts the first usable binding it sees. Route audit rows now carry the bound cluster.
- The observation tools resolve the session's cluster binding through `ctx.aiopsIncidentRouter` (optional lookup, no hard dependency) and pass it in every Kubernetes target. The Portal incident detail shows the bound cluster from the latest route.
- Cluster connectivity is an agent probe, not a credential test: `KubernetesConnectionSpec` takes a cluster name, and the result reports the agent version, protocol, advertised resources, and mapped capabilities.

### Removed

- Removed `NativeKubernetesRuntime`, its kubeconfig loading, SelfSubjectAccessReview checks, and the `@kubernetes/client-node` dependency.
- Removed the `./kubectl` compatibility provider and its subprocess dependency.
- Removed the `kubeconfig`, `context`, `timeoutMs`, and `maxResponseBytes` settings, the Portal Kubernetes credential form and connection-test target, and the `KUBECONFIG`/`KUBERNETES_CONTEXT` composition defaults. The Portal now tests Prometheus and Alertmanager only; the `aiops-kubernetes` config is `defaultCluster` plus log tail bounds.
- Removed the opt-in CrashLoopBackOff kubeconfig exercise; the guarded k3s matrix now provisions a real agent (new `AIOPS_E2E_AGENT_IMAGE`, `AIOPS_E2E_AGENT_SERVER`, optional `AIOPS_E2E_CLUSTER`), labels the Kubernetes alert with the cluster name, verifies the agent is connected, and revokes it during cleanup.

### Validation

- The workspace suite passes 26 test files and 199 tests: agent-backed Provider reads, cluster resolution and defaults, Event-window normalization, log shaping, error mapping, probe capability mapping, per-round binding with prompt instructions, invalid-label refusal, schema migration with backfill, and the Portal's two-source settings and cluster display.
- The full build, GitHub source-package preparation, link check, and `git diff --check` pass. The Go agent suite is unchanged and still passes.

## Unreleased — 2026-11-14 — Multi-cluster agent (client and server gateway)

### Added

- Added `agent/`, a Go cluster agent that dials the AIOps server over WebSocket and answers bounded, read-only Kubernetes queries, so one AIOps deployment can reach many clusters without host-side kubeconfigs. Protocol v1 exposes only `get`, `list`, `events`, and `logs`; there is no generic verb, path, URL, or exec passthrough.
- Added an in-cluster REST client that reads the service-account token, cluster CA, and namespace from the standard mount and re-reads the token on every request, so projected-token rotation needs no restart. It replaces client-go with stdlib HTTP to keep the binary and the audit surface small. A `--service-account-dir` override (default: the standard mount) supports running the binary outside a Pod for local verification.
- Added bounded execution with native-provider parity: the same resource allowlist, name/namespace validation before any API call, the same error-code taxonomy plus `busy`, a 2 MB response cap, log tail caps and local `untilTime` filtering, Event sorting and inclusive occurrence windows, a per-read deadline, one-page list semantics with `truncated`, and a 1 MiB inbound message cap.
- Added the connection lifecycle: `hello`/`welcome` with protocol-version negotiation, heartbeats and ping/pong liveness, capped exponential reconnect backoff with jitter, fatal `401`/`403` and protocol mismatches, per-read concurrency limits, and `drain`/`resume` for rollouts. `upgrade` is deliberately refused (path A: the rollout applies the image).
- Added `Dockerfile.agent` (static binary, non-root, CA bundle) and `agent/deploy/` with a read-only ClusterRole matching the executor allowlist plus a hardened Deployment example. A token Secret is created out of band and never committed.
- Added bilingual agent documentation and an implementation-oriented [`agent/docs/protocol.md`](agent/docs/protocol.md), and linked them from the root READMEs.
- Added `packages/aiops-agents`, the server half of protocol v1: the `/api/aiops/agent` WebSocket route (registered through `webServer.registerUpgrade`), bearer authentication against a stored digest, `hello`/`welcome` with name binding and protocol-major enforcement, per-connection result correlation with a request deadline, heartbeat/ping liveness, connection replacement, and revocation. Reads map the agent's closed error set onto the shared Kubernetes query codes, with `busy` reported as `unreachable`.
- Added the durable `aiops_agent` storage domain and one-time token issuance. A token is `dsha_` plus 32 random bytes; only its SHA-256 digest and last four characters are persisted. Tokens are created, re-issued (pending clusters only), revoked, and probed through the Portal, never generated or logged at boot. A revoked cluster is dropped from the digest index, its live socket closes with code `4001`, and later upgrades receive HTTP 401.
- Added Portal cluster management: snapshot version 4 carries `clusters` and `needsCluster`, the home view shows a first-run card prompting token creation, and a new **Clusters** tab lists `pending`/`connected`/`offline`/`revoked` with re-issue, revoke, and probe actions. The plaintext token is shown once with install steps and never enters the snapshot, a URL, or browser storage.
- Readiness keeps `/readyz` ready with zero clusters and now reports `components.clusters` plus a `clusters` block (`configured`, `total`, `connected`).
- Server-side multi-cluster routing into the diagnosis tools (M2) and the upgrade state machine (M3) remain future milestones; the native kubeconfig provider is still the active read path.

### Validation

- `go vet ./...` and `go test ./...` pass in `agent/`: 41 top-level tests (60 including subtests) covering protocol validation, executor behavior against a fake Kubernetes API (allowlist, name rejection before the API call, status mapping, size caps, event windows, log bounds, timeout), the WebSocket loop against a fake server (auth header, handshake, result correlation, probe, drain/busy, upgrade refusal, heartbeat, fatal 401, protocol mismatch, reconnect), and configuration parsing.
- Both deployment manifests parse as multi-document YAML; the repository link check and `git diff --check` pass.
- A local k3s v1.36 run used a temporary protocol stub (not committed) with a service-account token and the committed RBAC: the agent listed and read Pods, read pod logs, listed Events, returned `busy` while draining, and resumed. The run caught a real content-negotiation bug — kube-apiserver answers `406` for an explicit `Accept: text/plain` on the `pods/log` subresource — so log reads now accept any media type; a unit test pins the header.
- A cross-language smoke ran the real Go agent against the real TypeScript gateway: the agent authenticated with a server-issued token, completed `hello`/`welcome`, answered `probe` with its capabilities, returned `unsupported_resource` for a resource outside the allowlist and `unreachable` for an absent API server, and was dropped with close code `4001` on revocation while the registry moved the row to `revoked`.
- The full suite passes: 28 test files (one opt-in file skipped), 203 tests passed plus one skipped. New coverage includes token issuance/hashing, registry lifecycle across a restart, the full handshake and probe through the registered upgrade route, gateway auth/name/protocol rejection, result correlation and timeout, revocation and replacement, the Portal cluster routes (including one-time token and cross-site rejection), and cluster readiness with zero clusters.

## Unreleased — 2026-11-14 — Plugin-owned incident store

### Fixed

- Fixed a fatal portability bug in `aiops_incident_report`: reports were persisted through `appendPluginRecord`, which forwards to the class-private `session.#appendRecord` and rejects any receiver created by another `dsh-session` copy. Externally installed plugins (Host `npx` dependency tree vs workspace pnpm store) therefore failed every report with `Receiver must be an instance of class Session`; the real-environment E2E reproduced 11 such failures, plus one correct rejection of a first report claiming `resolved`.

### Changed

- Incident and feedback state now live in the plugin-owned `aiops_incident` storage domain (`ctx.aiopsIncidents`): one zod-validated document per Session with a monotonic `revision`, plus an append-only feedback table. Writes resolve only after durability, lifecycle continuity and workspace pinning are enforced in the store, and `aiopsIncidents/changed` replaces the Session projection as the change signal. Records are per-record JSON under `<DSH_HOME>/storages/aiops_incident/`; keys that are not path-safe are hashed.
- Delivery markers now live in the `aiops_delivery` storage domain. `aiops-delivery` subscribes to `aiopsIncidents/changed`, and terminal markers still suppress duplicate pushes across restarts.
- The router's deterministic recovery closure and prior-diagnosis reuse report and read through the same store; reuse scans `listResolved(workspace, history.maxScanRecords)` instead of Session history (`history.maxScanSessions` was renamed).
- The Portal snapshot is version 3, joins the latest feedback against the incident `revision`, and shows `revision`/`updatedAt`; the history tools read the store, scope reads to the caller workspace, and cite `(sessionId, revision)`. Snapshot and history reads no longer depend on `ctx.sessionQuery` or FTS reconciliation.
- Session logs keep the diagnostic narrative only; the `aiops/incident-state` and `aiops/operator-feedback` plugin records are no longer written. Search in the history tools applies DSH's literal text filter to the bounded stored records in memory.

### Validation

- `pnpm run build` and the full suite pass: 25 test files, 178 tests passed plus one opt-in real-cluster test skipped (179 total). New store tests run on a real storage composition (report/revision, transition validation, durability across reopen, workspace scoping, feedback idempotence and stale-revision rejection); the incident and history packages have real Loader composition tests.
- k3s + Alertmanager E2E against DSH 0.2.2-rc.1 (`e2e-1794650227`) passed the receiver, lifecycle, retry, burst, Session, evidence, and report matrix: the Watchdog probe was filtered at the real Prometheus → AlertmanagerConfig → receiver path, duplicate deliveries stayed idempotent, firing → resolved → reopened produced a second Session round (`aiops-b1a3d448…` round 1, `aiops-67fc11f0…` round 2), and 9 durable incident documents were written under `<DSH_HOME>/storages/aiops_incident/`, including the router's `resolved` closure with `alert-recovery-*` evidence.

## Unreleased — 2026-11-14 — Diagnosis reuse

### Added

- Added best-effort diagnosis reuse in the incident router: when a firing alert opens a new round (`created` or `reopened`), the router reads this workspace's bounded stored incident records (new `history.maxScanRecords`/`history.maxIncidents` entry settings, defaults 200/3) for the latest resolved incident whose report text mentions a fingerprint identity token (full value or stable 8/6-char suffix), and attaches its top hypotheses and recommendations to the first-turn prompt as explicitly non-authoritative leads.
- Reuse is silent when the incident store is absent or a read fails, never runs for appended or recovery rounds, performs no writes, and adds no new hard service dependency (lazy `ctx.get`, type-only import).

### Validation

- Full build, 25 test files and 178 tests pass (one opt-in real-cluster test remains skipped), GitHub source-package preparation, link check, and `git diff --check` pass. New router tests cover config defaults plus end-to-end prompt attachment: matching resolved prior attached with lead-only wording, unrelated-fingerprint and unresolved priors excluded, and appended rounds not re-reading history.

## Unreleased — 2026-11-08 — Alert-recovery lifecycle linkage

### Added

- Added deterministic alert-recovery linkage in the incident router: after an Alertmanager recovery turn settles, the router reads the latest persisted `plugin:aiops/incident-state` record and, unless the incident is already resolved, appends the carried-forward state with status `resolved` plus one `alert-recovery-<receivedAt>` evidence entry citing the alert name and recovery time. The write is idempotent, runs through the same lifecycle validation as model reports, and the recovery prompt now states that the router performs the closure.

### Validation

- Full build, 25 test files and 176 tests pass (one opt-in real-cluster test remains skipped), GitHub source-package preparation, link check, and `git diff --check` pass. The router suite now runs its fake agents on real `Session` instances, and the four new tests cover the resolved transition append, the firing-only no-op, the already-resolved skip, and fingerprint release without a persisted report.

## Unreleased — 2026-11-08 — Container image

### Added

- Added a multi-stage `Dockerfile`, `.dockerignore`, and `scripts/docker-entrypoint.sh`: the image builds the GitHub source bundle on `node:24-slim`, pre-seeds a DSH Web profile at build time (first boot needs no network), and re-points the pnpm `link:` symlink absolutely after the seed copy. Both the DSH Web port and the Alertmanager receiver bind the container's primary interface address, because DSH rejects wildcard binds; `DSH_PUBLIC_URL`/`DSH_TRUSTED_HOSTS` support proxied deployments.
- Documented the container run in the bilingual deployment guide; corrected the stale `0.1.2-rc.1` DSH version in the Chinese root README.

### Validation

- The image builds end to end and boots the seeded profile offline: `/api/aiops/healthz` returns ok, `/api/aiops/readyz` reports `router` and `webhook` components ready, one authenticated Alertmanager canary returns `202`, and a wrong bearer is rejected with `401`.

## Unreleased — 2026-11-08 — Diagnosis IM delivery (aiops-delivery)

### Added

- Added `@deepseek-ai/dsh-aiops-delivery`, which subscribes to the `aiopsIncident` projection change feed and pushes each qualifying diagnosis to one IM incoming webhook: Feishu interactive cards, DingTalk markdown, or Slack incoming-webhook text, all bounded by title/fact clamps.
- Added durable, append-only `plugin:aiops/delivery` marker records (`delivered` | `failed` with a bounded reason) written into the diagnostic Session, so restarts and replays never double-push and later report updates retry after a failed attempt burst.
- Added a severity gate (`minSeverity`, default `warning`): below-threshold reports are skipped until severity escalates, and one warning per session is logged when the webhook credential is missing or the URL is not a clean https URL.
- Added Loader entries (source and bundle patches) plus settings-UI projection for `provider`, `webhookUrlEnv` (credential reference; the webhook URL never enters the patch or settings store), `minSeverity`, `portalBaseUrl` deep link, `timeoutMs`, `maxAttempts`, `retryBackoffMs`, and `maxResponseBytes`.
- Documented delivery deployment and IM webhook token rotation (per-delivery credential re-resolution, no restart needed) in the bilingual deployment guide and the AIOps architecture guide.

### Validation

- Full TypeScript and Portal builds pass, including the new package; GitHub source-package preparation passes.
- 25 test files and 172 tests pass; one opt-in real-cluster test remains skipped in the default suite. The delivery suite covers provider payload shapes, severity gating and escalation, delivered/failed markers, idempotent re-push suppression, provider response validation (Feishu `code`, DingTalk `errcode`, Slack `ok`), timeout, missing/invalid webhook URLs, and configuration validation.

## Unreleased — 2026-11-08 — DSH 0.2.2-rc.1 upgrade (0.2.0-rc.1)

### Changed

- Upgraded every `@deepseek-ai/dsh-*` dependency from `^0.1.2-rc.1` to `^0.2.2-rc.1`, with Cordis `^4.1.0`, Schemastery `^3.19.0`, and `cordis-plugin-include`/`loader` `^1.1.0`; removed the deleted `@deepseek-ai/dsh-agent-presets` package.
- Migrated settings from the 0.1.x `SettingsProvider`/`settingsScope` model to the 0.2.x `SettingsForms`/`ConfigForm` model. Each Loader entry (`aiops-alertmanager`, `aiops-prometheus`, `aiops-kubernetes`, `aiops-incident-router`) now projects its static `Config` into the settings UI, and a committed settings edit reloads the entry with new config instead of applying live in-process.
- Routed agent creation through the 0.2.x named-preset mechanism (`agents.create({ meta: { agentPreset } })`) instead of mounting preset factories from the removed `agentPresets` service.
- Made routing-policy changes restart-applied: the incident router reconciles the durable policy audit against the newest committed policy at construction and records an audit entry when the reloaded entry config differs from the persisted baseline (store schema v3 → v4, adding a `store_meta` routing-policy baseline).
- Carried incident state as DSH 0.2.x ignorable plugin records: event types `aiops/incident-state` and `aiops/operator-feedback` are now `plugin:aiops/incident-state` and `plugin:aiops/operator-feedback`, written via `appendPluginRecord` and read via `pluginRecordOf`, so an unknown reader retains and skips them instead of refusing the whole Session log. Sessions persisted under 0.1.x with the old non-ignorable types refuse to load under 0.2.x readers and must be started fresh.
- Adopted the 0.2.x session APIs: `SessionPersistence.listSnapshots` → `list`, projection registration now returns typed handles (per-handle `stateOf` instead of the deprecated registry-level read).
- Adapted Loader-composition tests to the 0.2.x tool model: `ctx.tools.execute` is batch-only and requires a deployment-level `ToolExecutor` (test compositions install a minimal pass-through executor through `tools.setExecutor`), and `@deepseek-ai/dsh-session-persistence-jsonl` no longer ships a default export.

## Unreleased — 2026-09-08

### Added

- Added `@deepseek-ai/dsh-aiops-observability` with exact liveness, component-aware readiness, and Prometheus text endpoints at `/api/aiops/healthz`, `/api/aiops/readyz`, and `/api/aiops/metrics`.
- Added process-lifetime counters and fixed-bucket latency telemetry for webhook outcomes, grouped/deferred/dropped route work, dispatch failures, queue depth/age, active diagnoses, and model token reservations. Metric labels are fixed enums and never contain alert-derived identifiers.
- Added bounded `prometheus_rules`, `prometheus_targets`, and `prometheus_discovery` tools with Provider-owned result, matcher, input, response-size, timeout, cancellation, and discovery-window limits.
- Added canonical Prometheus alert-rule and target-health evidence, including exact rule expressions, scrape errors, deterministic label ordering, result truncation, and locally parsed same-origin `generatorURL` expressions without arbitrary URL fetching.
- Made the opt-in real-cluster CrashLoopBackOff exercise poll through transient restart states before collecting Pod, Event, current-log, and previous-log evidence.
- Added versioned `aiops-routing` settings for ignored alert names, severity normalization/defaults, cooldown, queue, retry, concurrency, and model-token budgets. Portal changes require a side-effect-free alert-label dry-run, save atomically with a revision fence, apply live, and are recorded in durable policy audit.
- Added a guarded, repeatable real Alertmanager/k3s E2E runner covering the Prometheus → AlertmanagerConfig → authenticated receiver path, Kubernetes CrashLoop, `TargetDown`, arbitrary and missing severity, firing/resolved/reopened rounds, duplicate delivery, burst pressure, and restart recovery.
- Added a persistent Portal view of the public Alertmanager webhook URL and credential status without returning the credential value to the browser.
- Added `AIOPS_WEBHOOK_PUBLIC_URL` support so the displayed receiver URL can differ from the loopback listener address.
- Added a real Prometheus Operator/Alertmanager/k3s webhook fixture at `deploy/alertmanager/k3s-webhook-e2e.yaml`; its bearer credential is created separately and is not stored in the repository.
- Added bilingual production guidance for the authenticated Host boundary, TLS reverse proxy, credential rotation, configuration migration, clean install/upgrade, rollback data, and supported runtime versions.
- Added a repository handoff document containing the implementation baseline, architecture decisions, verification commands, and the Stage F.3 continuation plan.

### Changed

- Replaced the fixed alertname allowlist with a general routing policy. All alert names are accepted by default, while `routingPolicy.ignoredAlertnames` provides optional exact-match noise exclusions.
- Changed missing and unknown severity labels to use `routingPolicy.defaultSeverity` instead of filtering the alert. Severity-map keys are matched case-insensitively and the shipped mapping covers common aliases.
- Generalized the globally registered diagnostic skill from `k8s-diag` to `aiops-diag`. It selects Alertmanager, Prometheus/service, and Kubernetes evidence branches from the routed labels instead of assuming every alert is Kubernetes-related.
- Updated `aiops-diag` to recover the alert rule and target identity before querying metrics or declaring a non-Kubernetes alert under-specified.
- Kept the published `@deepseek-ai/dsh-aiops-skill-k8s-diag` package name for source-install compatibility while changing its registered skill identity.
- Made routed diagnostic narrative and persisted incident-report text follow the current DSH locale preference, with English as the Host-compatible fallback.
- Updated English and Chinese architecture, package, installation, and roadmap documentation for the general routing model and the active Stage F.3 hardening plan. RAG remains deferred.

### Security

- Webhook secrets can remain in `<DSH_HOME>/.credentials.yaml` and are resolved through a credential reference rather than embedded in the Cordis patch.
- Removed Portal credential reveal and write behavior. The browser receives only the public receiver URL and `secretConfigured`; plaintext stays in the deployment credential provider.
- Connection-test and routing dry-run POSTs reject cross-site browser requests using `Sec-Fetch-Site` and same-host `Origin`, while durable settings writes remain on DSH's revision-fenced Settings API.
- Documented rotation as an administrator workflow and verified that a restarted instance accepts the rotated credential while rejecting the old value with `401`.

### Validation

- Full TypeScript and Portal builds pass.
- GitHub source-package preparation passes.
- 23 test files and 155 tests pass; one opt-in real-cluster test remains skipped in the default suite.
- The local k3s validation passed the native CrashLoopBackOff Provider exercise and observed a new filtered `Watchdog` audit row delivered through an Operator-loaded PrometheusRule and AlertmanagerConfig into the real authenticated receiver.
- An isolated DSH Web profile passed add, config dump, real startup, health/readiness/metrics, Portal v2, same-origin dry-run, cross-site rejection, credential rotation, restart, and remove checks on Node 24 and pnpm 11.7.
- Relative Markdown links and whitespace checks pass.

## 0.1.2-rc.1

### Added

- Initial installable DSH AIOps bundle with read-only Alertmanager, Prometheus, and Kubernetes Providers.
- Authenticated Alertmanager webhook routing into deterministic diagnostic Sessions.
- Durable fingerprint rounds, replay protection, queueing, storm control, structured incident reports, operator feedback, history tools, and the DSH Web AIOps Portal.
- Native kubeconfig-based Kubernetes access without requiring a local `kubectl` binary.
