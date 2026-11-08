import { brandString } from '@deepseek-ai/dsh-brand'
import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { appendPluginRecord, Session, type SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { apply, renderDeliveryMessage } from '../src/index.ts'
import type { AiopsDeliveryRecord } from '../src/types.ts'

const WEBHOOK_URL = 'https://im-hook.test/token'

function incident(overrides: Partial<AiopsIncidentState> = {}): AiopsIncidentState {
  return {
    version: 1,
    incidentId: 'incident-1' as never,
    title: 'API latency on checkout',
    severity: 'critical',
    status: 'investigating',
    evidence: [],
    hypotheses: [{ summary: 'database saturation', confidence: 'strong', evidenceIds: [] as never[] }],
    recommendations: [],
    ...overrides,
  }
}

function deliveryMarkers(session: Session): AiopsDeliveryRecord[] {
  return session.snapshotEvents()
    .map(event => event.type === 'plugin:aiops/delivery' && event.ignorable === true
      ? event.data as AiopsDeliveryRecord
      : undefined)
    .filter((value): value is AiopsDeliveryRecord => value !== undefined)
}

interface HarnessOptions {
  readonly config?: Partial<Parameters<typeof apply>[1]>
  /** `null` resolves no credential; a string is the credential value. */
  readonly credential?: string | null
  readonly fetchImpl?: typeof globalThis.fetch
  readonly flushOk?: boolean
}

function composeHarness(options: HarnessOptions = {}) {
  const session = Session.create(brandString<SessionId>('aiops-session-1'))
  const listeners: Array<(session: Session, key: string, value: unknown, seq: number) => void> = []
  const flush = vi.fn(async () => options.flushOk ?? true)
  const credential = options.credential === undefined ? WEBHOOK_URL : options.credential
  const resolve = vi.fn(async () => credential === null
    ? undefined
    : { value: credential } as never)
  const fetchMock = options.fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const sessionQuery = {
    listEvents: vi.fn(async () => session.snapshotEvents().map(event => ({
      sessionId: session.id,
      seq: event.seq,
      time: event.time,
      type: event.type,
    }))),
    readEvent: vi.fn(async ({ seq }: { seq: number }) => {
      const target = session.snapshotEvents().find(event => event.seq === seq)
      if (target === undefined) throw new Error(`no event at seq ${seq}`)
      return { session, target }
    }),
  }
  const ctx = {
    credentials: { resolve },
    sessionProjections: {
      onChanged: vi.fn((listener: (typeof listeners)[number]) => {
        listeners.push(listener)
        return () => {}
      }),
    },
    sessionQuery,
    sessions: { flush },
    logger,
    effect: (setup: () => unknown) => setup(),
  }
  apply(ctx as never, { webhookUrlEnv: 'AIOPS_DELIVERY_WEBHOOK_URL', ...options.config }, fetchMock)
  return { session, listener: listeners[0]!, fetchMock, flush, resolve, logger }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40))

describe('aiops-delivery message renderers', () => {
  it('renders a Feishu interactive card bounded in length', () => {
    const message = renderDeliveryMessage('feishu', incident(), { sessionId: 'aiops-session-1', reportSeq: 7, portalUrl: 'https://portal.example.test/aiops/' })
    expect(message.title).toContain('[AIOps]')
    const payload = JSON.parse(message.body) as {
      msg_type: string
      card: { header: { template: string; title: { content: string } }; elements: Array<{ tag: string; text?: { content: string }; actions?: Array<{ url: string }> }> }
    }
    expect(payload.msg_type).toBe('interactive')
    expect(payload.card.header.template).toBe('red')
    expect(payload.card.header.title.content).toContain('API latency on checkout')
    const markdown = payload.card.elements.find(element => element.tag === 'div')?.text?.content ?? ''
    expect(markdown).toContain('**Severity:** critical')
    expect(markdown).toContain('**Top hypothesis:** database saturation')
    const action = payload.card.elements.find(element => element.tag === 'action')
    expect(action?.actions?.[0]).toMatchObject({ url: 'https://portal.example.test/aiops/' })
  })

  it('omits the portal action and renders info severity for Feishu', () => {
    const message = renderDeliveryMessage('feishu', incident({ severity: 'info' }), { sessionId: 's', reportSeq: 1 })
    const payload = JSON.parse(message.body) as { card: { header: { template: string }; elements: Array<{ tag: string }> } }
    expect(payload.card.header.template).toBe('blue')
    expect(payload.card.elements.some(element => element.tag === 'action')).toBe(false)
  })

  it('renders DingTalk markdown and Slack text', () => {
    const dingtalk = renderDeliveryMessage('dingtalk', incident({ severity: 'warning' }), { sessionId: 's', reportSeq: 2, portalUrl: 'https://portal.example.test/aiops/' })
    const dingtalkPayload = JSON.parse(dingtalk.body) as { msgtype: string; markdown: { title: string; text: string } }
    expect(dingtalkPayload.msgtype).toBe('markdown')
    expect(dingtalkPayload.markdown.title).toBe('[AIOps][WARNING] API latency on checkout')
    expect(dingtalkPayload.markdown.text).toContain('### ⚠️')
    expect(dingtalkPayload.markdown.text).toContain('[Open AIOps Portal](https://portal.example.test/aiops/)')

    const slack = renderDeliveryMessage('slack', incident({ severity: 'warning' }), { sessionId: 's', reportSeq: 2, portalUrl: 'https://portal.example.test/aiops/' })
    const slackPayload = JSON.parse(slack.body) as { text: string }
    expect(slackPayload.text).toContain('*⚠️ [AIOps][WARNING] API latency on checkout*')
    expect(slackPayload.text).toContain('<https://portal.example.test/aiops/|Open AIOps Portal>')
  })

  it('clamps oversized titles and hypothesis summaries', () => {
    const long = 'x'.repeat(400)
    const message = renderDeliveryMessage('slack', incident({ title: long, hypotheses: [{ summary: long, confidence: 'confirmed', evidenceIds: [] as never[] }] }), { sessionId: 's', reportSeq: 3 })
    const payload = JSON.parse(message.body) as { text: string }
    expect(payload.text.length).toBeLessThan(1200)
    expect(payload.text).toContain('…')
  })
})

describe('aiops-delivery push decisions', () => {
  it('ships an importable Loader entry', async () => {
    const entry = await import('../lib/index.js')
    expect(entry).toMatchObject({ name: 'aiops-delivery' })
    expect(typeof entry.apply).toBe('function')
    expect(typeof entry.Config).toBe('function')
  })

  it('delivers the first report and records a durable delivered marker', async () => {
    const harness = composeHarness({ config: { portalBaseUrl: 'https://portal.example.test/aiops/' } })
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(harness.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe(WEBHOOK_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    const payload = JSON.parse(String(init.body)) as { msg_type: string }
    expect(payload.msg_type).toBe('interactive')
    const marker = deliveryMarkers(harness.session)[0]!
    expect(marker).toMatchObject({
      version: 1,
      incidentId: 'incident-1',
      reportSeq: 7,
      provider: 'feishu',
      outcome: 'delivered',
    })
    expect(marker.deliveryId).toMatch(/^delivery-/)
    expect(typeof marker.deliveredAt).toBe('number')
    expect(harness.flush).toHaveBeenCalled()
  })

  it('gates below-threshold reports and pushes once severity escalates', async () => {
    const harness = composeHarness({ config: { minSeverity: 'critical' } })
    harness.listener(harness.session, 'aiopsIncident', incident({ severity: 'warning' }), 4)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(deliveryMarkers(harness.session)).toHaveLength(0)
    harness.listener(harness.session, 'aiopsIncident', incident(), 5)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(harness.fetchMock).toHaveBeenCalledOnce()
  })

  it('never re-pushes after a delivered marker', async () => {
    const harness = composeHarness()
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    appendPluginRecord(harness.session, 'plugin:aiops/incident-state', incident({ title: 'Updated diagnosis' }))
    harness.listener(harness.session, 'aiopsIncident', incident({ title: 'Updated diagnosis' }), 8)
    await settle()
    expect(harness.fetchMock).toHaveBeenCalledOnce()
    expect(deliveryMarkers(harness.session)).toHaveLength(1)
  })

  it('records one failed marker after exhausting the attempt burst', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const harness = composeHarness({ config: { maxAttempts: 3, retryBackoffMs: 1 }, fetchImpl })
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(deliveryMarkers(harness.session)[0]).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('http_error'),
    })
    expect(harness.logger.error).toHaveBeenCalled()
  })

  it('treats provider rejections as failures', async () => {
    const feishu = composeHarness({
      config: { retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: 9_999_999, msg: 'invalid token' }), { status: 200 })),
    })
    feishu.listener(feishu.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(feishu.session).length).toBe(1))
    expect(deliveryMarkers(feishu.session)[0]?.reason).toContain('provider_error')

    const dingtalk = composeHarness({
      config: { provider: 'dingtalk' as const, retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })),
    })
    dingtalk.listener(dingtalk.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(dingtalk.session).length).toBe(1))
    expect(deliveryMarkers(dingtalk.session)[0]).toMatchObject({ outcome: 'delivered', provider: 'dingtalk' })

    const slack = composeHarness({
      config: { provider: 'slack' as const, retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response('not ok', { status: 200 })),
    })
    slack.listener(slack.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(slack.session).length).toBe(1))
    expect(deliveryMarkers(slack.session)[0]?.reason).toContain('provider_error')
  })

  it('accepts a Slack ok body as delivered', async () => {
    const harness = composeHarness({
      config: { provider: 'slack' as const },
      fetchImpl: vi.fn(async () => new Response('ok', { status: 200 })),
    })
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(deliveryMarkers(harness.session)[0]).toMatchObject({ outcome: 'delivered', provider: 'slack' })
  })

  it('records a timeout failure for a hanging webhook', async () => {
    const hangingFetch = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof globalThis.fetch
    const harness = composeHarness({ config: { timeoutMs: 50, maxAttempts: 1, retryBackoffMs: 1 }, fetchImpl: hangingFetch })
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(deliveryMarkers(harness.session)[0]?.reason).toContain('timeout')
  })

  it('skips silently when the webhook URL is missing or invalid', async () => {
    const missing = composeHarness({ credential: null })
    missing.listener(missing.session, 'aiopsIncident', incident(), 7)
    await settle()
    expect(missing.fetchMock).not.toHaveBeenCalled()
    expect(deliveryMarkers(missing.session)).toHaveLength(0)
    expect(missing.logger.warn).toHaveBeenCalled()

    const plainHttp = composeHarness({ credential: 'http://im-hook.test/token' })
    plainHttp.listener(plainHttp.session, 'aiopsIncident', incident(), 7)
    await settle()
    expect(plainHttp.fetchMock).not.toHaveBeenCalled()

    const embedded = composeHarness({ credential: 'https://user:pass@im-hook.test/token' })
    embedded.listener(embedded.session, 'aiopsIncident', incident(), 7)
    await settle()
    expect(embedded.fetchMock).not.toHaveBeenCalled()

    const unconfigured = composeHarness({ config: { webhookUrlEnv: '' } })
    unconfigured.listener(unconfigured.session, 'aiopsIncident', incident(), 7)
    await settle()
    expect(unconfigured.resolve).not.toHaveBeenCalled()
    expect(unconfigured.fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the webhook URL through the credential reference', async () => {
    const harness = composeHarness()
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(deliveryMarkers(harness.session).length).toBe(1))
    expect(harness.resolve).toHaveBeenCalledWith(expect.objectContaining({}))
  })

  it('logs a persistence failure without throwing', async () => {
    const harness = composeHarness({ flushOk: false })
    harness.listener(harness.session, 'aiopsIncident', incident(), 7)
    await vi.waitFor(() => expect(harness.logger.error).toHaveBeenCalled())
    expect(deliveryMarkers(harness.session)).toHaveLength(0)
  })

  it('rejects invalid portal and numeric configuration at load', () => {
    expect(() => composeHarness({ config: { portalBaseUrl: 'ftp://portal.example.test' } })).toThrow()
    expect(() => composeHarness({ config: { portalBaseUrl: 'https://u:p@portal.example.test' } })).toThrow()
    expect(() => composeHarness({ config: { maxAttempts: 0 } })).toThrow()
    expect(() => composeHarness({ config: { timeoutMs: 0 } })).toThrow()
    expect(() => composeHarness({ config: { webhookUrlEnv: 'not a name!' } })).toThrow()
  })
})
