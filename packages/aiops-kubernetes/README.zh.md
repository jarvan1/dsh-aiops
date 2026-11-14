---
description: "DSH AIOps 的只读 Kubernetes 能力，由每次诊断绑定的集群 agent 执行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-aiops-kubernetes

[English](README.md) | 中文

## 概述

本包提供与 Provider 无关的 `ctx.kubernetes` Service，用于读取对象、Event 和有界非流式 Pod 日志。它的 Provider 只走 agent：每次读取都是发往 [`dsh-aiops-agents`](../aiops-agents/README.zh.md) 中已注册集群 agent WebSocket 的一条类型化请求。DSH 主机不持有 kubeconfig、不运行 `kubectl`，也无法直接连接任何集群 API Server。该能力不暴露变更、容器 exec、任意 URL、watch 或原始命令入口。

## 使用本包

```yaml
- name: '@deepseek-ai/dsh-aiops-kubernetes'
  config:
    defaultCluster: prod-sh
    defaultLogTailLines: 200
    maxLogTailLines: 2000
```

每个请求都指向一个已注册集群：incident router 把路由告警的 cluster label（router 可配置，默认 `cluster`）绑定到该次诊断，观测工具据此传入集群名。`defaultCluster` 只用于 router 未创建的 session —— 手动会话，或早于集群绑定存在的轮次。既无绑定也无默认值时，Kubernetes 工具以 `unreachable` 失败并说明没有绑定集群，诊断因此显式退化为 Alertmanager/Prometheus 证据，而不是误读另一个集群。

集群连通性通过探测 agent 验证，而不是测试凭据。Portal 的**集群**页执行该探测并显示 agent 版本与能力集；数据源设置页只覆盖 Prometheus、Alertmanager 与 Webhook。

封闭资源集合与 agent allowlist 一致：Pod、Service、Endpoints、ConfigMap、PVC/PV、Node、Namespace、Deployment、StatefulSet、DaemonSet、ReplicaSet、Job 与 CronJob。Event 与日志窗口在 agent 侧过滤并有界。

## 实现导航

| 文件 | 作用 |
|---|---|
| [`src/runtime.ts`](src/runtime.ts) | 稳定 Service 接口、请求校验与日志请求解析 |
| [`src/index.ts`](src/index.ts) | agent 版 Provider：集群解析、类型化读取、探测与错误映射 |
| [`src/types.ts`](src/types.ts) | Provider 无关请求、结果和连接能力类型 |

## 已知限制

- 每次读取都需要绑定集群的 agent 在线；服务端不再做配置文件流量或 RBAC 检查。
- agent 的 allowlist 取代任意 API discovery 或自定义资源。
- 所有读取均为快照；日志不会 follow，Event 也不会 watch。
- 轮次的集群绑定在轮次开启时确定；若同一 fingerprint 中途迁移集群，仍会读取原集群直到下一轮。

参见 [AIOps 子系统](../../docs/aiops.zh.md)、[agent 协议](../../agent/docs/protocol.zh.md)和[面向模型的观测工具](../tool-aiops-observe/README.zh.md)。
