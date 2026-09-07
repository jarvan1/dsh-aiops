# Agent Note: AIOps cross-Session incident history

Status: implemented

English | [中文](2026-09-05-aiops-cross-session-incident-history.zh.md)

## Problem

Durable incident state exists inside individual Session logs, but an operator or model cannot discover prior incidents without already knowing each Session id and event sequence. A second authoritative incident database would duplicate writes and create recovery and consistency obligations. Generic Session search already has the required persistence observation, SQLite reconciliation, literal full-text semantics, and exact event reads, but it does not extract semantic text from the AIOps event or expose incident-focused tools.

## Decision

The AIOps subsystem reuses the complete `ctx.sessionQuery` capability seam. `dsh-aiops-incident` owns and registers semantic extraction for all stable `aiops/incident-state` fields; `dsh-session-query-sqlite` reconciles those documents from live Sessions and persisted Session revisions into its disposable FTS5 index; `dsh-tool-aiops-history` is the incident-focused Consumer.

The Consumer exposes `aiops_incident_list`, `aiops_incident_get`, and `aiops_incident_search`. It derives authorization from the owning Agent Session and limits every cross-Session operation to exact `cwd` equality. A Session without `cwd` can read only itself. Exact reads use the cited Session id and sequence to reload and decode the authoritative append-only event; index content never substitutes for incident state.

The AIOps bundle replaces the base session-query configuration with `openAt: startup` and a dedicated `aiops-incidents.sqlite` path under the Harness home. The file is a rebuildable read model with one process owner. Session JSONL remains the only durable source of incident truth, and schema-version resets may discard and reconstruct the index.

List calls scan a configured maximum number of newest workspace Sessions and return a configured maximum number of records. Search keeps the Session Query Provider's one-best-event-per-Session result contract. The package does not add incident aggregation, embeddings, runbook retrieval, causal inference, or remediation.

## Alternatives considered

- **Create an AIOps-specific SQLite Service and Provider** — rejected because it would duplicate Session discovery, revision reconciliation, database ownership, FTS query safety, and lifecycle handling already owned by the Session Query seam.
- **Use tool-call and tool-result text as the incident index** — rejected because those messages are model artifacts rather than the canonical domain event and may omit or duplicate incident state.
- **Make the index authoritative** — rejected because dual writes would require transactional coordination with append-only Session persistence and complicate crash recovery.
- **Mount the generic session-history tools only** — rejected because they expose a broader history surface and require the model to reconstruct incident-specific filtering and decoding on every call.

## Consequences

An AIOps profile can discover prior incident records after restart, cite exact Session events, and delete or rebuild its SQLite file without losing incident state. Workspace equality prevents incidental cross-project reads, but it is not an organization or tenant authorization model. List scans and search grouping are deliberately bounded; analytics, global access, RAG, and automated action require separate capabilities and evaluation.
