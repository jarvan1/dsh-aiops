# Move AIOps incident state into plugin-owned storage domains

English | [中文](2026-11-14-aiops-plugin-owned-incident-store.zh.md)

- **Status:** Accepted
- **Date:** 2026-11-14
- **Context:** DSH 0.2.2-rc.1

## Context

Until this change, the model-facing `aiops_incident_report` tool persisted each report as a Session plugin record (`plugin:aiops/incident-state`) through `appendPluginRecord`, and operator feedback as `plugin:aiops/operator-feedback`. Session projections replayed those events into the `aiopsIncident` / `aiopsIncidentFeedback` current state, and the Portal, history tools, delivery, and prior-diagnosis reuse read the projections or the raw events.

A real-environment E2E regression against DSH 0.2.2-rc.1 exposed that all twelve report calls in the fixture failed. Eleven failed with `Receiver must be an instance of class Session`: `appendPluginRecord` forwards to `session.#appendRecord`, a class-private method whose brand check rejects a receiver created by a different copy of `dsh-session`. The Host (`npx` tree) and the plugin (workspace `pnpm` store) legitimately load separate module instances, so the call can never succeed for an externally deployed plugin. The remaining failure was the correct rejection of a first report that already claimed `resolved`.

The official plugin-development practices state the same boundary: `appendPluginRecord` "is reserved for DSH's experimental packages", the public `session.append()` cannot set `ignorable: true`, and plugins should "derive state from existing events, or keep plugin-owned data in a storage service found through inspection". Shipping a plugin that depends on the private brand would work only when a deployment happens to deduplicate `dsh-session` into one module instance — an accident, not a contract.

## Decision

External AIOps state moves to plugin-owned storage domains mounted on the Host's storage stack:

- `aiops_incident` (`per-record` JSON layout): one document per Session holding the latest complete incident report with a monotonic `revision`, plus an append-only feedback table. The `ctx.aiopsIncidents` service validates lifecycle continuity, resolves only after durability, and emits `aiopsIncidents/changed`.
- `aiops_delivery` (`per-record` JSON layout): the latest terminal delivery decision per Session, replacing the previous `plugin:aiops/delivery` Session record.

Both domains declare zod schemas on their tables, so every record is validated at the durable boundary and an unreadable record is backed up and skipped (`invalidRecords: 'backup-and-skip'`) instead of blocking startup. The Session log keeps the full diagnostic narrative — routed alerts, observations, model messages, tool calls — and no longer carries structured incident state.

Consumers change accordingly:

- The Portal reads the store synchronously and joins the latest feedback against the incident `revision`; the snapshot version is now 3.
- `dsh-tool-aiops-history` reads the store, scopes reads to the caller workspace, and cites `(sessionId, revision)`.
- `aiops-delivery` subscribes to `aiopsIncidents/changed` and persists markers in `aiops_delivery`.
- Prior-diagnosis reuse scans `listResolved(workspace, maxScanRecords)` instead of Session history.
- The router's deterministic recovery closure reports through the same store and lifecycle validation.

## Alternatives considered

- **Bundle our own copy of `dsh-session` / keep `appendPluginRecord`.** Fails the private brand check whenever the Host loads its own copy, which is the default for `npx` and container deployments. Not portable.
- **Append non-ignorable events through `session.append`.** Works today but replays into model context on resume, changes the Session schema contract, and cannot express the plugin-owned marker semantics.
- **A SQLite database under `DSH_HOME`.** Durable and queryable, but duplicates a storage layer DSH already ships, bypasses the Host's schema/backup semantics, and adds a second migration surface.
- **Keep Session projections as the read model over derived events.** Impossible: there is no durable event to project once the private write path is gone.

## Consequences

Positive:

- The incident path works regardless of how the Host and plugin dependency trees resolve; the E2E writes durable incident documents under `<DSH_HOME>/storages/aiops_incident/`.
- Structured state is schema-validated on load and write, with an explicit backup-and-skip recovery for drift.
- Delivery markers survive restart by construction; the previous Session-record marker did too, but only through the same private path.
- Consumers share one synchronous, workspace-scoped read API instead of replaying events or querying SQLite.

Negative / accepted costs:

- Deployments must back up `<DSH_HOME>/storages/` alongside the Session workspace and SQLite; documented in the deployment guide.
- Incident state and the Session narrative are no longer co-located, so an audit that needs both must correlate on the Session id.
- The store is a single-writer domain: writes queue on the domain's write chain, and a report's revision is assigned there rather than by event ordering.

## Verification

The migration was validated by: the workspace suite (25 test files, 179 tests, one opt-in real-cluster test skipped) with new store tests over a real storage composition (report/revision, transition validation, durability across reopen, workspace scoping, feedback idempotence and stale-revision rejection); real Loader compositions for the incident and history packages; and a k3s + Alertmanager E2E against DSH 0.2.2-rc.1 that produced durable incident documents, a resolved lifecycle closure, and workspace-scoped Portal reads.
