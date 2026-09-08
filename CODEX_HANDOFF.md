# DSH AIOps project handoff

Updated: 2026-09-08

This document is the continuation entry point for a new Codex session. Read it together with [`docs/aiops.zh.md`](docs/aiops.zh.md) and [`docs/roadmap.zh.md`](docs/roadmap.zh.md).

## Repository state

- Repository: `git@github.com:jarvan1/dsh-aiops.git`
- Branch: `main`
- Current base commit: `e1fd2aa` (`feat: use native Kubernetes client`)
- The working tree contains important uncommitted work. Do not reset, checkout, clean, or overwrite it.
- Before continuing on another machine, commit and push these changes or copy the complete working tree. A fresh clone of `main` at `e1fd2aa` does not contain the work described below.
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

## Current uncommitted implementation

Preserve all current modifications. They contain three related batches:

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
- The Portal exposes the configured webhook URL and whether the credential exists; current work also supports an explicit reveal action backed by DSH credentials.
- `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` may be stored under `refs` in `<DSH_HOME>/.credentials.yaml`; the Cordis patch contains only the credential reference name.
- [`deploy/alertmanager/k3s-webhook-e2e.yaml`](deploy/alertmanager/k3s-webhook-e2e.yaml) is a real Prometheus Operator/Alertmanager test fixture. It deliberately creates a crashing Pod. Replace its host address for the target environment and create the referenced Secret separately.

## Current verification baseline

The following checks passed with the current files on 2026-09-08:

```text
pnpm run build
pnpm exec vitest run
  Test Files: 21 passed, 1 skipped
  Tests:      139 passed, 1 skipped
pnpm run build:github
node scripts/check-links.mjs
git diff --check
```

The skipped test is an opt-in real-cluster test. Run real-cluster tests only against an explicitly designated test cluster.

## Next active stage: F.3 — generic diagnosis hardening

RAG remains deferred. The next stage should make general alerts diagnosable without relying on Kubernetes-specific context.

### F.3.1 Prometheus discovery

Add bounded, read-only Provider methods and model tools for:

- rule and alert-expression lookup by alert name and labels;
- target health and scrape-error lookup;
- label/series discovery with strict result limits;
- safe parsing of Alertmanager `generatorURL` without accepting arbitrary model-supplied URLs.

Suggested tool names are `prometheus_rules`, `prometheus_targets`, and a tightly bounded label/series discovery tool. Update `aiops-diag` so it uses these before declaring a non-Kubernetes alert under-specified. Do not invent PromQL or metric names.

Acceptance criteria:

- A custom non-Kubernetes alert can recover its rule expression and target identity.
- Every request has timeouts, response-size limits, result-count limits, cancellation, canonical output, and unit tests.
- No write API, arbitrary URL fetch, or unrestricted discovery is introduced.

### F.3.2 Product self-observability

Expose health/readiness and Prometheus metrics for webhook authentication failures, deliveries, queue depth/age, grouped/deferred/dropped work, active diagnoses, dispatch failures, diagnostic latency, and model token reservations. Avoid alert labels that create unbounded metric cardinality.

### F.3.3 Repeatable real E2E matrix

Turn the manual k3s fixture into documented repeatable tests for:

- Kubernetes CrashLoop alert;
- Prometheus `TargetDown`;
- arbitrary non-Kubernetes alert name;
- missing and vendor-specific severity;
- firing, resolved, and reopened rounds;
- duplicate delivery and Alertmanager retry;
- burst grouping, queue pressure, and restart recovery.

Tests must verify the real Alertmanager receiver, DSH route audit, Session creation, selected evidence branch, and persisted report. Never commit the bearer secret.

### F.3.4 Portal routing-policy management

Add a versioned, validated settings surface for ignored alert names, severity mapping/default, cooldown, concurrency, queue, and token budgets. Include dry-run evaluation against a pasted or historical normalized alert before save. Preserve safe static defaults and audit configuration changes.

### F.3.5 Security and release hardening

- Review the Portal secret-reveal endpoint before release. It currently returns plaintext only after an explicit request, but still needs a clear Host authorization boundary, CSRF posture, audit event, and rotation story. Prefer keeping credentials server-side unless copying into Alertmanager is an explicit administrator workflow.
- Add TLS/reverse-proxy deployment guidance.
- Verify clean install, upgrade from the old allowlist schema, uninstall, GitHub source install, and supported DSH/Node version matrix.
- Commit and push only after the full verification baseline passes again.

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
