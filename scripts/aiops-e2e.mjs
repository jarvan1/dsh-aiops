#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const mode = process.argv[2]
const namespace = process.env.AIOPS_E2E_NAMESPACE || 'aiops-e2e'
const context = process.env.AIOPS_E2E_CONTEXT
const runId = process.env.AIOPS_E2E_RUN_ID || 'local'

function fail(message) { process.stderr.write(`aiops-e2e: ${message}\n`); process.exit(1) }
function required(name) { const value = process.env[name]; if (!value) fail(`${name} is required`); return value }
function exactUrl(name) {
  const value = required(name)
  let url
  try { url = new URL(value) } catch { fail(`${name} must be an HTTP(S) URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`${name} must be a credential-free HTTP(S) URL without query or fragment`)
  return url.toString()
}
function ensureGuard() {
  if (process.env.AIOPS_E2E_CONFIRM !== 'local-test-only') fail('set AIOPS_E2E_CONFIRM=local-test-only for this deliberately disruptive fixture')
  if (!context || !/^[A-Za-z0-9._:@/-]{1,256}$/.test(context)) fail('AIOPS_E2E_CONTEXT must explicitly name the test cluster context')
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) fail('AIOPS_E2E_NAMESPACE must be a DNS label')
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(runId)) fail('AIOPS_E2E_RUN_ID has invalid characters')
}
function kubectl(args, input) {
  const result = spawnSync('kubectl', ['--context', context, ...args], { input, encoding: 'utf8', stdio: input === undefined ? 'inherit' : ['pipe', 'pipe', 'pipe'] })
  if (result.status !== 0) fail((result.stderr || `kubectl ${args[0]} failed`).trim())
  return result.stdout || ''
}
function kubectlOutput(args) {
  const result = spawnSync('kubectl', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) fail((result.stderr || `kubectl ${args[0]} failed`).trim())
  return (result.stdout || '').trim()
}
function namespaceFixture() {
  return `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${namespace}\n`
}
function fixture(webhookUrl, secret, startedAt) {
  const release = process.env.AIOPS_E2E_PROMETHEUS_RELEASE || 'prometheus'
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: dsh-aiops-e2e-run
  namespace: ${namespace}
data:
  runId: ${JSON.stringify(runId)}
  startedAt: ${JSON.stringify(String(startedAt))}
---
apiVersion: v1
kind: Secret
metadata:
  name: dsh-aiops-webhook-auth
  namespace: ${namespace}
type: Opaque
stringData:
  token: ${JSON.stringify(secret)}
---
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: dsh-aiops-e2e
  namespace: ${namespace}
spec:
  route:
    receiver: dsh-aiops
    groupBy: [alertname, aiops_scenario, namespace, pod]
    groupWait: 1s
    groupInterval: 5s
    repeatInterval: 1h
    matchers:
      - name: aiops_test
        matchType: "="
        value: "true"
  receivers:
    - name: dsh-aiops
      webhookConfigs:
        - url: ${webhookUrl}
          sendResolved: true
          timeout: 10s
          httpConfig:
            authorization:
              type: Bearer
              credentials:
                name: dsh-aiops-webhook-auth
                key: token
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: dsh-aiops-e2e
  namespace: ${namespace}
  labels:
    release: ${JSON.stringify(release)}
spec:
  groups:
    - name: dsh-aiops-e2e
      rules:
        - alert: KubePodCrashLooping
          expr: kube_pod_container_status_restarts_total{namespace="${namespace}", pod="crashloop-webhook-test"} > 0
          for: 0m
          labels: { aiops_test: "true", aiops_scenario: kubernetes, severity: critical }
          annotations: { summary: "DSH AIOps CrashLoop E2E" }
        - alert: TargetDown
          expr: vector(1)
          for: 0m
          labels: { aiops_test: "true", aiops_scenario: target-down, severity: warning, job: synthetic-unreachable, namespace: ${JSON.stringify(namespace)} }
          annotations: { summary: "DSH AIOps synthetic TargetDown E2E" }
        - alert: ArbitraryVendorSignal
          expr: vector(1)
          for: 0m
          labels: { aiops_test: "true", aiops_scenario: vendor-severity, severity: page, service: legacy-db, namespace: ${JSON.stringify(namespace)} }
          annotations: { summary: "DSH AIOps vendor severity E2E" }
        - alert: ArbitraryMissingSeverity
          expr: vector(1)
          for: 0m
          labels: { aiops_test: "true", aiops_scenario: missing-severity, service: checkout, namespace: ${JSON.stringify(namespace)} }
          annotations: { summary: "DSH AIOps missing severity E2E" }
        # This always-firing rule is deliberately ignored by the shipped
        # routing policy. Its filtered audit row proves the real
        # Prometheus -> AlertmanagerConfig -> receiver path without a model turn.
        - alert: Watchdog
          expr: vector(1)
          for: 0m
          labels: { aiops_test: "true", aiops_scenario: alertmanager-receiver, severity: info, namespace: ${JSON.stringify(namespace)} }
          annotations: { summary: "DSH AIOps real Alertmanager receiver probe" }
---
apiVersion: v1
kind: Pod
metadata:
  name: crashloop-webhook-test
  namespace: ${namespace}
  labels: { app: dsh-aiops-e2e }
spec:
  restartPolicy: Always
  containers:
    - name: crashloop-webhook-test
      image: busybox:1.36
      command: ["/bin/sh", "-c", "echo aiops-e2e-${runId}; exit 1"]
`
}
function fingerprint(name) { return createHash('sha256').update(`${runId}:${name}`).digest('hex').slice(0, 32) }
function delivery(name, status = 'firing', labels = {}) {
  const now = new Date().toISOString()
  return {
    version: '4', status, receiver: 'dsh-aiops', groupKey: `${runId}:${name}`,
    groupLabels: { alertname: labels.alertname || name }, commonLabels: labels, commonAnnotations: {}, externalURL: 'http://alertmanager.local',
    alerts: [{ status, labels: { alertname: name, aiops_test: 'true', aiops_run: runId, ...labels }, annotations: { summary: `AIOps E2E ${name}` }, startsAt: now, endsAt: status === 'resolved' ? now : '0001-01-01T00:00:00Z', fingerprint: fingerprint(name) }],
  }
}
async function post(webhook, secret, id, value) {
  const response = await fetch(webhook, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-dsh-delivery-id': `${runId}-${id}` }, body: JSON.stringify(value) })
  if (response.status !== 202) fail(`webhook delivery ${id} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
}
async function exercise() {
  const webhook = exactUrl('AIOPS_E2E_WEBHOOK_URL')
  const secret = required('AIOPS_E2E_WEBHOOK_SECRET')
  if (secret.length < 16) fail('AIOPS_E2E_WEBHOOK_SECRET must contain at least 16 characters')
  await post(webhook, secret, 'kubernetes', delivery('KubePodCrashLooping', 'firing', { namespace, pod: 'crashloop-webhook-test', container: 'crashloop-webhook-test', severity: 'critical' }))
  await post(webhook, secret, 'target-down', delivery('TargetDown', 'firing', { job: 'synthetic-unreachable', severity: 'warning' }))
  await post(webhook, secret, 'missing-severity', delivery('ArbitraryMissingSeverity', 'firing', { service: 'checkout' }))
  await post(webhook, secret, 'vendor-severity', delivery('ArbitraryVendorSignal', 'firing', { service: 'legacy-db', severity: 'page' }))
  await post(webhook, secret, 'lifecycle-firing', delivery('LifecycleProbe'))
  await post(webhook, secret, 'lifecycle-resolved', delivery('LifecycleProbe', 'resolved'))
  await post(webhook, secret, 'lifecycle-reopened', delivery('LifecycleProbe'))
  const duplicate = delivery('DuplicateProbe')
  await post(webhook, secret, 'duplicate', duplicate)
  await post(webhook, secret, 'duplicate', duplicate)
  for (let index = 0; index < 8; index += 1) await post(webhook, secret, `burst-${index}`, delivery('BurstProbe'))
  process.stdout.write(`aiops-e2e: submitted direct receiver matrix for run ${runId}\n`)
}
async function portalSnapshot() {
  const url = exactUrl('AIOPS_E2E_PORTAL_URL')
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) fail(`Portal returned HTTP ${response.status}`)
  return await response.json()
}
async function verify() {
  const timeoutMs = Number(process.env.AIOPS_E2E_TIMEOUT_MS || 600000)
  const deadline = Date.now() + timeoutMs
  const startedAt = Number(kubectlOutput(['get', 'configmap', 'dsh-aiops-e2e-run', '-n', namespace, '-o', 'jsonpath={.data.startedAt}']))
  if (!Number.isFinite(startedAt)) fail('fixture start timestamp is unavailable')
  const expected = ['kubernetes', 'target-down', 'missing-severity', 'vendor-severity', 'lifecycle-firing', 'lifecycle-resolved', 'lifecycle-reopened', 'duplicate', ...Array.from({ length: 8 }, (_, index) => `burst-${index}`)].map(id => `${runId}-${id}`)
  let snapshot
  while (Date.now() < deadline) {
    snapshot = await portalSnapshot()
    const seen = new Set((snapshot.audit || []).map(row => row.deliveryId))
    const receiverSeen = (snapshot.audit || []).some(row => row.recordedAt >= startedAt
      && row.alertname === 'Watchdog' && row.outcome === 'filtered' && row.reason === 'alertname-ignored')
    if (expected.every(id => seen.has(id)) && receiverSeen) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (!snapshot) fail('Portal returned no snapshot')
  const audit = snapshot.audit || []
  const missing = expected.filter(id => !audit.some(row => row.deliveryId === id))
  if (missing.length) fail(`route audit is missing deliveries: ${missing.join(', ')}`)
  if (!audit.some(row => row.recordedAt >= startedAt
    && row.alertname === 'Watchdog' && row.outcome === 'filtered' && row.reason === 'alertname-ignored')) {
    fail('real Prometheus -> AlertmanagerConfig -> receiver probe did not reach route audit')
  }
  const duplicateStarts = audit.filter(row => row.deliveryId === `${runId}-duplicate` && row.outcome === 'started')
  if (duplicateStarts.length > 1) fail('duplicate delivery started more than once')
  const lifecycleSessions = new Set(audit.filter(row => row.deliveryId === `${runId}-lifecycle-firing` || row.deliveryId === `${runId}-lifecycle-reopened`).map(row => row.sessionId).filter(Boolean))
  if (lifecycleSessions.size < 2) fail('resolved/reopened lifecycle did not create a second Session round')
  if (!audit.some(row => row.deliveryId?.startsWith(`${runId}-burst-`) && ['grouped', 'deferred', 'dropped'].includes(row.outcome))) fail('burst produced no storm-control audit outcome')
  const incidents = snapshot.incidents || []
  const requireEvidence = (deliveryId, kinds) => {
    const sessions = new Set(audit.filter(row => row.deliveryId === `${runId}-${deliveryId}`).map(row => row.sessionId).filter(Boolean))
    const reports = incidents.filter(item => sessions.has(item.sessionId))
    if (!reports.length) fail(`${deliveryId} has no persisted incident report`)
    if (!reports.some(item => item.incident?.evidence?.some(evidence => kinds.includes(evidence.kind)))) fail(`${deliveryId} report does not contain expected ${kinds.join('/')} evidence`)
  }
  requireEvidence('kubernetes', ['kubernetes', 'log'])
  requireEvidence('target-down', ['metric'])
  requireEvidence('missing-severity', ['alert', 'metric', 'other'])
  process.stdout.write(`aiops-e2e: receiver, lifecycle, retry, burst, Session, evidence, and report matrix passed for ${runId}\n`)
}

ensureGuard()
if (mode === 'setup') {
  const webhook = exactUrl('AIOPS_E2E_WEBHOOK_URL')
  const secret = required('AIOPS_E2E_WEBHOOK_SECRET')
  if (secret.length < 16) fail('AIOPS_E2E_WEBHOOK_SECRET must contain at least 16 characters')
  // The Pod command embeds runId and is immutable. Recreate only this
  // runner-owned Pod so repeated runs with a new id remain deterministic.
  kubectl(['apply', '-f', '-'], namespaceFixture())
  kubectl(['delete', 'pod', 'crashloop-webhook-test', '-n', namespace, '--ignore-not-found=true', '--wait=true'], 'y\n')
  kubectl(['apply', '-f', '-'], fixture(webhook, secret, Date.now()))
  process.stdout.write(`aiops-e2e: fixture applied to context ${context}, namespace ${namespace}; secret value was not printed\n`)
} else if (mode === 'exercise') await exercise()
else if (mode === 'verify') await verify()
else if (mode === 'seed-restart') {
  const webhook = exactUrl('AIOPS_E2E_WEBHOOK_URL'); const secret = required('AIOPS_E2E_WEBHOOK_SECRET')
  for (let index = 0; index < 12; index += 1) await post(webhook, secret, `restart-${index}`, delivery(`RestartProbe${index}`))
  process.stdout.write('aiops-e2e: restart work seeded; stop and restart DSH, then run verify-restart with the same run id\n')
} else if (mode === 'verify-restart') {
  const snapshot = await portalSnapshot()
  if (!(snapshot.audit || []).some(row => row.deliveryId?.startsWith(`${runId}-restart-`) && row.reason === 'restart-recovery')) fail('no restart-recovery audit row found')
  process.stdout.write(`aiops-e2e: restart recovery observed for ${runId}\n`)
} else if (mode === 'cleanup') {
  kubectl(['delete', 'namespace', namespace, '--ignore-not-found=true'], 'y\n')
  const remaining = spawnSync('kubectl', ['--context', context, 'get', 'namespace', namespace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (remaining.status === 0) fail(`namespace ${namespace} still exists after cleanup`)
  process.stdout.write(`aiops-e2e: namespace ${namespace} removed\n`)
} else fail('usage: node scripts/aiops-e2e.mjs <setup|exercise|verify|seed-restart|verify-restart|cleanup>')
