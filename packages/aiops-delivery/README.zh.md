---
description: "把完成的 AIOps 诊断推送到 IM incoming webhook。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-delivery

[English](README.md) | 中文

把完成的 AIOps 诊断推送到 IM incoming webhook，让值班人员无需打开 Portal 即可看到诊断。

## 工作方式

- 订阅插件自有事件存储发出的 `aiopsIncidents/changed` 事件。
- 每次提交的事件报告都会按配置 Provider 渲染一条消息，并以有界请求体、截止时间与响应上限 POST 到 IM webhook。
- 每个 Session 在 `aiops_delivery` 存储域中持久化一条终态决策（`delivered`，或带截断原因的 `failed`），因此重启与重放不会重复推送，后续严重级别升级也能在失败爆发后重试。
- 从不修改基础设施：推送只承担信息通知职责，Session 日志仍是诊断叙事。

## Provider

| Provider | 载荷 |
|---|---|
| `feishu` | `msg_type: interactive` 卡片，带按严重级别着色的标题、`lark_md` 字段与可选 Portal 按钮 |
| `dingtalk` | `msgtype: markdown`，使用相同的字段行与 Portal 链接 |
| `slack` | Incoming-webhook `{ text }` 消息，使用 mrkdwn 格式 |

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `feishu` | 目标 IM 家族 |
| `webhookUrlEnv` | — | 保存 https webhook URL 的凭证引用名（环境变量）；URL 永不进入 patch 或设置存储 |
| `minSeverity` | `warning` | 会被推送的最低严重级别 |
| `portalBaseUrl` | — | 渲染为深链的 Portal 绝对基础 URL |
| `timeoutMs` | `10000` | 单次请求截止时间 |
| `maxAttempts` | `2` | 每份报告的投递尝试次数（1..5） |
| `retryBackoffMs` | `2000` | 尝试之间的固定退避 |
| `maxResponseBytes` | `65536` | 完整响应体的最大字节数 |

每份事件报告的投递决策顺序：已有 `delivered` 标记则跳过；报告严重级别低于 `minSeverity` 时跳过（后续升级会重新评估）；凭证缺失或 URL 不是干净的 https URL 时跳过并记录一条警告；否则执行有界重试爆发并写入终态标记。

## 测试

```sh
pnpm exec vitest run packages/aiops-delivery
```
