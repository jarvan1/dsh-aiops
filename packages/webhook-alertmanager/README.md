# @deepseek-ai/dsh-webhook-alertmanager

English | [中文](README.zh.md)

Authenticated Alertmanager v4 HTTP ingress for DSH AIOps. The adapter registers one exact route, accepts only `POST application/json`, resolves a bearer secret through `ctx.credentials`, reads a bounded UTF-8 body, validates and normalizes the alert batch, and dispatches `VerifiedWebhookDelivery<'alertmanager'>` to `ctx.webhookRuntime`.

## Configuration

| Key | Meaning |
|---|---|
| `source` | Adapter identity matched by the incident router. |
| `path` | Exact non-root HTTP path. |
| `secretEnv` | Credential reference used as `Authorization: Bearer <secret>`. |
| `maxBodyBytes` | Raw request body ceiling. |
| `maxAlerts` | Maximum alerts in one group. |
| `maxMapEntries` | Maximum entries in each labels or annotations object. |
| `maxTextChars` | Maximum characters in each provider string. |

The optional `X-DSH-Delivery-ID` header must use a bounded log-safe grammar. Without it, the adapter uses the authenticated body SHA-256, so an exact sender retry keeps the same delivery identity. A provider fingerprint must be 16–64 hexadecimal characters; when absent, sorted labels produce a stable SHA-256-derived fingerprint.

Responses are `202` after in-memory dispatch, `400` for invalid headers or payloads, `401` for invalid bearer credentials, `405` for other methods, `413` for excessive bodies, `415` for other media types, and `503` when credentials or the runtime are unavailable. Responses and diagnostics never include the secret or payload.
