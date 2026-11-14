# DSH AIOps TODO

Snapshot: 2026-11-14, after the DSH 0.2.2-rc.1 upgrade, aiops-delivery, alert-recovery linkage, the container image, the plugin-owned incident store migration, and the real-environment k3s + Alertmanager E2E regression.

## Now

- [ ] **aiops-delivery real-IM smoke test.** Implementation is complete (see CHANGELOG 2026-11-08); remaining: one manual end-to-end push against a real Feishu/钉钉/Slack webhook in a disposable profile or the container image, including token rotation without restart.

## Next

- [ ] **Route-event ignorable marker (blocked upstream).** `aiops/alert-routed` events are appended through the `session.append` cast, which drops `{ignorable: true}` on real sessions, so they replay into model context on resume. Porting them to the `plugin:` grammar is not available to an external plugin: `appendPluginRecord` rejects cross-realm receivers (see the incident store decision). Treat these events as part of the diagnostic narrative and revisit only if DSH exposes a public ignorable append or a portable plugin-record writer.
- [ ] **External-cluster deployment doc.** Bilingual guide: external kubeconfig credential options (kubeconfig path vs exec-credential), strict read-only RBAC manifest aligned to the exact tool surface, `kubectl auth can-i --list` verification checklist.

## Done (this snapshot)

- [x] **Real-environment E2E regression.** k3s + Alertmanager fixture E2E against DSH 0.2.2-rc.1 passed the receiver, lifecycle, retry, burst, Session, evidence, and report matrix after the storage migration; it caught the cross-realm `appendPluginRecord` failure that motivated the plugin-owned store.
- [x] **插件自有事件存储迁移.** Incident reports and operator feedback moved from Session plugin records to the `aiops_incident` storage domain; delivery markers moved to `aiops_delivery`; Portal snapshot v3, history tools, delivery, reuse, and router recovery closure all read/write the store. See [the decision record](docs/decisions/2026-11-14-aiops-plugin-owned-incident-store.md).
- [x] **aiops-delivery — 诊断结论推送.** IM webhook push with durable `aiops_delivery` markers, severity gate, per-attempt credential re-resolution.
- [x] **告警恢复联动.** After a recovery turn settles, the router reports the carried-forward `resolved` incident state through the incident store with `alert-recovery-*` evidence; idempotent, same lifecycle validation as model reports, recovery prompt defers closure to the router.
- [x] **Container image.** Multi-stage `Dockerfile` + entrypoint: build-time profile seed (offline first boot), `DSH_HOME` volume, proxy/trusted-host env support; documented in the bilingual deployment guide.
- [x] **诊断复用.** Firing alerts opening a new round get bounded workspace-store reads (`listResolved`) that attach the latest matching resolved incident's hypotheses/recommendations as lead-only context; an absent store or failed read skips reuse silently, and no writes occur.

## Deferred (explicitly)

- [ ] **变更部署关联证据** — deferred by product decision; revisit after delivery + resolution linkage.

## Notes

- Old 0.1.x sessions with non-ignorable `aiops/*` event types refuse to load under 0.2.x — no migration path; fresh sessions only.
- Structured incident and delivery state now lives in `<DSH_HOME>/storages/` (`aiops_incident`, `aiops_delivery`); back it up with the Session workspace and SQLite.
- Never commit a real `AIOPS_ALERTMANAGER_WEBHOOK_SECRET`, kubeconfig, bearer token, IM webhook URL, or other credential.
