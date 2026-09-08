# 可重复的 Alertmanager/k3s E2E 矩阵

带安全门槛的运行器 [`scripts/aiops-e2e.mjs`](../../scripts/aiops-e2e.mjs) 负责环境创建、真实 receiver 投递、Portal 验证、重启恢复与清理。它会故意创建崩溃 Pod 和合成 Prometheus 规则，只能用于明确指定的测试集群。

需要显式设置：

```sh
export AIOPS_E2E_CONFIRM=local-test-only
export AIOPS_E2E_CONTEXT=default
export AIOPS_E2E_NAMESPACE=aiops-e2e
export AIOPS_E2E_RUN_ID=run-20260908
export AIOPS_E2E_WEBHOOK_URL=http://K3S可访问的DSH主机:3081/alertmanager
export AIOPS_E2E_PORTAL_URL=http://127.0.0.1:3080/api/aiops/portal
export AIOPS_E2E_WEBHOOK_SECRET='至少16字符的一次性测试密钥'
```

以相同密钥、`AIOPS_WEBHOOK_HOST=0.0.0.0`、持久测试 workspace、可用数据源设置和能够完成 `aiops-diag` 的模型启动 DSH，然后依次执行：

```sh
pnpm e2e:k3s:setup
pnpm e2e:k3s:exercise
pnpm e2e:k3s:verify
pnpm e2e:k3s:seed-restart
# 保留 DSH home 与 workspace，重启 DSH。
pnpm e2e:k3s:verify-restart
pnpm e2e:k3s:cleanup
```

矩阵覆盖真实 Prometheus Operator `AlertmanagerConfig`、CrashLoop、合成 `TargetDown`、任意告警名、缺失/厂商 severity、firing/resolved/reopened、重复投递、突发分组/压力与重启恢复。一个始终 firing 的 `Watchdog` 探针必须成为新的 filtered 路由审计，以证明真实 Prometheus → AlertmanagerConfig → 认证 receiver 链路，且不会消耗模型 turn。验证还要求 reopened 的新 Session、幂等重试、风暴控制结果、持久报告，以及 Kubernetes/日志、指标和通用告警证据分支。

运行器拒绝隐式集群 context、非法 URL、过短密钥、不安全的 namespace/run ID，以及未提供精确确认门槛的执行。Secret 只通过 stdin 交给 `kubectl apply -f -`，不会打印；清理只针对明确 namespace。即使验证失败也应执行 cleanup，且绝不能提交 Secret 或 kubeconfig。

合成规则会把测试 namespace 写入告警 label，因为 Prometheus Operator 会自动为 `AlertmanagerConfig` route 增加 namespace 限定；移除该 label 会导致 `vector(1)` 告警虽在 Prometheus firing，却无法匹配真实 receiver。
