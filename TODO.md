# DSH AIOps TODO

Snapshot: 2026-11-08, after the DSH 0.2.2-rc.1 upgrade, aiops-delivery, alert-recovery linkage, and the container image.

## Now

- [ ] **aiops-delivery real-IM smoke test.** Implementation is complete (see CHANGELOG 2026-11-08); remaining: one manual end-to-end push against a real Feishu/钉钉/Slack webhook in a disposable profile or the container image, including token rotation without restart.

## Next

- [ ] **诊断复用.** Before opening a new diagnostic session, search `aiops_incident_list`/`aiops_incident_search` for a recent similar incident (same alertname + fingerprint family) and attach its prior hypotheses/recommendations as starting context.
- [ ] **Route-event ignorable marker.** `aiops/alert-routed` events are appended through the `session.append` cast, which drops the `{ignorable: true}` option on real sessions — the current 0.2.2-rc.1 reader still replays them, but a stricter future reader may refuse. Migrate the event type to the `plugin:` grammar (`plugin:aiops/alert-routed` via `appendPluginRecord` + a `PluginRecordMap` declaration), updating portal snapshot reads, history tooling, and tests in one change.
- [ ] **Real-environment E2E regression.** Re-run the k3s + Alertmanager fixture E2E against the upgraded stack (0.2.x sessions, plugin records, native Kubernetes client), including one firing → resolved cycle to exercise the deterministic lifecycle closure in a real Session.
- [ ] **External-cluster deployment doc.** Bilingual guide: external kubeconfig credential options (kubeconfig path vs exec-credential), strict read-only RBAC manifest aligned to the exact tool surface, `kubectl auth can-i --list` verification checklist.

## Done (this snapshot)

- [x] **aiops-delivery — 诊断结论推送.** IM webhook push with durable `plugin:aiops/delivery` markers, severity gate, per-attempt credential re-resolution.
- [x] **告警恢复联动.** After a recovery turn settles, the router appends the carried-forward `resolved` incident state with `alert-recovery-*` evidence; idempotent, same lifecycle validation as model reports, recovery prompt defers closure to the router.
- [x] **Container image.** Multi-stage `Dockerfile` + entrypoint: build-time profile seed (offline first boot), `DSH_HOME` volume, proxy/trusted-host env support; documented in the bilingual deployment guide.

## Deferred (explicitly)

- [ ] **变更部署关联证据** — deferred by product decision; revisit after delivery + resolution linkage.

## Notes

- Old 0.1.x sessions with non-ignorable `aiops/*` event types refuse to load under 0.2.x — no migration path; fresh sessions only.
- Never commit a real `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`, kubeconfig, bearer token, IM webhook URL, or other credential.
