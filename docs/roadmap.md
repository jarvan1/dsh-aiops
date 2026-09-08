# DSH AIOps roadmap

English | [中文](roadmap.zh.md)

Updated: 2026-09-08

## Completed

- Stage A: DSH Session Query event-text extractor extension, with AIOps owning its domain extractor.
- Stage B: independent `dsh-aiops` workspace, initial eight-package bundle family, local install, build, test, pack, and uninstall workflow.
- Stage C: two new ingress and routing packages, bringing the workspace to ten packages; authenticated Alertmanager v4 ingress; bounded payload normalization; stable fingerprint derivation; exact delivery replay protection; persistent fingerprint, round, and Session mapping; high-signal alertname and severity policy; deterministic create, append, resolve, reopen, concurrent coalescing, and restart resume behavior; auditable `aiops/alert-routed` Session events.
- Stage D: `aiops/alert-routed` v2 with a canonical `startsAt` T0 and bounded replay-stable window; exact Prometheus, Kubernetes Event, and Pod-log time parameters; inclusive Event and log upper-bound filtering; an eleventh package that globally registers versioned diagnostic instructions across Workspace changes (now exposed as `aiops-diag`); scenario playbooks; keyless alert-to-report Session replay; and a real read-only CrashLoopBackOff Provider exercise.
- Stage E: append-only `aiops/operator-feedback` events and a confirm/correct/reject tool; durable per-source/fingerprint grouping and cooldown; a bounded restart-safe queue; global and severity concurrency plus model-token reservation limits; deferred, grouped, dropped, started, completed, and failed audit outcomes; and workspace-scoped feedback and routing-audit queries. Deterministic tests cover bursts, restart recovery, queue saturation, cooldown, and feedback replay.
- Stage F: a twelfth dual-face `dsh-aiops-portal` package; a persistent sidebar entry plus native Session `AIOps` view in DSH Web; live, durable Prometheus and Alertmanager endpoint settings; a fixed same-origin read-only endpoint scoped to the router-configured workspace; incident/active/critical/review summary metrics, structured search and filters, master/detail incident inspection, operator feedback, route audit, empty/loading/error states, manual and 30-second refresh, and responsive layout. The Portal adds no database and accepts no client-supplied workspace.
- Stage F.1: the default Kubernetes Provider now uses the official native client and kubeconfig directly, removing the host `kubectl` requirement while preserving an explicit compatibility subpath. The Portal persists a server-side kubeconfig path/context and gates saving on API identity plus Pod, Event, and Pod-log RBAC checks; kubeconfig contents and credentials never enter the browser.
- Stage F.2: routing is now general-purpose rather than alertname-allowlist based. Every alert name is accepted by default, exact noise exclusions are optional, unknown or absent severity labels use a configured fallback, and the globally registered `aiops-diag` workflow dynamically selects Alertmanager, Prometheus, service, and Kubernetes evidence branches from available labels.

Stage D validation includes 17 passing test files and 108 passing tests in the default suite, plus one opt-in real-cluster test, skill-structure validation, relative documentation links, all eleven package tarballs, and isolated DSH Web profile install/config-dump/runtime-start/remove checks. The real exercise used an existing CrashLoopBackOff Pod through the product Kubernetes Provider to read the Pod, absolute-window Events, and bounded current and previous logs without mutation.

Stage E validation includes 17 passing test files and 118 passing tests in the default suite, plus one opt-in real-cluster test. The complete TypeScript build, relative documentation links, bundle tarball, and tarball-content checks for all four affected packages pass.

Stage F validation includes 19 passing test files and 128 passing tests in the default suite, plus one opt-in real-cluster test. The complete TypeScript build, self-contained Portal Host entry regression, global sidebar/view registration regression, live Provider settings tests, Host/Web artifacts, relative documentation links, Portal and bundle tarball-content checks, and an isolated real DSH Web startup without endpoint environment variables plus Portal API read pass.

Stage F.1 validation includes a local mock Kubernetes API exercise covering kubeconfig loading, namespaced native object reads, exact absolute-time Pod logs, version probing, and three SelfSubjectAccessReviews, alongside Portal save gating and RBAC failure tests.

Stage F.2 validation covers configured noise exclusion, arbitrary alert names, missing and unknown severity fallback, case-insensitive severity mapping, dynamic evidence-source instructions, skill registration, and package-level TypeScript checks.

## Next: Stage F.3 — generic diagnosis hardening

1. Add bounded Prometheus rule, target, label, and series discovery so `aiops-diag` can recover the expression and target for arbitrary non-Kubernetes alerts without inventing PromQL.
2. Add health/readiness and low-cardinality Prometheus metrics for webhook delivery, authentication failures, queue depth/age, dispatch outcomes, active diagnoses, latency, and token reservations.
3. Make the real Alertmanager/k3s exercise repeatable across Kubernetes, target-down, arbitrary alertname, missing severity, lifecycle, retry, burst, and restart cases.
4. Add versioned Portal routing-policy settings and dry-run evaluation for noise exclusions, severity normalization/default, cooldown, queue, concurrency, and token budgets.
5. Harden credential disclosure, Host authorization, CSRF posture, secret rotation, TLS guidance, configuration migration, and clean install/upgrade verification.

Detailed continuation instructions and acceptance criteria are in [`CODEX_HANDOFF.md`](../CODEX_HANDOFF.md).

## Later: Stage G — evaluated RAG pilot (deferred)

Establish an owned runbook/postmortem corpus and fixed evaluation set before piloting WeKnora as a replaceable read-only retrieval Provider. Knowledge must remain guidance or prior context rather than incident truth, and reports must store cited document version and retrieval time separately from live evidence. Compare identical alerts with and without retrieval for recall, citation correctness, stale-document harm, authorization leakage, latency, and token cost. Never auto-ingest unreviewed model reports.

Aggregated logs, alert correlation, topology/change evidence, approved write actions, ITSM adapters, HA, and multi-tenant governance remain later platform work.
