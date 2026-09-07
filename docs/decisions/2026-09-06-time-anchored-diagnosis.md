# Time-anchored diagnosis and packaged Kubernetes skill

Status: accepted, 2026-09-06

## Context

An Alertmanager notification contains `startsAt`, but Stage C exposed it only as one field inside the normalized alert. An Agent could therefore choose a relative "last 15 minutes" query at execution time. Delayed delivery, restart, or replay would then inspect different evidence for the same alert occurrence. A repository-local skill also disappears when `AIOPS_WORKSPACE` points at an operator-selected directory.

## Decision

- `dsh-aiops-incident-router` writes `aiops/alert-routed` v2 with a canonical T0 derived from `alert.startsAt` and a bounded, explicit observation window.
- The window begins at T0 minus the configured lookback. It ends at delivery receipt, clamped between T0 and the configured post-alert horizon. This avoids future queries and prevents delayed notifications from widening without bound.
- The event includes tool-shaped parameters for Prometheus range queries, Kubernetes Events, and Pod logs. The identical object is present in the model-visible follow-up and survives Session replay.
- Kubernetes Event reads accept inclusive absolute bounds and retain Events whose occurrence intervals overlap the window. Pod-log reads accept an absolute lower bound; an upper bound forces timestamps and removes later or undated lines locally because Kubernetes exposes no server-side log end time.
- `k8s-diag` is a versioned `SKILL.md` packaged in `@deepseek-ai/dsh-aiops-skill-k8s-diag`. Its plugin registers the instructions in the global DSH skill layer, so they remain available when the diagnostic Workspace changes.
- The skill permits read-only evidence collection only, requires evidence-linked hypotheses and a complete `aiops_incident_report`, and covers the initial high-signal alert scenarios.

## Consequences

The same delivery now reconstructs the same diagnosis time parameters after restart or keyless replay. Operators can tune one router policy rather than relying on prompt interpretation. Event and log upper-bound filtering happens after a bounded kubectl response, and undated log lines are excluded when an upper bound is requested. The bundle gains one package and depends on the host skill registry already provided by DSH.

The observation window describes evidence available when the delivery was received. A later firing delivery extends its own end within the configured horizon; it does not rewrite earlier Session facts. Historical Event retention and Pod-log rotation can still make evidence unavailable, which the report must state explicitly.
