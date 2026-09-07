# Agent Note: AIOps 跨 Session 事件历史

Status: implemented

[English](2026-09-05-aiops-cross-session-incident-history.md) | 中文

## 问题

持久事件状态存在于各个 Session 日志中，但操作员或模型如果事先不知道每个 Session id 和事件序号，就无法发现以往事件。第二个权威事件数据库会重复写入，并产生恢复与一致性义务。通用 Session 搜索已经具备所需的持久化观测、SQLite 协调、字面全文语义和精确事件读取，但它不会从 AIOps 事件提取语义文本，也不暴露事件专用工具。

## 决策

AIOps 子系统复用完整的 `ctx.sessionQuery` 能力 seam。`dsh-aiops-incident` 拥有并注册所有稳定 `aiops/incident-state` 字段的语义提取；`dsh-session-query-sqlite` 把这些文档从实时 Session 与持久 Session revision 协调到可丢弃的 FTS5 索引；`dsh-tool-aiops-history` 是事件专用 Consumer。

该 Consumer 暴露 `aiops_incident_list`、`aiops_incident_get` 与 `aiops_incident_search`。它从所属 Agent Session 派生授权，并把每项跨 Session 操作限制为 `cwd` 完全相等。没有 `cwd` 的 Session 只能读取自身。精确读取使用引用的 Session id 与序号重新加载并解码权威仅追加事件；索引内容绝不替代事件状态。

AIOps bundle 把 base 的 session-query 配置替换成 `openAt: startup`，并使用 Harness home 下专用的 `aiops-incidents.sqlite` 路径。该文件是由单一进程拥有的可重建读模型。Session JSONL 仍是事件事实的唯一持久真源，schema 版本重置可以丢弃并重建索引。

列表调用最多扫描配置数量的最新工作区 Session，并返回配置数量的记录。搜索保留 Session Query Provider 的每个 Session 一个最佳事件结果的约定。本包不增加事件聚合、嵌入、运维手册检索、因果推断或自动修复。

## 考虑过的替代方案

- **创建 AIOps 专用 SQLite Service 与 Provider**——不采用，因为它会重复 Session 发现、revision 协调、数据库所有权、FTS 查询安全与生命周期处理，而这些已经由 Session Query seam 负责。
- **把工具调用与工具结果文本作为事件索引**——不采用，因为这些消息是模型产物而非规范领域事件，并且可能遗漏或重复事件状态。
- **让索引成为权威来源**——不采用，因为双写需要与仅追加 Session 持久化进行事务协调，并使崩溃恢复复杂化。
- **只挂载通用 Session 历史工具**——不采用，因为它们暴露更广泛的历史范围，并要求模型在每次调用时重新构造事件专用过滤与解码。

## 结果

AIOps profile 可以在重启后发现以往事件记录、引用准确的 Session 事件，并在不丢失事件状态的情况下删除或重建 SQLite 文件。工作区相等可防止意外跨项目读取，但它不是组织或租户授权模型。列表扫描与搜索分组有意保持有界；分析、全局访问、RAG 与自动动作需要独立能力和评测。
