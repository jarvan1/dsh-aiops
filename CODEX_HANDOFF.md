# DSH AIOps project handoff

Updated: 2026-09-08

This document is the continuation entry point for a new Codex session. Read it together with [`docs/aiops.zh.md`](docs/aiops.zh.md) and [`docs/roadmap.zh.md`](docs/roadmap.zh.md).

## Repository state

- Repository: `git@github.com:jarvan1/dsh-aiops.git`
- Branch: `main`
- Current base commit: `8ee74bf` (`feat: generalize alert diagnosis workflow`)
- The working tree contains important uncommitted work. Do not reset, checkout, clean, or overwrite it.
- Before continuing on another machine, commit and push these changes or copy the complete working tree. A fresh clone of `main` at `8ee74bf` does not contain the work described below.
- Never commit a real `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`, kubeconfig, bearer token, or other credential.

## Product objective

Build an installable DSH plugin that turns Alertmanager notifications into read-only, evidence-backed AIOps diagnostic Sessions. The product should be general-purpose rather than tied to a fixed Kubernetes alertname list. Session JSONL is diagnostic truth; SQLite is used for routing coordination, audit, and a rebuildable search index.

The first-version loop is operational:

```text
Alertmanager webhook
  -> authentication and bounded normalization
  -> durable fingerprint router and storm control
  -> deterministic DSH Session
  -> aiops-diag
  -> Alertmanager / Prometheus / Kubernetes evidence
  -> structured incident report and operator feedback
  -> history tools and AIOps Portal
```

## Completed stages

- **Stage A:** DSH Session Query integration and AIOps-owned semantic extraction.
- **Stage B:** independent monorepo, installable bundle, build/test/pack workflow.
- **Stage C:** authenticated Alertmanager v4 webhook, bounded payloads, fingerprint derivation, deterministic Session rounds, replay protection, persistent SQLite routing.
- **Stage D:** alert-time T0 and replay-stable absolute query windows, bounded Prometheus/Kubernetes/Event/log evidence, packaged diagnostic skill, real read-only Kubernetes exercise.
- **Stage E:** append-only operator feedback, persistent queue, grouping, cooldown, retry, concurrency/token budgets, and route audit.
- **Stage F:** persistent DSH Web AIOps entry, incident overview/detail, feedback and route-audit display, live datasource settings, connection tests, and responsive UI.
- **Stage F.1:** native kubeconfig client without requiring local `kubectl`; Portal save is gated by API identity and required Pod/Event/log RBAC checks.
- **Stage F.2:** general alert routing and general `aiops-diag` workflow.
- **Stage F.3.1:** bounded Prometheus rule, target, label, and series discovery for general alerts.
- **Stage F.3.2:** product liveness/readiness endpoints and low-cardinality Prometheus telemetry.
- **Stage F.3.3:** guarded repeatable real Alertmanager/k3s receiver and lifecycle matrix.
- **Stage F.3.4:** versioned live Portal routing-policy management with dry-run and durable audit.
- **Stage F.3.5:** no-secret Portal boundary, cross-site POST protection, TLS/rotation/migration guidance, and isolated release verification.

## Current uncommitted implementation

Preserve all current modifications. They contain seven related batches:

### 1. Follow the DSH output language

- `incident-router` reads DSH's durable locale preference for every model turn.
- User-facing diagnosis and persisted report prose follow that locale; identifiers and observed values remain unchanged.
- English is the fallback when the Host preference is unavailable.

### 2. General alert routing

- Removed the fixed `alertnameAllowlist` design.
- `routingPolicy.ignoredAlertnames` is now an exact-match noise list. An empty list accepts every alert name.
- Unknown or absent severity labels use `routingPolicy.defaultSeverity` rather than being filtered.
- Severity keys are matched case-insensitively.
- The shipped configuration ignores `Watchdog` and `InfoInhibitor` and maps common severity spellings.
- The registered skill is now `aiops-diag`. It chooses Alertmanager, Prometheus/service, and Kubernetes branches from available labels; Kubernetes is not assumed.
- The npm package/directory remains named `dsh-aiops-skill-k8s-diag` for installation compatibility.

Current router configuration shape:

```yaml
routingPolicy:
  ignoredAlertnames:
    - Watchdog
    - InfoInhibitor
  defaultSeverity: warning
severityMap:
  debug: info
  info: info
  notice: info
  warn: warning
  warning: warning
  error: critical
  critical: critical
  fatal: critical
  page: critical
```

Profiles using the former `alertnameAllowlist` field must migrate to this shape.

### 3. Portal and real Webhook support

- Prometheus, Alertmanager, and Kubernetes settings have connection tests and can only be saved after successful tests.
- The Portal exposes the configured webhook URL and whether the credential exists. It has no reveal or credential-write endpoint and never returns the bearer value to the browser.
- `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` may be stored under `refs` in `<DSH_HOME>/.credentials.yaml`; the Cordis patch contains only the credential reference name.
- Connection-test and routing-policy dry-run POSTs reject cross-site browser requests. Keep all Web routes behind the authenticated DSH Host boundary.

### 4. Prometheus discovery

- `PrometheusRuntime` now has bounded rule, target-health, and label/series discovery methods.
- The model tools are `prometheus_rules`, `prometheus_targets`, and `prometheus_discovery`; the complete observation set now has ten tools.
- Rule lookup recovers exact PromQL by alert name, compares supplied identifying labels, and excludes active-alert expansion.
- Target lookup requires exact labels or a scrape pool, returns scrape health/error evidence, and strips credentials/query/fragment from observed URLs.
- Metadata discovery requires concrete selectors and an absolute time window, and enforces Provider-owned matcher, input, window, response-byte, and result-count limits.
- A `generatorURL` is accepted only for the configured same-origin Prometheus graph path. Its expression is parsed locally before any Provider request and the URL is never fetched.
- `aiops-diag` now performs rule/target discovery before metric querying or declaring a non-Kubernetes alert under-specified.

### 5. Product self-observability

- A new `dsh-aiops-observability` Cordis service is loaded before the webhook adapter and router.
- The main Web server exposes exact `GET|HEAD` endpoints at `/api/aiops/healthz`, `/api/aiops/readyz`, and `/api/aiops/metrics`.
- Readiness requires both the Alertmanager ingress and incident router to be registered.
- Prometheus exposition covers bounded webhook outcomes, durable queue depth/oldest age, grouped/deferred/dropped work, active diagnoses, dispatch failures, fixed-bucket diagnostic latency, and model token reservations.
- Metrics use only fixed outcome labels; alert names, fingerprints, delivery IDs, Session IDs, namespaces, and other unbounded identifiers are excluded.

### 6. Repeatable real Alertmanager/k3s matrix

- [`scripts/aiops-e2e.mjs`](scripts/aiops-e2e.mjs) owns guarded setup, direct receiver exercise, Portal verification, restart seeding/verification, and exact-namespace cleanup.
- The fixture creates a PrometheusRule, AlertmanagerConfig, stdin-only Secret, run marker, and one intentionally crashing Pod. Synthetic alerts carry the namespace label required by Prometheus Operator's namespace-scoped AlertmanagerConfig route.
- The scenario contract covers CrashLoop, `TargetDown`, arbitrary alertname, missing/vendor severity, firing/resolved/reopened, exact retry, burst pressure, and restart recovery.
- A default-ignored `Watchdog` rule must produce a new filtered route-audit row, proving the real Prometheus → Alertmanager → authenticated receiver path without a model turn.
- The static YAML is only a readable non-routable example; the executable runner is documented in [`deploy/alertmanager/README.md`](deploy/alertmanager/README.md).

### 7. Live routing policy and release hardening

- `aiops-routing` version 1 owns noise exclusions, severity mapping/default, model budgets, and storm controls. Router validation enforces cross-field concurrency and token constraints.
- Portal edits require a successful side-effect-free labels dry-run and one revision-fenced atomic save. Commits apply live and are recorded with before/after hashes and changed fields in `routing_policy_audit`.
- The deprecated `alertnameAllowlist` field is accepted only for startup migration; it is ignored, emits a warning when non-empty, and safe general-routing defaults are used.
- [`docs/deployment.md`](docs/deployment.md) and its Chinese version cover TLS, Host authorization, reverse-proxy headers, credential rotation, migration, backups, retention, install/upgrade, and version support.

## Current verification baseline

The following checks passed with the current files on 2026-09-08:

```text
pnpm run build
pnpm exec vitest run
  Test Files: 23 passed, 1 skipped
  Tests:      155 passed, 1 skipped
pnpm run build:github
node scripts/check-links.mjs
git diff --check
```

The skipped test is an opt-in real-cluster test. Run real-cluster tests only against an explicitly designated test cluster.

The opt-in native Kubernetes test was also run against the local k3s cluster on 2026-09-08 and passed against the runner-created CrashLoopBackOff Pod. Prometheus loaded all runner rules, Alertmanager loaded the namespace-scoped AlertmanagerConfig, and an authenticated real receiver delivery produced a new filtered `Watchdog` route-audit row. The temporary `aiops-e2e-release-test` namespace was deleted afterward.

An isolated DSH Web profile was installed from the current working tree and passed config dump, real startup, liveness/readiness/metrics, Portal v2, same-origin routing dry-run, cross-site rejection, credential status without plaintext, credential rotation with old-value `401`, restart, and uninstall checks on Node 24.20 and pnpm 11.7. Real startup exposed and fixed two integration-only issues: clean-install resolution of the deprecated array and the router's missing static `settings` injection.

## Next active stage: Stage G — evaluated RAG pilot (deferred)

F.3.3–F.3.5 are complete. Do not add retrieval until there is an owned runbook/postmortem corpus, access and freshness policy, citations, and a fixed evaluation set. The next implementation should begin by defining that corpus and evaluation harness, not by wiring an unmeasured vector store into diagnosis.

## Later stages

- Aggregated log Provider such as Loki or OpenSearch behind a provider-neutral `logs_search` tool.
- Multi-fingerprint alert correlation and incident merge/split.
- Kubernetes/service topology and deployment/change evidence from CI/CD or Git.
- Portal acknowledgement, assignment, comments, feedback submission, and manual re-diagnosis.
- Notification and ITSM adapters.
- Multi-cluster, multi-datasource, tenant isolation, RBAC, retention, backup, and HA/external database Providers.
- Approval-gated, predefined remediation actions with dry-run, audit, timeout, and rollback. Never expose unrestricted shell or kubectl execution.
- Evaluated WeKnora RAG pilot only after there is an owned corpus, access/freshness policy, citations, and a fixed evaluation set.

## First commands on the next machine

After the current working tree has been committed and pushed:

```sh
git clone git@github.com:jarvan1/dsh-aiops.git
cd dsh-aiops
pnpm install
pnpm test
pnpm run build:github
node scripts/check-links.mjs
git status --short
```

Then inspect `git log -1`, this handoff, the roadmap, and the current diff before editing. Preserve unrelated user changes and keep the acquisition/tool boundary read-only.
