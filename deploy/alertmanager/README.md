# Repeatable Alertmanager/k3s E2E matrix

The guarded runner [`scripts/aiops-e2e.mjs`](../../scripts/aiops-e2e.mjs) owns setup, direct receiver exercise, Portal verification, restart recovery, and cleanup. It deliberately creates a crashing Pod and synthetic Prometheus rules; use only an explicitly designated test cluster.

Required environment:

```sh
export AIOPS_E2E_CONFIRM=local-test-only
export AIOPS_E2E_CONTEXT=default
export AIOPS_E2E_NAMESPACE=aiops-e2e
export AIOPS_E2E_RUN_ID=run-20260908
export AIOPS_E2E_WEBHOOK_URL=http://HOST_REACHABLE_FROM_K3S:3081/alertmanager
export AIOPS_E2E_PORTAL_URL=http://127.0.0.1:3080/api/aiops/portal
export AIOPS_E2E_WEBHOOK_SECRET='use-a-disposable-secret-of-at-least-16-characters'
```

Start DSH with the same secret, `AIOPS_WEBHOOK_HOST=0.0.0.0`, a persistent test workspace, working Prometheus/Alertmanager/Kubernetes settings, and a model capable of completing the packaged `aiops-diag` workflow. Then run:

```sh
pnpm e2e:k3s:setup
pnpm e2e:k3s:exercise
pnpm e2e:k3s:verify
pnpm e2e:k3s:seed-restart
# Restart DSH without deleting its home or workspace.
pnpm e2e:k3s:verify-restart
pnpm e2e:k3s:cleanup
```

The matrix covers a real Prometheus Operator `AlertmanagerConfig`, CrashLoop, synthetic `TargetDown`, arbitrary alert names, missing and vendor-specific severity, firing/resolved/reopened rounds, duplicate delivery, burst grouping/pressure, and restart recovery. An always-firing `Watchdog` probe must appear as a new filtered route-audit row, proving the real Prometheus → AlertmanagerConfig → authenticated receiver path without consuming a model turn. Verification also requires distinct reopened Session identity, idempotent retry, storm-control outcomes, persisted reports, and Kubernetes/log, metric, and general-alert evidence branches.

The runner refuses implicit cluster context, malformed URLs, weak secrets, unsafe namespace/run identifiers, or execution without the exact confirmation guard. It passes the Secret to `kubectl apply -f -` over stdin, never prints it, and cleanup targets only the exact configured namespace. Always run cleanup, even after a failed verification. The Secret and kubeconfig must never be committed.

The synthetic rules carry the test namespace as an alert label because Prometheus Operator automatically namespace-scopes `AlertmanagerConfig` routes. Removing that label makes `vector(1)` alerts fire in Prometheus but prevents them from matching the real receiver.

The static [`k3s-webhook-e2e.yaml`](k3s-webhook-e2e.yaml) remains a readable single-CrashLoop example and intentionally contains a non-routable URL.
