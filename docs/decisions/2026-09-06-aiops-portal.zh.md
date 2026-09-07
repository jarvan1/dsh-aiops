# 决策：把第一版 Portal 作为 DSH Web 原生只读视图

日期：2026-09-06
状态：已接受

## 决策

新增独立包 `@deepseek-ai/dsh-aiops-portal`，同时提供 Host 与 Web client 两个面。Client 同时注册常驻的 `sidebar.footer.action` 和现有 `conversation.view`，Host 在应用已有 `webServer` 上注册固定同源接口 `/api/aiops/portal`。全局工作台提供由 DSH settings 文档持久化的 Prometheus 与 Alertmanager URL 实时设置。

接口只读取 `ctx.aiopsIncidentRouter.workspacePath` 对应的 Session，不接受客户端 workspace 参数。它对会话、事件和路由审计进行有界扫描，将每个 Session 的最新完整报告、与该报告序号精确匹配的最新人工反馈，以及该 Session 的最近路由记录组成临时快照。Portal 不新增持久化，也不修改事件。

## 原因

- 保持 Session 事件和 Router SQLite 作为既有真源，避免 Portal 数据漂移。
- 复用 DSH 的 Slot、主题、语言和模块加载机制，使它随 plugin 安装与卸载。
- 固定服务端工作区范围，避免浏览器参数造成跨工作区读取。
- 第一版只读，维持现有“诊断与建议、不执行修复”的安全边界。

## 后果

第一版支持常驻侧边栏入口、概览指标、客户端搜索/筛选、事件主从详情、人工反馈显示、路由审计表、30 秒刷新和持久化实时数据源设置。它目前只面向 DSH Web；Electron IPC、Portal 内反馈提交、修复审批、跨工作区总览和 RAG 均延期。
