# Stage E: append-only feedback and durable alert-storm control

English | [中文](2026-09-06-operator-feedback-storm-control.zh.md)

Status: accepted

## Decision

An operator confirmation, correction, or rejection is a separate `aiops/operator-feedback` Session event. It cites the reviewed report's `incidentId` and `reportSeq` without rewriting or deleting `aiops/incident-state`. The Agent may invoke the feedback tool only after an explicit verdict from the current user; alert resolution, model confidence, and later observations are never inferred as feedback.

Before creating an Agent, the router persists each policy-eligible alert in SQLite and applies these controls:

- ready items sharing `(source, fingerprint, lifecycle status)` form one model turn;
- fingerprint cooldown survives process restart;
- critical work is preferred and equal severity remains receipt-time FIFO;
- global/per-severity concurrency and global/per-severity in-flight output-token reservations all apply;
- queue size, maximum wait, and failed-dispatch attempts are bounded;
- startup recovers abandoned `processing` work to `queued`.

Filtered, grouped, deferred, dropped, started, completed, and failed transitions are written to `route_audit`. The router database owns coordination and audit only. Accepted alerts, model messages, tool results, incident reports, and feedback remain diagnostic truth in Session JSONL. Workspace history exposes feedback and route audit read-only with exact `cwd` scoping.

## Rationale

Changing an existing report would erase the diagnosis as originally made and blur model conclusions with human review. In-memory-only throttling would duplicate Agent starts or lose queued work after restart. Persisting admission before model work, and reserving token capacity instead of estimating spend afterward, gives deterministic bounds and replayable tests without requiring a Provider billing API.

## Consequences

- `modelBudgets` is the per-turn maximum output; `stormControl.*ReservedTokens` is an in-flight reservation cap, not an actual bill.
- A full or expired queue may explicitly drop work, but it must retain a reason available through history.
- Same-fingerprint grouping reduces duplicate model turns, while every delivery still receives its own route event and report context.
- This stage sends no notification, performs no remediation, and does not use feedback for online self-training.

## Rejected alternatives

- **Rewrite the latest report with feedback:** destroys the report audit chain.
- **Rely only on Alertmanager group interval:** does not cover multiple sources, process restart, or model resource contention.
- **Use only a global concurrency count:** cannot prevent low-value or large-token turns from crowding out critical work.
- **Make router SQLite the incident database:** creates dual-write consistency with Session truth.
