---
description: "用于查询持久 AIOps 报告、值班反馈与路由审计的工作区范围只读工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-aiops-history

[English](README.md) | 中文

## 概述

本包让 agent 列出、读取和搜索其工作区内 Session 的持久 `aiops/incident-state`，列出或搜索追加式 `aiops/operator-feedback`，并读取同一 workspace router 的风暴控制审计。Session 结果都指向准确的 Session id 与事件序号，精确读取会解码权威事件而不信任索引内容。全文搜索复用可丢弃的 `ctx.sessionQuery` SQLite 索引；路由审计来自 router 的协调数据库。这些工具不会写入状态或变更基础设施。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型需要调用方工作区内的事件历史时，在已启用的 `ctx.sessionQuery` 服务上挂载本包。

### 何时选择本包

需要跨 Session 审阅事件且不增加另一个权威数据库时选择本包。调用方需要组织级访问控制、分析聚合或自动修复时不要选择它；该 Consumer 仅强制要求 `cwd` 完全相等，并且只暴露只读事件记录。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/aiops-incidents.sqlite
    openAt: startup
- name: '@deepseek-ai/dsh-tool-aiops-history'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultLimit` | `20` | 工具调用省略 `limit` 时的结果数 |
| `maxLimit` | `100` | 可接受的最大结果数 |
| `maxScanSessions` | `500` | 一次列表调用最多检查的工作区 Session 数 |
| `timeoutMs` | `30000` | 每次历史操作的协作式截止时间 |

上表完整列出了所有可接受字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

Consumer 从所属 Agent Session 派生调用方身份与工作区。报告和反馈列表先过滤逻辑 Session 语料库，再读取匹配的事件；搜索仅请求对应 event type；精确读取会重新读取引用的仅追加事件并校验载荷。路由审计工具只有在 router Service 存在时注册，并要求调用方 `cwd` 与 router `workspacePath` 完全相等。没有工作区的调用方只能访问自己的 Session。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、授权、查询操作、JSON 渲染与五个工具注册 |
| — | 不发布 invariant companion，因为每个返回事件数据的操作都在内部检查授权与事件身份 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 事件状态](../aiops-incident/README.zh.md)——权威事件与写入校验。
- [DSH Session Query](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query/README.zh.md)——精确读取与过滤 Service Definition。
- [DSH SQLite Session Query](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query-sqlite/README.zh.md)——可丢弃的 FTS5 Provider 与重建行为。
- [AIOps 子系统](../../docs/aiops.zh.md)——完整调查与历史流程。
- [事件历史决策](../../docs/decisions/2026-09-05-aiops-cross-session-incident-history.zh.md)——职责归属与未采用的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

### 事件历史 schema 与结果

#### 模型看到的内容

模型会看到 `aiops_incident_list`、`aiops_incident_get`、`aiops_incident_search`、`aiops_feedback_list`；router 可用时还会看到 `aiops_routing_audit`。结果是有界 JSON：报告和反馈包含 Session id、事件序号与时间，路由结果包含 delivery、fingerprint、原因、队列深度、Token 预留与 transition 时间。

#### Token 影响

插件可见时，四个固定 schema、一个条件 schema 与指导会添加请求前缀。工具结果只添加配置及每次调用限制选中的有界记录。

#### KV 缓存影响

在注册或配置变化前，指导与 schema 保持稳定。查询结果追加在可复用前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅工作区相等**——授权比较 Session `cwd` 是否完全相等；组织、租户与角色策略需要独立的访问能力。
- **每个 Session 一个搜索命中**——SQLite 跨 Session 搜索按 Session 分组，并返回其中匹配度最高的事件；使用精确读取查看引用的记录。
- **有界列表扫描**——列表最多检查 `maxScanSessions` 个最新工作区 Session，且不返回续页游标。
- **没有指标聚合或 RAG**——工具暴露已存事件和审计，不计算准确率/抑制率，也不提供嵌入、运维手册检索或因果推断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
