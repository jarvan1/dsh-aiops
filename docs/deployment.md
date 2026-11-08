# Production deployment and upgrade

English | [中文](deployment.zh.md)

## Trust boundary

DSH AIOps is a read-only diagnostic plugin, not an Internet-facing authentication gateway. Keep the main DSH Web surface and its `/api/aiops/*` routes behind the deployment's authenticated Host boundary. Bind the dedicated Alertmanager receiver only to a protected interface and allow traffic solely from Alertmanager or its reverse proxy.

The Portal never returns the webhook bearer value. It exposes only the public receiver URL and a boolean credential status. Connection-test and routing dry-run POSTs reject cross-site browser requests by `Sec-Fetch-Site` and same-host `Origin`; durable settings writes continue through DSH's revision-fenced Settings API. A reverse proxy must replace, not append untrusted, `X-Forwarded-Host` values.

## TLS reverse proxy

Terminate TLS and authentication at an owned reverse proxy. A minimal NGINX shape is:

```nginx
server {
  listen 443 ssl http2;
  server_name dsh.example.com;

  # Configure ssl_certificate, ssl_certificate_key, modern protocols, and
  # organization authentication here.
  location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:3080;
  }

  location = /alertmanager {
    # Restrict to Alertmanager network identities as well as bearer auth.
    allow 10.0.0.0/8;
    deny all;
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:3081;
  }
}
```

Scrape `/api/aiops/metrics`; use `/api/aiops/healthz` for liveness and `/api/aiops/readyz` for traffic readiness. Do not expose metrics publicly.

## Credential rotation

Store `AIOPS_ALERTMANAGER_WEBHOOK_SECRET` in `<DSH_HOME>/.credentials.yaml` with mode `0600`, never in a patch, URL, browser, log, or repository. Rotation is an explicit administrator workflow:

1. Generate a long random replacement and update the Kubernetes Secret or Alertmanager secret store.
2. Atomically update the DSH credential reference value.
3. Restart or rolling-restart DSH so the credential provider reloads it.
4. Send one authenticated canary delivery and verify the accepted webhook metric and route audit.
5. Confirm the old value receives `401`, then remove it from the originating secret manager.

This release intentionally has no Portal reveal or credential-write endpoint, so there is no plaintext reveal event to authorize, audit, or protect with CSRF controls.

## Diagnosis delivery

`aiops-delivery` pushes completed diagnoses to one IM incoming webhook (Feishu, DingTalk, or Slack). Store the https webhook URL as the `AIOPS_DELIVERY_WEBHOOK_URL` credential-reference value in `<DSH_HOME>/.credentials.yaml` with mode `0600` or in an external secret manager — never in the patch, the settings store, or the repository. The provider (`provider`), severity gate (`minSeverity`), Portal deep link (`portalBaseUrl`), and bounded deadline/retry limits are entry settings that the Web settings UI projects; committing an edit reloads the entry. The credential value is re-resolved for every delivery, so rotating the IM webhook token needs no restart: update the reference value and send one canary incident.

To verify, route one canary alert and confirm the message lands in the target IM thread and a `plugin:aiops/delivery` record with outcome `delivered` appears in the Session log.

## Local development run

Run the bundle in a disposable DSH Web profile before touching a shared environment:

```sh
pnpm install
pnpm run build:github

# Install from the local checkout into an isolated profile home.
DSH_HOME=~/.dsh-aiops-dev \
  npx -y @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add link:"$PWD/packages/aiops"
```

The link install loads the built `lib/` artifacts, so rebuild and restart DSH after every code change. If pnpm blocks the Git dependency's `prepare` script, copy the exact printed `allowBuilds` key into the profile's `pnpm-workspace.yaml` and rerun the add command.

Provision the credentials in `<DSH_HOME>/.credentials.yaml` with mode `0600`:

```yaml
AIOPS_ALERTMANAGER_WEBHOOK_SECRET: '<long-random-value>'   # bearer for the webhook receiver
AIOPS_DELIVERY_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/<token>'  # IM bot URL
```

Create the Feishu custom bot under group settings → Group bot → Custom bot and copy its webhook URL; DingTalk and Slack bots provide the same shape of URL. Set `provider`, `minSeverity`, and `portalBaseUrl` in the AIOps settings UI (a committed edit reloads the entry), and optionally set `AIOPS_PORTAL_PUBLIC_URL` so delivered cards carry a working Portal button.

Start the Web profile, then check `/api/aiops/healthz`, `/api/aiops/readyz`, and open the sidebar AIOps Portal. The webhook receiver listens on `127.0.0.1:3081/alertmanager` by default; a canary does not need a real Alertmanager:

```sh
curl -s -X POST http://127.0.0.1:3081/alertmanager \
  -H "Authorization: Bearer $AIOPS_ALERTMANAGER_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"version":"4","alerts":[{"status":"firing","startsAt":"2026-11-08T10:00:00Z","labels":{"alertname":"HighLatency","severity":"critical","service":"checkout"},"annotations":{"description":"p99 latency above 4s"}}]}'
```

The canary exercises the full loop: authenticated ingress → router round → deterministic diagnostic Session (the model must be configured in the profile) → `aiops_incident_report` → delivery push → IM thread message plus a `plugin:aiops/delivery` `delivered` record. Diagnosis quality depends on Prometheus/Alertmanager/Kubernetes connectivity, but the delivery smoke test only needs the model to produce an incident report. Switch providers by editing `provider` in settings; rotate the IM webhook token by updating the credential value — delivery re-resolves it per attempt without a restart.

## Upgrade and configuration migration

Back up the DSH settings document, Session workspace, `aiops-router.sqlite`, and credential file before upgrading. The router schema accepts the pre-F.2 `alertnameAllowlist` field so an old profile still starts, logs a deprecation warning, and adopts safe general-routing defaults: ignore `Watchdog` and `InfoInhibitor`, and map missing/unknown severity to `warning`. Replace the old field with explicit `routingPolicy` immediately; the old allowlist is not interpreted as an exclusion list.

Routing settings are stored as `aiops-routing` version 1. Portal writes are revision-fenced, atomically update the complete policy, require a successful dry-run, and are recorded in `routing_policy_audit`. Invalid cross-field concurrency or token budgets are rejected before persistence.

Copyable field values and dry-run labels are available in the [routing-policy JSON examples](examples/README.md).

For a clean install or upgrade:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm exec vitest run
pnpm run build:github
node scripts/check-links.mjs
pnpm --filter @deepseek-ai/dsh-aiops pack
```

Install the resulting bundle into a disposable DSH profile first, inspect `config dump`, start it with disposable credentials, verify health/readiness/metrics and a canary webhook, then remove it. For an upgrade, repeat with a copy of the old profile and confirm Session history, routing queue recovery, settings, and Portal access before production rollout. Uninstall removes plugin registration but does not silently delete DSH home, Session JSONL, SQLite, settings, or credentials; archive or delete those explicitly under the deployment's retention policy.

Supported runtime versions are Node `^22.19.0 || >=24.0.0`, pnpm `11.7.0`, Cordis `^4.1.0`, and DSH `0.2.2-rc.1` package APIs. Treat a DSH package-version change as an upgrade requiring the same disposable-profile matrix.
