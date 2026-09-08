# Changelog

All notable changes to DSH AIOps are documented in this file.

The project follows semantic-versioning conventions. Changes that have not yet been assigned a release tag remain under **Unreleased**.

## Unreleased — 2026-09-08

### Added

- Added a persistent Portal view of the public Alertmanager webhook URL and credential status, with an explicit show/hide action backed by the DSH credential provider.
- Added `AIOPS_WEBHOOK_PUBLIC_URL` support so the displayed receiver URL can differ from the loopback listener address.
- Added a real Prometheus Operator/Alertmanager/k3s webhook fixture at `deploy/alertmanager/k3s-webhook-e2e.yaml`; its bearer credential is created separately and is not stored in the repository.
- Added a repository handoff document containing the implementation baseline, architecture decisions, verification commands, and the Stage F.3 continuation plan.

### Changed

- Replaced the fixed alertname allowlist with a general routing policy. All alert names are accepted by default, while `routingPolicy.ignoredAlertnames` provides optional exact-match noise exclusions.
- Changed missing and unknown severity labels to use `routingPolicy.defaultSeverity` instead of filtering the alert. Severity-map keys are matched case-insensitively and the shipped mapping covers common aliases.
- Generalized the globally registered diagnostic skill from `k8s-diag` to `aiops-diag`. It selects Alertmanager, Prometheus/service, and Kubernetes evidence branches from the routed labels instead of assuming every alert is Kubernetes-related.
- Kept the published `@deepseek-ai/dsh-aiops-skill-k8s-diag` package name for source-install compatibility while changing its registered skill identity.
- Made routed diagnostic narrative and persisted incident-report text follow the current DSH locale preference, with English as the Host-compatible fallback.
- Updated English and Chinese architecture, package, installation, and roadmap documentation for the general routing model and the active Stage F.3 hardening plan. RAG remains deferred.

### Security

- Webhook secrets can remain in `<DSH_HOME>/.credentials.yaml` and are resolved through a credential reference rather than embedded in the Cordis patch.
- The Portal secret endpoint returns `Cache-Control: no-store`, omits the value unless explicitly requested, and the client removes the value from component state when hidden.
- Secret reveal still relies on the surrounding DSH Web authorization boundary; dedicated authorization, CSRF audit, reveal audit, and credential rotation are tracked for Stage F.3 before production use.

### Validation

- Full TypeScript and Portal builds pass.
- GitHub source-package preparation passes.
- 21 test files and 139 tests pass; one opt-in real-cluster test remains skipped in the default suite.
- Relative Markdown links and whitespace checks pass.

## 0.1.2-rc.1

### Added

- Initial installable DSH AIOps bundle with read-only Alertmanager, Prometheus, and Kubernetes Providers.
- Authenticated Alertmanager webhook routing into deterministic diagnostic Sessions.
- Durable fingerprint rounds, replay protection, queueing, storm control, structured incident reports, operator feedback, history tools, and the DSH Web AIOps Portal.
- Native kubeconfig-based Kubernetes access without requiring a local `kubectl` binary.
