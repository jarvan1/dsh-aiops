---
description: "在 Session 中记录证据、假设、状态与需人工审核建议的持久完整状态 AIOps 事件报告。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-incident

[English](README.md) | 中文

## 概述

本包为每个 Agent Session 记录结构化事件报告，并把值班人员对报告的确认、修正或否定追加为独立反馈。模型通过 `aiops_incident_report` 写入完整当前报告；每次接受的写入都会成为 `aiops/incident-state` 事件。只有在用户明确表达 verdict 后，`aiops_incident_feedback` 才会追加 `aiops/operator-feedback`，引用当时报告的事件序号且不改写报告。插件挂载时，`aiopsIncident` 和 `aiopsIncidentFeedback` 投影分别暴露最新报告与最新反馈。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

将其与 Session 持久化、投影和工具 Service 一起挂载。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-aiops-incident'
```

注册的工具 schema 是完整报告与追加式反馈字段的权威来源。`corrected` verdict 必须包含 correction；其他 verdict 不接受 correction。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

模型/工具 JSON 边界会修剪并限制文本、为事件、证据与反馈 ID 添加品牌、接受显式的告警/指标/Kubernetes/日志/变更来源、拒绝重复证据，并验证每个假设引用。报告写入和反馈写入都在追加前后执行持久化检查点；反馈 ID 从 Session 与工具 call identity 确定性派生，因此重放不会重复追加。反馈引用准确的 `reportSeq`，所以后续报告更新不会改变它当时审核的对象。当 `ctx.sessionQuery` 存在时，本包为报告与反馈分别注册带修订号的语义提取。

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 持久事件、领域记录与投影类型映射 |
| [`src/domain.ts`](src/domain.ts) | 严格解码与生命周期校验 |
| [`src/feedback.ts`](src/feedback.ts) | 追加式值班反馈的严格解码与投影 schema |
| [`src/index.ts`](src/index.ts) | 报告/反馈投影、持久化检查点、语义文本贡献与面向模型的工具 |
| — | 不发布 invariant companion，因为完整事件由唯一投影解码，写入路径也在追加前检查生命周期连续性 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [AIOps 子系统](../../docs/aiops.zh.md)——领域流程与只读边界。
- [DSH Session 投影](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.zh.md)——当前状态重放语义。
- [观测工具](../tool-aiops-observe/README.zh.md)——证据采集。
- [AIOps 基础决策](../../docs/decisions/2026-09-04-dsh-aiops-read-only-foundation.zh.md)——包与安全选择。

-----

<a id="dev-note"></a>
## 开发备注

无。

-----

<a id="model-experience"></a>
## 模型体验

### 事件报告 schema 与结果

#### 模型看到的内容

模型会看到 `aiops_incident_report` 和 `aiops_incident_feedback` schema。前者要求完整替换报告、稳定 ID、证据关联假设、事实分离以及需人工审核的建议；后者只允许在当前用户明确确认、修正或否定诊断后调用。

#### Token 影响

插件可见时，这两个 schema 添加固定的请求前缀。每次调用通过普通工具结果把规范化结果追加到模型历史；持久领域事件本身不会另外添加消息。

#### KV 缓存影响

在注册变化前，工具 schema 前缀保持稳定。报告追加在可复用前缀之后，不替换更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个 Session 一个事件**——不同事件需要新的 Session；当前不表示合并、父子事件关联或重新打开。
- **反馈不是事实改写**——反馈只表达操作员对特定报告版本的 verdict；要修订当前报告仍需另一次完整 `aiops_incident_report` 写入。
- **没有自动修复**——建议只是存储的文本，绝不会授权或执行基础设施变更。
- **没有独立事件数据库**——持久化复用现有 Session 日志与投影栈；[`dsh-tool-aiops-history`](../tool-aiops-history/README.zh.md) 查询可丢弃的派生索引，但不替换该真源。
