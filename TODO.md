# DSH AIOps TODO

Snapshot: 2026-11-08, after the DSH 0.2.2-rc.1 upgrade (0.2.0-rc.1).

## Now

- [ ] **Commit the pending work.** The DSH 0.2.2-rc.1 upgrade plus the new `aiops-delivery` package are verified green (`pnpm run build`, `pnpm exec vitest run` 172 passed / 1 skipped, `pnpm run build:github`) but still uncommitted on `main`.
- [ ] **aiops-delivery real-IM smoke test.** Implementation is complete (see CHANGELOG 2026-11-08); remaining: one manual end-to-end push against a real Feishu/钉钉/Slack webhook in a disposable profile, including token rotation without restart.
- [x] **aiops-delivery — 诊断结论推送（已完成实现）.** New `aiops-delivery` package: pushes each qualifying diagnosis report to an IM incoming webhook.
  - Providers: 飞书 (interactive card), 钉钉 (markdown), Slack (incoming webhook text).
  - Config (Loader entry, projected into the settings UI): `provider`, `webhookUrlEnv` (credential reference — the URL never enters the committed patch or settings store), `minSeverity` gate (default `warning`), `portalBaseUrl` deep-link prefix, `timeoutMs`, bounded `maxAttempts`/`retryBackoffMs`/`maxResponseBytes`.
  - Trigger: `sessionProjections.onChanged` on the `aiopsIncident` key, processed off the commit critical section with per-session in-flight coalescing.
  - Audit + idempotency: durable `plugin:aiops/delivery` marker (`delivered` | `failed`) per decision; delivered markers block re-push across restarts, failed bursts retry on later report updates, below-threshold reports re-evaluate on escalation.

## Next

- [ ] **告警恢复联动.** Alertmanager resolved notifications reconcile the incident lifecycle: append a resolved transition (or operator-feedback-style record) instead of leaving sessions `investigating` forever.
- [ ] **诊断复用.** Before opening a new diagnostic session, search `aiops_incident_list`/`aiops_incident_search` for a recent similar incident (same alertname + fingerprint family) and attach its prior hypotheses/recommendations as starting context.
- [ ] **Real-environment E2E regression.** Re-run the k3s + Alertmanager fixture E2E against the upgraded stack (0.2.x sessions, plugin records, native Kubernetes client).
- [ ] **External-cluster deployment doc.** Bilingual guide: external kubeconfig credential options (kubeconfig path vs exec-credential), strict read-only RBAC manifest aligned to the exact tool surface, `kubectl auth can-i --list` verification checklist.

## Deferred (explicitly)

- [ ] **变更部署关联证据** — deferred by product decision; revisit after delivery + resolution linkage.

## Notes

- Old 0.1.x sessions with non-ignorable `aiops/*` event types refuse to load under 0.2.x — no migration path; fresh sessions only.
- Never commit a real `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`, kubeconfig, bearer token, IM webhook URL, or other credential.
