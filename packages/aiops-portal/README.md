# @deepseek-ai/dsh-aiops-portal

English | [中文](README.zh.md)

A read-only AIOps workspace for DSH Web. It registers a persistent `AIOps` sidebar action plus the existing Session conversation view, and reads a fixed same-origin endpoint, `/api/aiops/portal`, which aggregates the latest diagnosis report, matching operator feedback, and routing audit for the workspace configured on the incident router.

The Portal stores no copies, mutates no Session, and exposes no remediation action. Session events remain the diagnosis source of truth and router SQLite remains the routing-audit source of truth. The endpoint scans at most `maxScanSessions` sessions and returns up to `maxIncidents` recent incidents plus `maxAuditRecords` audit records; defaults are 500, 100, and 250 respectively.

The global workspace includes live settings for the `aiops-prometheus` and `aiops-alertmanager` namespaces. The Portal calls the Prometheus query API and Alertmanager v2 alerts API from the server and enables saving only after both candidate URLs pass; editing either URL invalidates its result. Saved URLs use DSH's settings provider, survive restarts, and immediately become authoritative over the environment-backed composition defaults. The client module currently targets DSH Web. It registers the endpoint when `webServer` is available, so Host-free headless compositions remain valid; the isolated Alertmanager webhook listener does not serve this endpoint.
