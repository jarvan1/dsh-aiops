/** Low-cardinality operational telemetry for the DSH AIOps product. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

export const name = 'aiops-observability'
export const HEALTH_PATH = '/api/aiops/healthz'
export const READINESS_PATH = '/api/aiops/readyz'
export const METRICS_PATH = '/api/aiops/metrics'

type WebhookOutcome = 'accepted' | 'authentication_failed' | 'rejected' | 'dispatch_failed'
type WorkOutcome = 'grouped' | 'deferred' | 'dropped'
type Component = 'router' | 'webhook'

export interface RouterGauges {
  readonly queueDepth: number
  readonly queueOldestAgeSeconds: number
  readonly activeDiagnoses: number
  readonly reservedTokens: number
}

export interface Config {
  readonly healthPath?: string
  readonly readinessPath?: string
  readonly metricsPath?: string
}

export const Config: z<Config> = z.object({
  healthPath: z.string().default(HEALTH_PATH),
  readinessPath: z.string().default(READINESS_PATH),
  metricsPath: z.string().default(METRICS_PATH),
})

declare module '@deepseek-ai/cordis' {
  interface Context { aiopsTelemetry: AiopsTelemetry }
}

const LATENCY_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800] as const

function exactPath(value: string, field: string): string {
  if (!value.startsWith('/') || value === '/' || value.endsWith('/') || value.includes('?') || value.includes('#')) {
    throw new Error(`aiops-observability ${field} must be an absolute non-root exact path`)
  }
  return value
}

function send(res: import('node:http').ServerResponse, status: number, type: string, body: string, head: boolean): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(head ? undefined : body)
}

/** Process-lifetime counters and current Router gauges, intentionally without alert labels. */
export class AiopsTelemetry extends Service {
  static Config = Config
  private readonly ready = new Set<Component>()
  private readonly webhook = new Map<WebhookOutcome, number>()
  private readonly work = new Map<WorkOutcome, number>()
  private dispatchFailures = 0
  private latencyCount = 0
  private latencySum = 0
  private readonly latencyBuckets = new Map<number, number>()
  private gauges: RouterGauges = { queueDepth: 0, queueOldestAgeSeconds: 0, activeDiagnoses: 0, reservedTokens: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'aiopsTelemetry')
    const healthPath = exactPath(config.healthPath ?? HEALTH_PATH, 'healthPath')
    const readinessPath = exactPath(config.readinessPath ?? READINESS_PATH, 'readinessPath')
    const metricsPath = exactPath(config.metricsPath ?? METRICS_PATH, 'metricsPath')
    if (new Set([healthPath, readinessPath, metricsPath]).size !== 3) {
      throw new Error('aiops-observability endpoint paths must be distinct')
    }
    for (const outcome of ['accepted', 'authentication_failed', 'rejected', 'dispatch_failed'] as const) this.webhook.set(outcome, 0)
    for (const outcome of ['grouped', 'deferred', 'dropped'] as const) this.work.set(outcome, 0)
    for (const bucket of LATENCY_BUCKETS) this.latencyBuckets.set(bucket, 0)
    ctx.inject(['webServer'], webCtx => {
      const register = (path: string, handler: import('@deepseek-ai/dsh-host-webserver').WebRoute['handler']) =>
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `aiops-observability: ${path}`)
      register(healthPath, (req, res) => {
        const head = req.method === 'HEAD'
        if (req.method !== 'GET' && !head) { res.setHeader('allow', 'GET, HEAD'); send(res, 405, 'text/plain', 'method not allowed\n', false); return }
        send(res, 200, 'application/json; charset=utf-8', '{"status":"ok"}\n', head)
      })
      register(readinessPath, (req, res) => {
        const head = req.method === 'HEAD'
        if (req.method !== 'GET' && !head) { res.setHeader('allow', 'GET, HEAD'); send(res, 405, 'text/plain', 'method not allowed\n', false); return }
        const snapshot = this.readiness()
        send(res, snapshot.ready ? 200 : 503, 'application/json; charset=utf-8', `${JSON.stringify(snapshot)}\n`, head)
      })
      register(metricsPath, (req, res) => {
        const head = req.method === 'HEAD'
        if (req.method !== 'GET' && !head) { res.setHeader('allow', 'GET, HEAD'); send(res, 405, 'text/plain', 'method not allowed\n', false); return }
        send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', this.renderMetrics(), head)
      })
    })
  }

  markComponent(component: Component, ready: boolean): void { ready ? this.ready.add(component) : this.ready.delete(component) }
  recordWebhook(outcome: WebhookOutcome): void { this.webhook.set(outcome, (this.webhook.get(outcome) ?? 0) + 1) }
  recordWork(outcome: WorkOutcome, count = 1): void { this.work.set(outcome, (this.work.get(outcome) ?? 0) + count) }
  recordDispatchFailure(): void { this.dispatchFailures += 1 }
  setRouterGauges(value: RouterGauges): void { this.gauges = { ...value } }
  observeDiagnosticLatency(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return
    this.latencyCount += 1
    this.latencySum += seconds
    for (const bucket of LATENCY_BUCKETS) if (seconds <= bucket) this.latencyBuckets.set(bucket, (this.latencyBuckets.get(bucket) ?? 0) + 1)
  }

  readiness(): { ready: boolean; components: Record<Component, boolean> } {
    const components = { router: this.ready.has('router'), webhook: this.ready.has('webhook') }
    return { ready: components.router && components.webhook, components }
  }

  renderMetrics(): string {
    const lines = [
      '# HELP dsh_aiops_webhook_requests_total Alertmanager webhook requests by bounded outcome.',
      '# TYPE dsh_aiops_webhook_requests_total counter',
      ...([...this.webhook] as [WebhookOutcome, number][]).map(([outcome, value]) => `dsh_aiops_webhook_requests_total{outcome="${outcome}"} ${value}`),
      '# HELP dsh_aiops_queue_depth Durable queued and processing work items.',
      '# TYPE dsh_aiops_queue_depth gauge', `dsh_aiops_queue_depth ${this.gauges.queueDepth}`,
      '# HELP dsh_aiops_queue_oldest_age_seconds Age of the oldest queued or processing item.',
      '# TYPE dsh_aiops_queue_oldest_age_seconds gauge', `dsh_aiops_queue_oldest_age_seconds ${this.gauges.queueOldestAgeSeconds}`,
      '# HELP dsh_aiops_route_work_total Grouped, deferred, and dropped work transitions.',
      '# TYPE dsh_aiops_route_work_total counter',
      ...([...this.work] as [WorkOutcome, number][]).map(([outcome, value]) => `dsh_aiops_route_work_total{outcome="${outcome}"} ${value}`),
      '# HELP dsh_aiops_active_diagnoses Active model diagnosis turns.', '# TYPE dsh_aiops_active_diagnoses gauge', `dsh_aiops_active_diagnoses ${this.gauges.activeDiagnoses}`,
      '# HELP dsh_aiops_model_reserved_tokens Tokens reserved by active diagnoses.', '# TYPE dsh_aiops_model_reserved_tokens gauge', `dsh_aiops_model_reserved_tokens ${this.gauges.reservedTokens}`,
      '# HELP dsh_aiops_dispatch_failures_total Session dispatch failures.', '# TYPE dsh_aiops_dispatch_failures_total counter', `dsh_aiops_dispatch_failures_total ${this.dispatchFailures}`,
      '# HELP dsh_aiops_diagnostic_latency_seconds Time from durable dispatch to model idle.', '# TYPE dsh_aiops_diagnostic_latency_seconds histogram',
      ...LATENCY_BUCKETS.map(bucket => `dsh_aiops_diagnostic_latency_seconds_bucket{le="${bucket}"} ${this.latencyBuckets.get(bucket) ?? 0}`),
      `dsh_aiops_diagnostic_latency_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `dsh_aiops_diagnostic_latency_seconds_sum ${this.latencySum}`,
      `dsh_aiops_diagnostic_latency_seconds_count ${this.latencyCount}`,
    ]
    return `${lines.join('\n')}\n`
  }
}

export default AiopsTelemetry
