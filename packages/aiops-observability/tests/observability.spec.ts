import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiopsTelemetry, HEALTH_PATH, METRICS_PATH, READINESS_PATH } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('AiopsTelemetry', () => {
  it('reports readiness only after both ingress and router are ready', () => {
    const telemetry = new AiopsTelemetry(context())
    expect(telemetry.readiness().ready).toBe(false)
    telemetry.markComponent('router', true)
    telemetry.markComponent('webhook', true)
    expect(telemetry.readiness()).toEqual({ ready: true, components: { router: true, webhook: true } })
  })

  it('renders low-cardinality counters, gauges, and cumulative latency buckets', () => {
    const telemetry = new AiopsTelemetry(context())
    telemetry.recordWebhook('authentication_failed')
    telemetry.recordWebhook('accepted')
    telemetry.recordWork('grouped', 2)
    telemetry.recordWork('dropped')
    telemetry.recordDispatchFailure()
    telemetry.setRouterGauges({ queueDepth: 3, queueOldestAgeSeconds: 12, activeDiagnoses: 2, reservedTokens: 6144 })
    telemetry.observeDiagnosticLatency(4)
    const metrics = telemetry.renderMetrics()
    expect(metrics).toContain('dsh_aiops_webhook_requests_total{outcome="authentication_failed"} 1')
    expect(metrics).toContain('dsh_aiops_queue_depth 3')
    expect(metrics).toContain('dsh_aiops_route_work_total{outcome="grouped"} 2')
    expect(metrics).toContain('dsh_aiops_model_reserved_tokens 6144')
    expect(metrics).toContain('dsh_aiops_diagnostic_latency_seconds_bucket{le="5"} 1')
    expect(metrics).not.toContain('alertname=')
  })

  it('registers exact health, readiness, and Prometheus routes', async () => {
    const routes: WebRoute[] = []
    const ctx = context()
    ctx.provide('webServer', {
      register: (route: WebRoute) => { routes.push(route); return vi.fn() },
    } as never)
    const telemetry = new AiopsTelemetry(ctx)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(routes.map(route => route.path)).toEqual([HEALTH_PATH, READINESS_PATH, METRICS_PATH])

    const request = async (path: string, method = 'GET') => {
      const route = routes.find(value => value.path === path)
      let status = 0
      let body = ''
      const headers = new Map<string, unknown>()
      const response = {
        setHeader: (name: string, value: unknown) => headers.set(name, value),
        writeHead: (value: number, values?: Record<string, unknown>) => {
          status = value
          for (const [name, header] of Object.entries(values ?? {})) headers.set(name, header)
        },
        end: (value?: string) => { body = value ?? '' },
      }
      await route?.handler({ method } as never, response as never)
      return { status, body, headers }
    }

    await expect(request(HEALTH_PATH)).resolves.toMatchObject({ status: 200, body: '{"status":"ok"}\n' })
    await expect(request(READINESS_PATH)).resolves.toMatchObject({ status: 503 })
    telemetry.markComponent('router', true)
    telemetry.markComponent('webhook', true)
    await expect(request(READINESS_PATH)).resolves.toMatchObject({ status: 200 })
    await expect(request(METRICS_PATH)).resolves.toMatchObject({
      status: 200,
      body: expect.stringContaining('dsh_aiops_queue_depth'),
    })
    const rejected = await request(METRICS_PATH, 'POST')
    expect(rejected).toMatchObject({ status: 405, body: 'method not allowed\n' })
    expect(rejected.headers.get('allow')).toBe('GET, HEAD')
  })
})
