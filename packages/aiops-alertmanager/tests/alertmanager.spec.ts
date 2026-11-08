import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AlertmanagerHttpRuntime } from '../src/index.ts'

const alerts = JSON.stringify([{
  labels: { alertname: 'HighLatency', service: 'payments' },
  annotations: { summary: 'Latency is high.' },
  status: { state: 'active', silencedBy: [], inhibitedBy: [], mutedBy: [] },
}])

function runtimeFor(body: BodyInit | null, init?: ResponseInit, config: {
  baseUrl: string
  timeoutMs?: number
  maxResponseBytes?: number
  maxFilterCount?: number
  maxQueryValueChars?: number
} = { baseUrl: 'http://alerts.test' }): AlertmanagerHttpRuntime {
  return new AlertmanagerHttpRuntime(new Context(), config, () => Promise.resolve(new Response(body, init)))
}

describe('AlertmanagerHttpRuntime', () => {
  it('starts unconfigured and reports how to configure the provider', async () => {
    const runtime = new AlertmanagerHttpRuntime(new Context(), {})
    await expect(runtime.alerts(runtime.resolveAlerts({}))).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Alertmanager URL is not configured. Open AIOps settings to add it.',
    })
  })

  it('serves the configured entry URL; DSH 0.2.x applies settings edits by reloading the entry', async () => {
    let requested: URL | undefined
    const runtime = new AlertmanagerHttpRuntime(new Context(), { baseUrl: 'http://new.alerts.test/alertmanager' }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response('[]'))
    })

    await runtime.alerts(runtime.resolveAlerts({}))

    expect(requested?.host).toBe('new.alerts.test')
    expect(requested?.pathname).toBe('/alertmanager/api/v2/alerts')
  })

  it('resolves API defaults and reads current alerts below a path prefix', async () => {
    let requested: URL | undefined
    const runtime = new AlertmanagerHttpRuntime(new Context(), {
      baseUrl: 'https://ops.example.test/alertmanager',
    }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response(alerts))
    })
    const spec = runtime.resolveAlerts({})

    expect(spec).toEqual({
      active: true,
      silenced: true,
      inhibited: true,
      unprocessed: true,
      filters: [],
      receiverMatchers: [],
    })
    await expect(runtime.alerts(spec)).resolves.toHaveLength(1)
    expect(requested?.pathname).toBe('/alertmanager/api/v2/alerts')
    expect(requested?.searchParams.get('active')).toBe('true')
    expect(requested?.searchParams.has('receiver')).toBe(false)
  })

  it('normalizes and encodes explicit alert and receiver filters', async () => {
    let requested: URL | undefined
    const runtime = new AlertmanagerHttpRuntime(new Context(), { baseUrl: 'http://alerts.test/' }, (input) => {
      requested = new URL(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(new Response('[]'))
    })
    const spec = runtime.resolveAlerts({
      active: false,
      silenced: false,
      inhibited: false,
      unprocessed: false,
      filters: [' alertname="HighLatency" ', 'service="payments"'],
      receiver: ' oncall-.* ',
      receiverMatchers: [' owner="payments" '],
    })

    await runtime.alerts(spec)
    expect(requested?.searchParams.get('active')).toBe('false')
    expect(requested?.searchParams.getAll('filter')).toEqual([
      'alertname="HighLatency"', 'service="payments"',
    ])
    expect(requested?.searchParams.get('receiver')).toBe('oncall-.*')
    expect(requested?.searchParams.getAll('receiver_matchers')).toEqual(['owner="payments"'])
  })

  it('rejects malformed Provider configuration', () => {
    for (const baseUrl of [
      'relative',
      'file:///tmp/alerts',
      'http://user@alerts.test',
      'http://alerts.test?x=1',
      'http://alerts.test#x',
    ]) {
      expect(() => new AlertmanagerHttpRuntime(new Context(), { baseUrl })).toThrow()
    }
    for (const timeoutMs of [Number.NaN, 0, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => new AlertmanagerHttpRuntime(new Context(), { baseUrl: 'https://alerts.test', timeoutMs }))
        .toThrow('timeoutMs')
    }
    for (const field of ['maxResponseBytes', 'maxFilterCount', 'maxQueryValueChars'] as const) {
      for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => new AlertmanagerHttpRuntime(new Context(), {
          baseUrl: 'https://alerts.test',
          [field]: value,
        })).toThrow(field)
      }
    }
  })

  it('rejects excessive, empty, and oversized query expressions', () => {
    const runtime = new AlertmanagerHttpRuntime(new Context(), {
      baseUrl: 'http://alerts.test',
      maxFilterCount: 1,
      maxQueryValueChars: 5,
    })
    expect(() => runtime.resolveAlerts({ filters: ['a', 'b'] })).toThrow('at most 1')
    expect(() => runtime.resolveAlerts({ filters: [' '] })).toThrow('filter must be non-empty')
    expect(() => runtime.resolveAlerts({ filters: ['123456'] })).toThrow('filter must not exceed 5')
    expect(() => runtime.resolveAlerts({ receiver: ' ' })).toThrow('receiver must be non-empty')
    expect(() => runtime.resolveAlerts({ receiverMatchers: ['123456'] })).toThrow('receiver matcher must not exceed 5')
  })

  it('contains transport, deadline, and non-success HTTP failures', async () => {
    const transport = new AlertmanagerHttpRuntime(new Context(), { baseUrl: 'http://alerts.test' }, () =>
      Promise.reject(new Error('offline')))
    await expect(transport.alerts(transport.resolveAlerts({}))).rejects.toMatchObject({ code: 'http_error' })

    const brokenBody = new AlertmanagerHttpRuntime(new Context(), { baseUrl: 'http://alerts.test' }, () =>
      Promise.resolve(new Response(new ReadableStream({
        pull() { throw new Error('stream failed') },
      }))))
    await expect(brokenBody.alerts(brokenBody.resolveAlerts({}))).rejects.toMatchObject({ code: 'http_error' })

    const timeout = new AlertmanagerHttpRuntime(new Context(), {
      baseUrl: 'http://alerts.test',
      timeoutMs: 1,
    }, (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    }))
    await expect(timeout.alerts(timeout.resolveAlerts({}))).rejects.toMatchObject({ code: 'timeout' })

    const unavailable = runtimeFor('unavailable', { status: 503 })
    await expect(unavailable.alerts(unavailable.resolveAlerts({})))
      .rejects.toMatchObject({ code: 'http_error', message: 'Alertmanager returned HTTP 503.' })
  })

  it('enforces declared and streamed complete-response byte limits', async () => {
    const declared = runtimeFor(alerts, { headers: { 'content-length': '100' } }, {
      baseUrl: 'http://alerts.test', maxResponseBytes: 10,
    })
    await expect(declared.alerts(declared.resolveAlerts({}))).rejects.toMatchObject({ code: 'response_too_large' })

    const streamed = runtimeFor('四', undefined, { baseUrl: 'http://alerts.test', maxResponseBytes: 2 })
    await expect(streamed.alerts(streamed.resolveAlerts({}))).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it.each([
    ['not JSON', 'Alertmanager returned invalid JSON.'],
    ['', 'Alertmanager returned invalid JSON.'],
    ['null', 'Alertmanager returned an invalid alerts array.'],
    ['{}', 'Alertmanager returned an invalid alerts array.'],
    ['[null]', 'Alertmanager returned an invalid alerts array.'],
    ['[[]]', 'Alertmanager returned an invalid alerts array.'],
    ['[1]', 'Alertmanager returned an invalid alerts array.'],
  ])('rejects malformed response %s', async (body, message) => {
    const runtime = runtimeFor(body === '' ? null : body)
    await expect(runtime.alerts(runtime.resolveAlerts({}))).rejects.toMatchObject({ code: 'provider_error', message })
  })
})
