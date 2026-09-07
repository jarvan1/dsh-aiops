import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { PrometheusHttpRuntime } from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> { return Promise.resolve() }
}

const success = JSON.stringify({
  status: 'success',
  data: { resultType: 'vector', result: [] },
})

function runtimeFor(body: BodyInit | null, init?: ResponseInit, config: {
  baseUrl: string
  timeoutMs?: number
  maxResponseBytes?: number
} = { baseUrl: 'http://metrics.test' }): PrometheusHttpRuntime {
  return new PrometheusHttpRuntime(new Context(), config, () => Promise.resolve(new Response(body, init)))
}

describe('PrometheusHttpRuntime', () => {
  it('starts unconfigured and reports how to configure the provider', async () => {
    const runtime = new PrometheusHttpRuntime(new Context(), {})
    await expect(runtime.query({ query: 'up' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Prometheus URL is not configured. Open AIOps settings to add it.',
    })
  })

  it('uses a URL saved through the live DSH settings section', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    let requested: URL | undefined
    const runtime = new PrometheusHttpRuntime(ctx, { baseUrl: 'http://old.metrics.test' }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(success))
    })
    await vi.waitFor(() => {
      expect(ctx.settings.describe().map(row => String(row.ns))).toContain('aiops-prometheus')
    })
    await ctx.settings.update('aiops-prometheus', { baseUrl: 'http://new.metrics.test/prometheus' })

    await runtime.query({ query: 'up' })

    expect(requested?.host).toBe('new.metrics.test')
    expect(requested?.pathname).toBe('/prometheus/api/v1/query')
    await ctx.fiber.dispose()
  })

  it('encodes an instant query below a configured path prefix', async () => {
    let requested: URL | undefined
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'https://metrics.example.test/prometheus',
      maxResponseBytes: 1_000,
    }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: { job: 'api' }, value: [1, '2'] }] },
      })))
    })

    await expect(runtime.query({ query: 'up{job="api"}', time: '123' })).resolves.toEqual({
      resultType: 'vector',
      result: [{ metric: { job: 'api' }, value: [1, '2'] }],
    })
    expect(requested?.pathname).toBe('/prometheus/api/v1/query')
    expect(requested?.searchParams.get('query')).toBe('up{job="api"}')
    expect(requested?.searchParams.get('time')).toBe('123')
  })

  it('rejects a response whose complete UTF-8 body exceeds the byte cap', async () => {
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'http://metrics.test',
      maxResponseBytes: 2,
    }, () => Promise.resolve(new Response('四')))

    await expect(runtime.query({ query: 'up' })).rejects.toMatchObject({
      code: 'response_too_large',
    })
  })

  it('contains Prometheus error envelopes', async () => {
    const runtime = new PrometheusHttpRuntime(new Context(), { baseUrl: 'http://metrics.test' }, () =>
      Promise.resolve(new Response(JSON.stringify({ status: 'error', error: 'bad promql' }))))

    await expect(runtime.queryRange({ query: '(', start: '1', end: '2', step: '1s' }))
      .rejects.toMatchObject({ code: 'provider_error', message: 'bad promql' })
  })

  it('rejects credentials embedded in the configured URL', () => {
    expect(() => new PrometheusHttpRuntime(new Context(), { baseUrl: 'https://u:p@metrics.test' }))
      .toThrow('without credentials')
  })

  it('uses defaults and supports range queries without optional instant time', async () => {
    const requested: URL[] = []
    const runtime = new PrometheusHttpRuntime(new Context(), { baseUrl: 'http://metrics.test/' }, (input) => {
      requested.push(new URL(input instanceof Request ? input.url : input.toString()))
      return Promise.resolve(new Response(success))
    })

    await expect(runtime.query({ query: ' up ' })).resolves.toEqual({ resultType: 'vector', result: [] })
    await expect(runtime.queryRange({ query: 'up', start: '1', end: '2', step: '30s' }))
      .resolves.toEqual({ resultType: 'vector', result: [] })
    expect(requested[0]?.searchParams.has('time')).toBe(false)
    expect(requested[1]?.pathname).toBe('/api/v1/query_range')
  })

  it('rejects malformed provider configuration and blank query values', () => {
    for (const baseUrl of [
      'relative',
      'file:///tmp/metrics',
      'http://user@metrics.test',
      'http://metrics.test?x=1',
      'http://metrics.test#x',
    ]) {
      expect(() => new PrometheusHttpRuntime(new Context(), { baseUrl })).toThrow()
    }
    for (const timeoutMs of [Number.NaN, 0, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => new PrometheusHttpRuntime(new Context(), { baseUrl: 'https://metrics.test', timeoutMs })).toThrow('timeoutMs')
    }
    for (const maxResponseBytes of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new PrometheusHttpRuntime(new Context(), { baseUrl: 'https://metrics.test', maxResponseBytes }))
        .toThrow('maxResponseBytes')
    }

    const runtime = runtimeFor(success)
    expect(() => runtime.query({ query: '  ' })).toThrow('query must be non-empty')
    expect(() => runtime.query({ query: 'up', time: '  ' })).toThrow('time must be non-empty')
  })

  it('contains transport, deadline, and non-success HTTP failures', async () => {
    const transport = new PrometheusHttpRuntime(new Context(), { baseUrl: 'http://metrics.test' }, () =>
      Promise.reject(new Error('offline')))
    await expect(transport.query({ query: 'up' })).rejects.toMatchObject({ code: 'http_error' })

    const brokenBody = new PrometheusHttpRuntime(new Context(), { baseUrl: 'http://metrics.test' }, () =>
      Promise.resolve(new Response(new ReadableStream({
        pull() { throw new Error('stream failed') },
      }))))
    await expect(brokenBody.query({ query: 'up' })).rejects.toMatchObject({ code: 'http_error' })

    const timeout = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'http://metrics.test',
      timeoutMs: 1,
    }, (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    }))
    await expect(timeout.query({ query: 'up' })).rejects.toMatchObject({ code: 'timeout' })

    await expect(runtimeFor('unavailable', { status: 503 }).query({ query: 'up' }))
      .rejects.toMatchObject({ code: 'http_error', message: 'Prometheus returned HTTP 503.' })
  })

  it('enforces declared and streamed response limits and accepts an empty body transport', async () => {
    await expect(runtimeFor(success, { headers: { 'content-length': '100' } }, {
      baseUrl: 'http://metrics.test',
      maxResponseBytes: 10,
    }).query({ query: 'up' })).rejects.toMatchObject({ code: 'response_too_large' })

    await expect(runtimeFor(null).query({ query: 'up' }))
      .rejects.toMatchObject({ code: 'provider_error', message: 'Prometheus returned invalid JSON.' })
  })

  it.each([
    ['not JSON', 'Prometheus returned invalid JSON.'],
    ['null', 'Prometheus returned an invalid response object.'],
    ['[]', 'Prometheus returned an invalid response object.'],
    ['"value"', 'Prometheus returned an invalid response object.'],
    ['{}', 'Prometheus query failed.'],
    ['{"status":"error","error":1}', 'Prometheus query failed.'],
    ['{"status":"success","data":null}', 'Prometheus success response has no data object.'],
    ['{"status":"success","data":[]}', 'Prometheus success response has no data object.'],
    ['{"status":"success","data":"x"}', 'Prometheus success response has no data object.'],
    ['{"status":"success","data":{"resultType":1,"result":[]}}', 'Prometheus success response has invalid query data.'],
    ['{"status":"success","data":{"resultType":"unknown","result":[]}}', 'Prometheus success response has invalid query data.'],
    ['{"status":"success","data":{"resultType":"vector"}}', 'Prometheus success response has invalid query data.'],
  ])('rejects malformed response %s', async (body, message) => {
    await expect(runtimeFor(body).query({ query: 'up' })).rejects.toMatchObject({ code: 'provider_error', message })
  })
})
