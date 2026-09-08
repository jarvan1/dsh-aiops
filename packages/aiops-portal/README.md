# @deepseek-ai/dsh-aiops-portal

English | [中文](README.zh.md)

An AIOps workspace for DSH Web. It registers a persistent `AIOps` sidebar action plus the existing Session conversation view, and reads a fixed same-origin endpoint, `/api/aiops/portal`, which aggregates the latest diagnosis report, matching operator feedback, routing audit, current routing policy, and policy-change audit for the workspace configured on the incident router.

The Portal stores no copies, mutates no Session, and exposes no remediation action. Session events remain the diagnosis source of truth and router SQLite remains the routing-audit source of truth. The endpoint scans at most `maxScanSessions` sessions and returns up to `maxIncidents` recent incidents plus `maxAuditRecords` audit records; defaults are 500, 100, and 250 respectively.

The global workspace includes live settings for the `aiops-prometheus`, `aiops-alertmanager`, `aiops-kubernetes`, and versioned `aiops-routing` namespaces. Data-source candidates must pass server-side identity/read-permission checks. Routing policy is saved atomically with a settings revision fence only after a side-effect-free normalized-label dry-run; cross-field concurrency and token limits are validated by the router before persistence. Committed changes apply live and are durably audited.

The settings view displays the configured Alertmanager webhook URL and only whether its credential exists. The credential value is never returned to or stored in the browser; rotate it through the deployment secret manager or `<DSH_HOME>/.credentials.yaml` and restart DSH. Set `AIOPS_WEBHOOK_PUBLIC_URL` when Alertmanager must use an address other than the default `http://127.0.0.1:3081/alertmanager`. Browser POSTs for connection tests and dry-run reject cross-site requests; the entire Web surface still belongs behind the deployment's authenticated Host boundary.

The client module currently targets DSH Web. It registers the endpoint when `webServer` is available, so Host-free headless compositions remain valid; the isolated Alertmanager webhook listener does not serve this endpoint.

See the [routing-policy JSON examples](../../docs/examples/README.md) for copyable field templates, and [production deployment and upgrade](../../docs/deployment.md) for TLS, credential rotation, migration, and release verification.
