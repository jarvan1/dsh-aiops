# Changelog

All notable changes to DSH AIOps are documented in this file.

The project follows semantic-versioning conventions. Changes that have not yet been assigned a release tag remain under **Unreleased**.

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
