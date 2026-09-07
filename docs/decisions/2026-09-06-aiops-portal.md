# Decision: ship the first Portal as a native read-only DSH Web view

Date: 2026-09-06
Status: Accepted

## Decision

Add a separate `@deepseek-ai/dsh-aiops-portal` package with Host and Web-client faces. The client registers both a persistent `sidebar.footer.action` and the existing `conversation.view`; the Host registers a fixed same-origin `/api/aiops/portal` endpoint on the application's existing `webServer`. The global workspace includes live Prometheus and Alertmanager URL settings backed by DSH's settings document.

The endpoint reads only Sessions matching `ctx.aiopsIncidentRouter.workspacePath` and accepts no client-supplied workspace. It performs bounded Session, event, and routing-audit scans, combining the latest complete report per Session, the newest feedback that exactly references that report sequence, and the latest route record for that Session. The Portal adds no persistence and mutates no event.

## Rationale

- Preserve Session events and router SQLite as the existing sources of truth.
- Reuse DSH slots, theme, locale, and module loading so the surface follows plugin installation and removal.
- Fix scope on the server to prevent browser parameters from widening workspace access.
- Keep the first version read-only and inside the existing diagnosis-without-remediation boundary.

## Consequences

The first version provides an always-available sidebar entry, summary metrics, client-side search and filters, master/detail incident inspection, operator-feedback display, a routing-audit table, 30-second refresh, and persistent live endpoint settings. DSH Web is the only client target for now; Electron IPC, feedback submission in the Portal, approved remediation, cross-workspace overview, and RAG are deferred.
