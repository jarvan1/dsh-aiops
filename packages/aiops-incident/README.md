---
description: "Durable whole-state AIOps incident reports for recording evidence, hypotheses, status, and human-reviewed recommendations in a Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-incident

English | [中文](README.zh.md)

## Summary

This package records a structured incident report per Agent Session and appends operator confirmations, corrections, or rejections as separate feedback. The model writes complete current reports through `aiops_incident_report`; every accepted write becomes an `aiops/incident-state` event. Only after an explicit user verdict may `aiops_incident_feedback` append `aiops/operator-feedback`, citing the reviewed report sequence without rewriting it. The `aiopsIncident` and `aiopsIncidentFeedback` projections expose the latest report and feedback.

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

Mount it with Session persistence, projection, and tool services.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-aiops-incident'
```

The registered tool schemas exhaustively define complete reports and append-only feedback. A `corrected` verdict requires `correction`; other verdicts reject it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The model/tool JSON boundary trims and bounds text; brands incident, evidence, and feedback IDs; accepts explicit alert/metric/Kubernetes/log/change origins; rejects duplicate evidence; and verifies every hypothesis reference. Report and feedback writes checkpoint persistence before and after append. Feedback IDs derive deterministically from the Session and tool-call identity, so replay does not append duplicates. Each feedback cites the exact `reportSeq`, so later report updates do not change what was reviewed. When `ctx.sessionQuery` is present, the package registers separate revisioned semantic extraction for reports and feedback.

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Durable event, domain records, and projection type maps |
| [`src/domain.ts`](src/domain.ts) | Strict decoding and lifecycle validation |
| [`src/feedback.ts`](src/feedback.ts) | Strict append-only operator-feedback decoder and projection schema |
| [`src/index.ts`](src/index.ts) | Report/feedback projections, persistence checkpoints, semantic text, and model-facing tools |
| — | No invariant companion is published because the complete event is decoded by the only projection and the write path checks lifecycle continuity before append |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [AIOps subsystem](../../docs/aiops.md) — domain flow and read-only boundary.
- [DSH Session projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.md) — current-state replay semantics.
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
- **No independent incident database** — persistence uses the existing Session log and projection stack; [`dsh-tool-aiops-history`](../tool-aiops-history/README.md) queries a disposable derived index without replacing that source of truth.
