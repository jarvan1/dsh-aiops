import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAlertmanagerWebhookHandler } from '../src/handler.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

function body(): string {
  return JSON.stringify({
    version: '4',
    status: 'firing',
    receiver: 'platform',
    groupKey: 'group-1',
    alerts: [{
      status: 'firing',
      labels: { alertname: 'KubePodCrashLooping', severity: 'critical' },
      annotations: { summary: 'pod restarts' },
      startsAt: '2026-09-06T01:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      fingerprint: '0123456789abcdef',
    }],
  })
}

function fakeContext(secret: string | undefined = 'secret'): {
  ctx: Context
  dispatch: ReturnType<typeof vi.fn>
  warnings: ReturnType<typeof vi.fn>
  telemetry: ReturnType<typeof vi.fn>
} {
  const dispatch = vi.fn()
  const warnings = vi.fn()
  const telemetry = vi.fn()
  return {
    ctx: {
      credentials: { resolve: async () => secret === undefined ? undefined : { value: secret, source: 'test' } },
      webhookRuntime: { dispatch },
      aiopsTelemetry: { recordWebhook: telemetry },
      logger: { warn: warnings },
    } as unknown as Context,
    dispatch,
    warnings,
    telemetry,
  }
}

async function serve(ctx: Context, maxBodyBytes = 4096): Promise<string> {
  const handler = createAlertmanagerWebhookHandler(ctx, {
    source: 'primary-alertmanager',
    secretEnv: credentialRef('AIOPS_ALERTMANAGER_WEBHOOK_SECRET'),
    maxBodyBytes,
    maxAlerts: 10,
    maxMapEntries: 20,
    maxTextChars: 1000,
  })
  const server = createServer((request, response) => { void handler(request, response) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function post(
  url: string,
  payload: string,
  options: { auth?: string; contentType?: string; deliveryId?: string; method?: string } = {},
): Promise<Response> {
  return await fetch(url, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': options.contentType ?? 'application/json',
      authorization: options.auth ?? 'Bearer secret',
      ...(options.deliveryId === undefined ? {} : { 'x-dsh-delivery-id': options.deliveryId }),
    },
    ...(options.method === 'GET' ? {} : { body: payload }),
  })
}

describe('Alertmanager webhook HTTP handler', () => {
  it('authenticates, normalizes, dispatches, and answers 202', async () => {
    const fake = fakeContext()
    const response = await post(await serve(fake.ctx), body(), { deliveryId: 'delivery-1' })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
    expect(fake.dispatch).toHaveBeenCalledOnce()
    expect(fake.telemetry).toHaveBeenCalledWith('accepted')
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: 'alertmanager',
      source: 'primary-alertmanager',
      deliveryId: 'delivery-1',
      event: { version: 1, alerts: [{ fingerprint: '0123456789abcdef' }] },
    })
  })

  it('derives a replay-stable delivery id when the optional header is absent', async () => {
    const fake = fakeContext()
    const url = await serve(fake.ctx)
    expect((await post(url, body())).status).toBe(202)
    expect((await post(url, body())).status).toBe(202)
    const first = fake.dispatch.mock.calls[0]?.[0] as { deliveryId: string }
    const second = fake.dispatch.mock.calls[1]?.[0] as { deliveryId: string }
    expect(first.deliveryId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(second.deliveryId).toBe(first.deliveryId)
  })

  it.each([
    ['wrong method', { method: 'GET' }, 405],
    ['wrong content type', { contentType: 'text/plain' }, 415],
    ['wrong credential', { auth: 'Bearer wrong' }, 401],
    ['invalid delivery id', { deliveryId: 'bad value' }, 400],
  ] as const)('rejects %s before dispatch', async (_name, options, status) => {
    const fake = fakeContext()
    const response = await post(await serve(fake.ctx), body(), options)
    expect(response.status).toBe(status)
    expect(fake.dispatch).not.toHaveBeenCalled()
    expect(fake.telemetry).toHaveBeenCalledWith(status === 401 ? 'authentication_failed' : 'rejected')
  })

  it('rejects unavailable credentials, oversized bodies, and invalid payloads', async () => {
    const missing = fakeContext('')
    expect((await post(await serve(missing.ctx), body())).status).toBe(503)
    const oversized = fakeContext()
    expect((await post(await serve(oversized.ctx, 2), body())).status).toBe(413)
    const malformed = fakeContext()
    expect((await post(await serve(malformed.ctx), '{}')).status).toBe(400)
  })

  it('maps synchronous runtime refusal to a payload-free 503 diagnostic', async () => {
    const fake = fakeContext()
    fake.dispatch.mockImplementation(() => { throw new Error('closed') })
    const response = await post(await serve(fake.ctx), body())
    expect(response.status).toBe(503)
    expect(fake.telemetry).toHaveBeenCalledWith('dispatch_failed')
    expect(fake.warnings).toHaveBeenCalledWith('webhook-alertmanager: dispatch unavailable')
    expect(JSON.stringify(fake.warnings.mock.calls)).not.toContain('pod restarts')
  })
})
