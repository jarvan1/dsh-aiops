# @deepseek-ai/dsh-aiops-portal

[English](README.md) | 中文

DSH Web 中的只读 AIOps 工作台。它注册始终可见的侧边栏 `AIOps` 入口，同时保留 Session 内的会话视图标签，并通过应用 Web Server 上固定的同源接口 `/api/aiops/portal` 汇总当前 Router 配置工作区内的最新诊断报告、对应人工反馈和路由审计。

Portal 不保存副本、不修改 Session，也不提供修复操作。Session 事件仍是诊断真源，Router SQLite 仍是路由审计真源。接口最多扫描 `maxScanSessions` 个会话，返回 `maxIncidents` 个最新事件和 `maxAuditRecords` 条审计记录；默认分别为 500、100 和 250。

全局工作台提供 `aiops-prometheus` 和 `aiops-alertmanager` 两个 namespace 的实时设置。Portal 会在服务端分别调用 Prometheus query API 和 Alertmanager v2 alerts API；两个候选 URL 均测试成功后才允许保存，任一 URL 改动都会使对应测试结果失效。保存的 URL 使用 DSH settings provider 持久化，重启后仍然保留，并会立即覆盖环境变量提供的组合层默认值。

设置页还会显示已配置的 Alertmanager Webhook 地址。只有操作员点击**显示**时，Portal 才从 DSH credential provider 读取 secret；响应使用 `Cache-Control: no-store`，点击**隐藏**后 secret 会从组件状态移除。该字段只读：请通过环境变量或 `<DSH_HOME>/.credentials.yaml` 修改凭据。当 Alertmanager 需要使用默认 `http://127.0.0.1:3081/alertmanager` 以外的地址时，设置 `AIOPS_WEBHOOK_PUBLIC_URL`。任何能够使用 DSH Web Portal 的用户都可以揭示此凭据，因此 Web 表层必须保留正常的访问控制。

该客户端模块当前仅支持 DSH Web。它在 `webServer` 可用时注册接口，因此不会破坏无 Host 的 headless 组合；隔离的 Alertmanager webhook listener 不提供此接口。
