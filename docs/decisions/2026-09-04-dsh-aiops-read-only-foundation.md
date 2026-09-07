# Agent Note: Read-only DSH AIOps foundation

Status: implemented

English | [中文](2026-09-04-dsh-aiops-read-only-foundation.zh.md)

## Problem

An AIOps product needs several kinds of live operational evidence, a model-facing investigation workflow, and durable incident state. Putting every concern in one tool would couple endpoint transport, model schemas, persistence, and future UI work; starting with remediation would also grant mutation authority before observation quality and approval policy have evidence. The subsystem needs a useful closed loop that fits the plugin architecture and can evolve without changing `agent-loop`.

## Decision

The subsystem is read-only and has eight packages under `packages/aiops/`: `dsh-aiops-http-read` shares bounded GET acquisition without owning a capability; `dsh-aiops-alertmanager` supplies `ctx.alertmanager` with current alerts over HTTP API v2; `dsh-aiops-prometheus` supplies `ctx.prometheus` with instant/range PromQL over HTTP; `dsh-aiops-kubernetes` supplies `ctx.kubernetes` with object get/list, Events, and bounded non-streaming Pod logs through kubectl and `ctx.subprocess`; `dsh-tool-aiops-observe` owns seven model-facing observation tools; `dsh-aiops-incident` owns the complete-state event, projection, and reporting tool; `dsh-tool-aiops-history` owns three workspace-scoped incident-history tools; `dsh-aiops` is the installable profile patch.

The Alertmanager, Prometheus, and Kubernetes packages each combine their Service Definition and only current Provider. This is not a permanent coupling: the first second Provider, remote execution substrate, or independently versioned transport moves the implementation into a Provider package while preserving the abstract Service and Consumer schemas. Until then, splitting would add packages without an independently evolving role.

All acquisition tools are structurally read-only. The Alertmanager Provider issues only GET requests for current alerts; the Kubernetes Consumer exposes no raw command or unrestricted argument, and its Provider constructs only fixed get, list, Event, and bounded non-streaming log reads; Prometheus exposes only query endpoints. Deployment still owns endpoint ACLs, kubeconfig, and read-only RBAC.

Every accepted incident write carries the complete current `AiopsIncidentState` in `aiops/incident-state`. Stable branded incident and evidence IDs, evidence-reference checks, immutable incident identity, and terminal `resolved` state are validated before append; Session persistence is checkpointed before and after the write. The `aiopsIncident` projection decodes the durable event and uses the latest valid state.

The existing Session log and projection stack own persistence for the subsystem. No separate incident database is authoritative, and no RAG pipeline is included before a maintained runbook corpus, access rules, citations, freshness policy, and evaluations exist. The SQLite cross-Session index is a rebuildable read model over Session events, as specified by the [incident-history decision](2026-09-05-aiops-cross-session-incident-history.md).

## Alternatives considered

- **One monolithic AIOps plugin** — rejected because provider transport, model API, durable state, and composition already have distinct owners and tests.
- **Separate Service Definition and Provider packages immediately** — deferred until a second implementation makes their release cadence independent.
- **Start with aggregated logs, RAG, a portal, and remediation** — deferred because direct bounded Pod logs are sufficient for the current investigation loop, and remediation needs explicit approval and policy design.
- **Use a new incident database as the source of truth** — rejected for the first version because it would duplicate the Session event log and create a consistency problem before cross-session queries exist.

## Consequences

The profile can investigate current alerts, metrics, Kubernetes objects and Events, and bounded Pod logs; persist structured conclusions; resume and search them from the Session log; and add later Providers without changing observation tool names. It cannot query aggregated logs or change history, render a dedicated portal, aggregate incident analytics, or execute recommendations. Those additions must preserve the read-only acquisition boundary or introduce an explicit approval-governed action capability rather than extending the observation tools with mutations.
