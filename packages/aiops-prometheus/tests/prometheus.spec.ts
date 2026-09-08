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

  it('recovers bounded canonical alert rules and a same-origin generator expression', async () => {
    let requested: URL | undefined
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'https://metrics.test/prometheus',
      defaultDiscoveryLimit: 1,
    }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(JSON.stringify({
        status: 'success',
        data: {
          groups: [{
            name: 'service.rules',
            file: '/etc/prometheus/service.yml',
            interval: 30,
            rules: [{
              type: 'alerting',
              name: 'HighErrorRate',
              query: 'rate(http_requests_total{code=~"5.."}[5m]) > 0.1',
              duration: 300,
              health: 'ok',
              labels: { team: 'payments', severity: 'page' },
              annotations: { summary: 'Elevated errors' },
            }, {
              type: 'alerting',
              name: 'HighErrorRate',
              query: 'other_metric > 0',
              labels: { team: 'other' },
              annotations: {},
            }, {
              type: 'recording',
              name: 'HighErrorRate',
              query: 'ignored',
            }],
          }],
        },
      })))
    })

    await expect(runtime.rules({
      alertName: 'HighErrorRate',
      labelMatchers: [{ name: 'severity', value: 'page' }, { name: 'team', value: 'payments' }],
      generatorUrl: 'https://metrics.test/prometheus/graph?g0.expr=rate%28http_requests_total%5B5m%5D%29&g0.tab=1',
    })).resolves.toEqual({
      alertName: 'HighErrorRate',
      generatorExpression: 'rate(http_requests_total[5m])',
      rules: [{
        name: 'HighErrorRate',
        query: 'rate(http_requests_total{code=~"5.."}[5m]) > 0.1',
        duration: 300,
        labels: { severity: 'page', team: 'payments' },
        annotations: { summary: 'Elevated errors' },
        health: 'ok',
        group: { name: 'service.rules', file: '/etc/prometheus/service.yml', interval: 30 },
        matchingLabels: ['severity', 'team'],
        conflictingLabels: [],
      }],
      truncated: true,
    })
    expect(requested?.pathname).toBe('/prometheus/api/v1/rules')
    expect(requested?.searchParams.get('type')).toBe('alert')
    expect(requested?.searchParams.get('exclude_alerts')).toBe('true')
    expect(requested?.searchParams.get('rule_name[]')).toBe('HighErrorRate')
  })

  it('never fetches an arbitrary generator URL', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}')))
    const runtime = new PrometheusHttpRuntime(new Context(), { baseUrl: 'https://metrics.test/prometheus' }, fetchImpl)

    await expect(runtime.rules({
      alertName: 'TargetDown',
      generatorUrl: 'https://attacker.test/graph?g0.expr=up',
    })).rejects.toMatchObject({ code: 'invalid_request', message: 'generatorUrl must identify the configured Prometheus graph endpoint.' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns only matching target health and strips URL credentials and query data', async () => {
    let requested: URL | undefined
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'http://metrics.test',
      defaultDiscoveryLimit: 5,
      maxDiscoveryLimit: 5,
    }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(JSON.stringify({
        status: 'success',
        data: {
          activeTargets: [{
            discoveredLabels: { job: 'api', __address__: 'api:9090' },
            labels: { instance: 'api:9090', job: 'api' },
            scrapePool: 'api',
            scrapeUrl: 'http://user:secret@api:9090/metrics?token=secret',
            globalUrl: 'https://public.test/metrics#fragment',
            health: 'down',
            lastError: 'connection refused',
            lastScrape: '2026-09-08T00:00:00Z',
            lastScrapeDuration: 0.1,
          }, {
            discoveredLabels: { job: 'other' },
            labels: { instance: 'other:9090', job: 'other' },
            scrapePool: 'other',
          }],
          droppedTargets: [],
        },
      })))
    })

    await expect(runtime.targets({
      state: 'active',
      labelMatchers: [{ name: 'job', value: 'api' }, { name: 'instance', value: 'api:9090' }],
      limit: 5,
    })).resolves.toEqual({
      targets: [{
        state: 'active',
        labels: { instance: 'api:9090', job: 'api' },
        discoveredLabels: { __address__: 'api:9090', job: 'api' },
        scrapePool: 'api',
        scrapeUrl: 'http://api:9090/metrics',
        globalUrl: 'https://public.test/metrics',
        health: 'down',
        lastError: 'connection refused',
        lastScrape: '2026-09-08T00:00:00Z',
        lastScrapeDuration: 0.1,
      }],
      truncated: false,
    })
    expect(requested?.pathname).toBe('/api/v1/targets')
    expect(requested?.searchParams.get('state')).toBe('active')
  })

  it('discovers sorted, deduplicated, and strictly limited series metadata', async () => {
    let requested: URL | undefined
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'http://metrics.test',
      defaultDiscoveryLimit: 2,
      maxDiscoveryLimit: 3,
      maxDiscoveryWindowSeconds: 3_600,
    }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(JSON.stringify({
        status: 'success',
        data: [
          { job: 'api', __name__: 'up', instance: 'b' },
          { instance: 'a', __name__: 'up', job: 'api' },
          { __name__: 'up', instance: 'c', job: 'api' },
        ],
      })))
    })

    await expect(runtime.discover({
      kind: 'series',
      matchers: ['up{job="api"}'],
      start: '2026-09-08T00:00:00Z',
      end: '2026-09-08T00:30:00Z',
    })).resolves.toEqual({
      kind: 'series',
      items: [
        { __name__: 'up', instance: 'a', job: 'api' },
        { __name__: 'up', instance: 'b', job: 'api' },
      ],
      truncated: true,
    })
    expect(requested?.pathname).toBe('/api/v1/series')
    expect(requested?.searchParams.getAll('match[]')).toEqual(['up{job="api"}'])
    expect(requested?.searchParams.get('limit')).toBe('3')
  })

  it('supports bounded label discovery and rejects unrestricted discovery inputs', async () => {
    const requested: URL[] = []
    const runtime = new PrometheusHttpRuntime(new Context(), {
      baseUrl: 'http://metrics.test',
      defaultDiscoveryLimit: 2,
      maxDiscoveryLimit: 2,
      maxDiscoveryWindowSeconds: 60,
    }, (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      requested.push(url)
      return Promise.resolve(new Response(JSON.stringify({ status: 'success', data: ['z', 'a', 'a'] })))
    })
    const window = { start: '2026-09-08T00:00:00Z', end: '2026-09-08T00:01:00Z' }

    await expect(runtime.discover({
      kind: 'label_values',
      labelName: 'instance',
      matchers: ['{job="api"}'],
      limit: 2,
      ...window,
    })).resolves.toEqual({ kind: 'label_values', labelName: 'instance', items: ['a', 'z'], truncated: false })
    expect(requested[0]?.pathname).toBe('/api/v1/label/instance/values')

    await expect(runtime.discover({ kind: 'series', matchers: ['{}'], ...window }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.discover({
      kind: 'label_names',
      matchers: ['up'],
      start: '2026-09-08T00:00:00Z',
      end: '2026-09-08T00:02:00Z',
    })).rejects.toThrow('discovery window must not exceed 60 seconds')
    await expect(runtime.targets({})).rejects.toThrow('at least one label matcher or scrapePool')
  })

  it('validates discovery containment configuration', () => {
    for (const config of [
      { defaultDiscoveryLimit: 0 },
      { maxDiscoveryLimit: 0 },
      { maxMatcherCount: 0 },
      { maxInputChars: 0 },
      { maxDiscoveryWindowSeconds: 0 },
      { defaultDiscoveryLimit: 2, maxDiscoveryLimit: 1 },
    ]) {
      expect(() => new PrometheusHttpRuntime(new Context(), { baseUrl: 'http://metrics.test', ...config })).toThrow()
    }
  })
})
