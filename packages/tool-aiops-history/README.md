---
description: "Workspace-scoped read-only tools for durable AIOps reports, operator feedback, and routing audit."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-aiops-history

English | [中文](README.zh.md)

## Summary

This package lets an agent list, read, and search durable `aiops/incident-state` records in its workspace, list or search append-only `aiops/operator-feedback`, and read storm-control audit from the router serving the same workspace. Session results cite exact Session ids and event sequences, and exact reads decode authoritative events instead of trusting index content. Full-text search uses the disposable `ctx.sessionQuery` SQLite index; route audit comes from the router coordination database. The tools never write state or change infrastructure.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package over an enabled `ctx.sessionQuery` service when the model needs incident history from the caller's workspace.

### When to choose it

Choose it for cross-Session incident review without adding another authoritative database. Avoid it when callers need organization-wide access control, analytics aggregation, or remediation; this Consumer enforces exact `cwd` equality and exposes read-only event records only.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/aiops-incidents.sqlite
    openAt: startup
- name: '@deepseek-ai/dsh-tool-aiops-history'
```

| Field | Default | Meaning |
|---|---|---|
| `defaultLimit` | `20` | Result count when a tool call omits `limit` |
| `maxLimit` | `100` | Largest accepted result count |
| `maxScanSessions` | `500` | Largest workspace Session set inspected by one list call |
| `timeoutMs` | `30000` | Cooperative deadline for each history operation |

The table above is the exhaustive list of accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Consumer derives caller identity and workspace from the owning Agent Session. Report and feedback listing filters the logical Session corpus before reading matching events; search requests only the corresponding event type; exact reads re-read cited append-only events and validate payloads. The routing-audit tool registers only while the router Service exists and requires exact caller `cwd` equality with its `workspacePath`. A caller without a workspace can access only its own Session.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration, authorization, query operations, JSON rendering, and five tool registrations |
| — | No invariant companion is published because authorization and event identity are checked inside every operation that returns incident data |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps incident state](../aiops-incident/README.md) — authoritative event and write validation.
- [DSH Session Query](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query/README.md) — exact-read and filtering Service Definition.
- [DSH SQLite Session Query](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query-sqlite/README.md) — disposable FTS5 Provider and rebuild behavior.
- [AIOps subsystem](../../docs/aiops.md) — complete investigation and history flow.
- [Incident history decision](../../docs/decisions/2026-09-05-aiops-cross-session-incident-history.md) — ownership and rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

### Incident history schemas and results

#### What the model sees

The model sees `aiops_incident_list`, `aiops_incident_get`, `aiops_incident_search`, and `aiops_feedback_list`; it also sees `aiops_routing_audit` while the router is available. Results are bounded JSON. Report and feedback records cite Session id, event sequence, and time; route records include delivery, fingerprint, reason, queue depth, token reservation, and transition time.

#### Token effect

Four fixed schemas, one conditional schema, and guidance add a request prefix while visible. Tool results add only records selected by configured and per-call bounds.

#### KV Cache effect

The guidance and schemas remain stable until registration or configuration changes. Query results append after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Workspace equality only** — authorization compares exact Session `cwd`; organization, tenant, and role policies need a separate access capability.
- **One search hit per Session** — SQLite cross-Session search groups by Session and returns its strongest matching incident event; use exact reads for cited records.
- **Bounded list scan** — listing inspects at most `maxScanSessions` newest workspace Sessions and returns no continuation cursor.
- **No metric aggregation or RAG** — the tools expose stored events and audit without computing precision/suppression rates, embeddings, runbook retrieval, or causal inference.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
