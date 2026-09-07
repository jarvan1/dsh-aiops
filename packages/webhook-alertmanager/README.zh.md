# @deepseek-ai/dsh-webhook-alertmanager

[English](README.md) | 中文

面向 DSH AIOps 的认证 Alertmanager v4 HTTP 入口。Adapter 注册一个精确路由，只接受 `POST application/json`，通过 `ctx.credentials` 解析 Bearer 密钥，读取有界 UTF-8 请求体，校验并标准化告警批次，然后向 `ctx.webhookRuntime` 分发 `VerifiedWebhookDelivery<'alertmanager'>`。

## 配置

| 配置项 | 含义 |
|---|---|
| `source` | 与事件路由器匹配的 adapter 标识。 |
| `path` | 精确的非根 HTTP 路径。 |
| `secretEnv` | 用于 `Authorization: Bearer <secret>` 的凭据引用。 |
| `maxBodyBytes` | 原始请求体上限。 |
| `maxAlerts` | 一个分组中的最大告警数。 |
| `maxMapEntries` | 每个 labels 或 annotations 对象的最大条目数。 |
| `maxTextChars` | 每个 Provider 字符串的最大字符数。 |

可选的 `X-DSH-Delivery-ID` 请求头必须采用有界且适合日志记录的字符集。未提供时，Adapter 使用已认证请求体的 SHA-256，因此发送方对相同请求的重试保持同一个 delivery identity。Provider fingerprint 必须是 16–64 位十六进制字符串；缺失时由排序后的 labels 生成稳定的 SHA-256 派生 fingerprint。

内存分发成功后返回 `202`；无效请求头或载荷返回 `400`；Bearer 凭据无效返回 `401`；其他方法返回 `405`；请求体过大返回 `413`；其他媒体类型返回 `415`；凭据或 runtime 不可用返回 `503`。响应和诊断都不会包含密钥或载荷。
