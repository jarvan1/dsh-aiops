---
description: "Durable whole-state AIOps incident reports for recording evidence, hypotheses, status, and human-reviewed recommendations in a Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-incident

English | [中文](README.zh.md)

## Summary

This package records a structured incident report per Agent Session and appends operator confirmations, corrections, or rejections as separate feedback. The model writes complete current reports through `aiops_incident_report`; every accepted write becomes one durable record in the plugin-owned `aiops_incident` storage domain (one JSON document per Session, monotonic `revision`). Only after an explicit user verdict may `aiops_incident_feedback` append feedback, citing the reviewed `reportRevision` without rewriting the report. The `ctx.aiopsIncidents` service exposes the latest report and feedback synchronously, emits `aiopsIncidents/changed` after each durable write, and never depends on Session plugin records — DSH reserves those for Host-built packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it with the storage stack (`dsh-storage` + a backend such as `dsh-storage-json` + `dsh-storage-domain`) and the tool service.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-incident'
```

The incident store opens the `aiops_incident` domain through `ctx.storageDomain`; DSH's base profile already mounts the storage hub, the JSON backend at `<DSH_HOME>/storages`, and the domain form.

The registered tool schemas exhaustively define complete reports and append-only feedback. A `corrected` verdict requires `correction`; other verdicts reject it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The model/tool JSON boundary trims and bounds text; brands incident, evidence, and feedback IDs; accepts explicit alert/metric/Kubernetes/log/change origins; rejects duplicate evidence; and verifies every hypothesis reference. Reports validate the lifecycle transition against the stored record (first report cannot be `resolved`; the incident identity is stable; `resolved` is terminal) and the store resolves after the medium is durable. Feedback IDs derive deterministically from the Session and tool-call identity, so replay returns the stored record instead of appending a duplicate; feedback pinned to a superseded revision is rejected. Record keys that would not be path-safe over the per-record JSON layout are replaced by a SHA-256 digest.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Record types, domain state, and brand types |
| [`src/domain.ts`](src/domain.ts) | Strict decoding and lifecycle validation |
| [`src/feedback.ts`](src/feedback.ts) | Strict append-only operator-feedback decoder |
| [`src/store.ts`](src/store.ts) | `aiops_incident` storage-domain spec and the `ctx.aiopsIncidents` service |
| [`src/index.ts`](src/index.ts) | Store mounting, semantic search text, and model-facing tools |
| — | No invariant companion is published because the single store decodes every record at the durable boundary and the write path checks lifecycle continuity before commit |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — domain flow and read-only boundary.
- [DSH storage domain](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/storage/storage-domain/README.md) — schema-validated, change-emitting KV domains.
- [Observation tools](../tool-aiops-observe/README.md) — evidence acquisition.
- [AIOps foundation decision](../../docs/decisions/2026-09-04-dsh-aiops-read-only-foundation.md) — package and safety choices.

-----

<a id="dev-note"></a>
## Dev Note

None.

-----

<a id="model-experience"></a>
## Model Experience

### Incident report schema and result

#### What the model sees

The model sees `aiops_incident_report` and `aiops_incident_feedback`. The former requires a complete replacement report, stable identity, evidence-linked hypotheses, factual separation, and human-reviewed recommendations. The latter is only for an explicit confirmation, correction, or rejection by the current user.

#### Token effect

The two schemas add a fixed request prefix while the plugin is visible. Each call appends its canonical result to model history; the durable domain event itself adds no separate message.

#### KV Cache effect

The tool-schema prefix remains stable until registration changes. Reports append after the reusable prefix and do not replace earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One incident per Session** — a different incident requires a new Session; merge, parent/child incident linkage, and reopening are not represented.
- **Feedback does not rewrite fact** — feedback records an operator verdict on one report version; revising current incident state still requires another complete `aiops_incident_report` write.
- **No automated remediation** — recommendations are stored text and never authorize or execute infrastructure changes.
- **Storage layout is deployment-owned** — records live under `<DSH_HOME>/storages/aiops_incident/`; back that directory up with the Session workspace, and note a record that no longer matches the schema is moved aside and skipped at startup.
