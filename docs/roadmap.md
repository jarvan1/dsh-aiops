# DSH AIOps roadmap

English | [中文](roadmap.zh.md)

Updated: 2026-09-06

## Completed

- Stage A: DSH Session Query event-text extractor extension, with AIOps owning its domain extractor.
- Stage B: independent `dsh-aiops` workspace, initial eight-package bundle family, local install, build, test, pack, and uninstall workflow.
- Stage C: two new ingress and routing packages, bringing the workspace to ten packages; authenticated Alertmanager v4 ingress; bounded payload normalization; stable fingerprint derivation; exact delivery replay protection; persistent fingerprint, round, and Session mapping; high-signal alertname and severity policy; deterministic create, append, resolve, reopen, concurrent coalescing, and restart resume behavior; auditable `aiops/alert-routed` Session events.
- Stage D: `aiops/alert-routed` v2 with a canonical `startsAt` T0 and bounded replay-stable window; exact Prometheus, Kubernetes Event, and Pod-log time parameters; inclusive Event and log upper-bound filtering; an eleventh package that globally registers versioned `k8s-diag` instructions across Workspace changes; seven scenario playbooks; keyless alert-to-report Session replay; and a real read-only CrashLoopBackOff Provider exercise.
- Stage E: append-only `aiops/operator-feedback` events and a confirm/correct/reject tool; durable per-source/fingerprint grouping and cooldown; a bounded restart-safe queue; global and severity concurrency plus model-token reservation limits; deferred, grouped, dropped, started, completed, and failed audit outcomes; and workspace-scoped feedback and routing-audit queries. Deterministic tests cover bursts, restart recovery, queue saturation, cooldown, and feedback replay.
- Stage F: a twelfth dual-face `dsh-aiops-portal` package; a persistent sidebar entry plus native Session `AIOps` view in DSH Web; live, durable Prometheus and Alertmanager endpoint settings; a fixed same-origin read-only endpoint scoped to the router-configured workspace; incident/active/critical/review summary metrics, structured search and filters, master/detail incident inspection, operator feedback, route audit, empty/loading/error states, manual and 30-second refresh, and responsive layout. The Portal adds no database and accepts no client-supplied workspace.

Stage D validation includes 17 passing test files and 108 passing tests in the default suite, plus one opt-in real-cluster test, skill-structure validation, relative documentation links, all eleven package tarballs, and isolated DSH Web profile install/config-dump/runtime-start/remove checks. The real exercise used an existing CrashLoopBackOff Pod through the product Kubernetes Provider to read the Pod, absolute-window Events, and bounded current and previous logs without mutation.

Stage E validation includes 17 passing test files and 118 passing tests in the default suite, plus one opt-in real-cluster test. The complete TypeScript build, relative documentation links, bundle tarball, and tarball-content checks for all four affected packages pass.

Stage F validation includes 19 passing test files and 128 passing tests in the default suite, plus one opt-in real-cluster test. The complete TypeScript build, self-contained Portal Host entry regression, global sidebar/view registration regression, live Provider settings tests, Host/Web artifacts, relative documentation links, Portal and bundle tarball-content checks, and an isolated real DSH Web startup without endpoint environment variables plus Portal API read pass.

## Next: Stage G — evaluated RAG pilot (deferred)

1. Establish a small human-maintained runbook/postmortem corpus and fixed diagnosis evaluation set, with owner, sensitivity, scope, and expiry metadata for every document.
2. Pilot WeKnora as an independently deployed, replaceable retrieval Provider. The DSH plugin exposes only knowledge-base-scoped, read-only, auditable search and document reads; retrieval never becomes incident truth.
3. Keep `k8s-diag` live-facts-first and retrieve only when useful. Label knowledge as guidance or prior context, never as observed evidence.
4. Evolve the incident schema to store knowledge references, document versions, and retrieval time separately from alert, metric, Kubernetes, and log evidence.
5. Replay identical alerts with and without RAG to measure recall, citation correctness, stale-document harm, authorization leakage, latency, and token cost. Never auto-ingest unreviewed model reports.

Approved write actions, ITSM adapters, and multi-tenant governance remain later platform work.
