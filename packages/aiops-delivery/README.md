# @deepseek-ai/dsh-aiops-delivery

Push completed AIOps diagnoses to an IM incoming webhook so on-call operators see the diagnosis without opening the Portal.

## How it works

- Subscribes to the `aiopsIncident` projection change feed from `@deepseek-ai/dsh-aiops-incident`.
- On each committed incident report, renders one message for the configured provider and POSTs it to the IM webhook with a bounded body, deadline, and response cap.
- Records one append-only `plugin:aiops/delivery` marker (`delivered` or `failed`) in the diagnostic Session, so restarts and replays never double-push, and later severity escalation can retry after a failed burst.
- Never mutates infrastructure: the push is informational and the Session log stays the diagnostic truth.

## Providers

| Provider | Payload |
|---|---|
| `feishu` | `msg_type: interactive` card with severity-colored header, `lark_md` facts, and an optional Portal button |
| `dingtalk` | `msgtype: markdown` with the same fact lines and Portal link |
| `slack` | Incoming-webhook `{ text }` message with mrkdwn formatting |

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` | `feishu` | Target IM family |
| `webhookUrlEnv` | — | Credential-reference name (environment variable) holding the https webhook URL; the URL never enters the patch or settings store |
| `minSeverity` | `warning` | Lowest severity that is pushed |
| `portalBaseUrl` | — | Absolute Portal base URL rendered as the deep link |
| `timeoutMs` | `10000` | Per-request deadline |
| `maxAttempts` | `2` | Delivery attempts per report (1..5) |
| `retryBackoffMs` | `2000` | Fixed backoff between attempts |
| `maxResponseBytes` | `65536` | Maximum complete response body size |

Delivery decisions per incident report, in order: skip when a `delivered` marker already exists; skip while the report severity is below `minSeverity` (a later escalation re-evaluates); skip with one warning when the credential is missing or the URL is not a clean https URL; otherwise attempt the bounded burst and write a terminal marker.

## Testing

```sh
pnpm exec vitest run packages/aiops-delivery
```
