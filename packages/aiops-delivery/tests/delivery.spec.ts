import type { AiopsIncidentRecord, AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { describe, expect, it, vi } from 'vitest'
import { apply, renderDeliveryMessage } from '../src/index.ts'
import type { AiopsDeliveryRecord } from '../src/types.ts'

const WEBHOOK_URL = 'https://im-hook.test/token'
const SESSION_ID = 'aiops-session-1'

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

/** In-memory stand-in for one opened storage domain with a `markers` table. */
function fakeStorageDomain(failPuts = false) {
  const records = new Map<string, unknown>()
  const openCalls: number[] = []
  return {
    records,
    openCalls,
    open: async () => {
      openCalls.push(1)
      return {
        table: (name: string) => (name === 'markers'
          ? {
            get: (key: string) => records.get(key),
            put: async (key: string, value: unknown) => {
              if (failPuts) throw new Error('medium is read-only')
              records.set(key, value)
            },
          }
          : undefined),
        close: async () => {},
      }
    },
  }
}

type FakeDomain = ReturnType<typeof fakeStorageDomain>

interface HarnessOptions {
  readonly config?: Partial<Parameters<typeof apply>[1]>
  /** `null` resolves no credential; a string is the credential value. */
  readonly credential?: string | null
  readonly fetchImpl?: typeof globalThis.fetch
  readonly failMarkerPuts?: boolean
  /** Reuse another harness's marker domain to model a restart. */
  readonly sharedDomain?: FakeDomain
}

async function composeHarness(options: HarnessOptions = {}) {
  const credential = options.credential === undefined ? WEBHOOK_URL : options.credential
  const resolve = vi.fn(async () => credential === null
    ? undefined
    : { value: credential } as never)
  const fetchMock = options.fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }))
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const domain = options.sharedDomain ?? fakeStorageDomain(options.failMarkerPuts === true)
  const listeners: Array<(record: AiopsIncidentRecord) => void> = []
  const ctx = {
    credentials: { resolve },
    storageDomain: domain,
    aiopsIncidents: {
      onChanged: vi.fn((listener: (typeof listeners)[number]) => {
        listeners.push(listener)
        return () => {}
      }),
    },
    logger,
    effect: (setup: () => unknown) => {
      const dispose = setup()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  await apply(ctx as never, { webhookUrlEnv: 'AIOPS_DELIVERY_WEBHOOK_URL', ...options.config }, fetchMock)
  const emit = (revision: number, state: AiopsIncidentState = incident()) => {
    const record: AiopsIncidentRecord = { sessionId: SESSION_ID, workspace: '/ws', revision, updatedAt: Date.now(), incident: state }
    for (const listener of listeners) listener(record)
  }
  const markerOf = () => domain.records.get(SESSION_ID) as AiopsDeliveryRecord | undefined
  return { emit, domain, fetchMock, resolve, logger, markerOf }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40))

describe('aiops-delivery message renderers', () => {
  it('renders a Feishu interactive card bounded in length', () => {
    const message = renderDeliveryMessage('feishu', incident(), { sessionId: SESSION_ID, reportRevision: 7, portalUrl: 'https://portal.example.test/aiops/' })
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
    const message = renderDeliveryMessage('feishu', incident({ severity: 'info' }), { sessionId: 's', reportRevision: 1 })
    const payload = JSON.parse(message.body) as { card: { header: { template: string }; elements: Array<{ tag: string }> } }
    expect(payload.card.header.template).toBe('blue')
    expect(payload.card.elements.some(element => element.tag === 'action')).toBe(false)
  })

  it('renders DingTalk markdown and Slack text', () => {
    const dingtalk = renderDeliveryMessage('dingtalk', incident({ severity: 'warning' }), { sessionId: 's', reportRevision: 2, portalUrl: 'https://portal.example.test/aiops/' })
    const dingtalkPayload = JSON.parse(dingtalk.body) as { msgtype: string; markdown: { title: string; text: string } }
    expect(dingtalkPayload.msgtype).toBe('markdown')
    expect(dingtalkPayload.markdown.title).toBe('[AIOps][WARNING] API latency on checkout')
    expect(dingtalkPayload.markdown.text).toContain('### ⚠️')
    expect(dingtalkPayload.markdown.text).toContain('[Open AIOps Portal](https://portal.example.test/aiops/)')

    const slack = renderDeliveryMessage('slack', incident({ severity: 'warning' }), { sessionId: 's', reportRevision: 2, portalUrl: 'https://portal.example.test/aiops/' })
    const slackPayload = JSON.parse(slack.body) as { text: string }
    expect(slackPayload.text).toContain('*⚠️ [AIOps][WARNING] API latency on checkout*')
    expect(slackPayload.text).toContain('<https://portal.example.test/aiops/|Open AIOps Portal>')
  })

  it('clamps oversized titles and hypothesis summaries', () => {
    const long = 'x'.repeat(400)
    const message = renderDeliveryMessage('slack', incident({ title: long, hypotheses: [{ summary: long, confidence: 'confirmed', evidenceIds: [] as never[] }] }), { sessionId: 's', reportRevision: 3 })
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
    const harness = await composeHarness({ config: { portalBaseUrl: 'https://portal.example.test/aiops/' } })
    harness.emit(7)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('delivered'))
    expect(harness.fetchMock).toHaveBeenCalledOnce()
    const [url, init] = harness.fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.href).toBe(WEBHOOK_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    const payload = JSON.parse(String(init.body)) as { msg_type: string }
    expect(payload.msg_type).toBe('interactive')
    expect(harness.markerOf()).toMatchObject({
      version: 1,
      sessionId: SESSION_ID,
      incidentId: 'incident-1',
      reportRevision: 7,
      provider: 'feishu',
      outcome: 'delivered',
    })
    expect(typeof harness.markerOf()?.deliveredAt).toBe('number')
  })

  it('gates below-threshold reports and pushes once severity escalates', async () => {
    const harness = await composeHarness({ config: { minSeverity: 'critical' } })
    harness.emit(4, incident({ severity: 'warning' }))
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(harness.markerOf()).toBeUndefined()
    harness.emit(5)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('delivered'))
    expect(harness.fetchMock).toHaveBeenCalledOnce()
  })

  it('never re-pushes after a delivered marker, even across a restart', async () => {
    const domain = fakeStorageDomain()
    const first = await composeHarness({ sharedDomain: domain })
    first.emit(7)
    await vi.waitFor(() => expect(first.markerOf()?.outcome).toBe('delivered'))
    first.emit(8, incident({ title: 'Updated diagnosis' }))
    await settle()
    expect(first.fetchMock).toHaveBeenCalledOnce()

    // A restarted subscriber reads the same durable marker and stays silent.
    const second = await composeHarness({ sharedDomain: domain })
    second.emit(9, incident({ title: 'Updated diagnosis' }))
    await settle()
    expect(second.fetchMock).not.toHaveBeenCalled()
    expect(second.domain.records.size).toBe(1)
  })

  it('records one failed marker after exhausting the attempt burst', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }))
    const harness = await composeHarness({ config: { maxAttempts: 3, retryBackoffMs: 1 }, fetchImpl })
    harness.emit(7)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('failed'))
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(harness.markerOf()).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('http_error'),
    })
    expect(harness.logger.error).toHaveBeenCalled()
  })

  it('treats provider rejections as failures', async () => {
    const feishu = await composeHarness({
      config: { retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: 9_999_999, msg: 'invalid token' }), { status: 200 })),
    })
    feishu.emit(7)
    await vi.waitFor(() => expect(feishu.markerOf()?.outcome).toBe('failed'))
    expect(feishu.markerOf()?.reason).toContain('provider_error')

    const dingtalk = await composeHarness({
      config: { provider: 'dingtalk' as const, retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ errcode: 0 }), { status: 200 })),
    })
    dingtalk.emit(7)
    await vi.waitFor(() => expect(dingtalk.markerOf()?.outcome).toBe('delivered'))
    expect(dingtalk.markerOf()).toMatchObject({ outcome: 'delivered', provider: 'dingtalk' })

    const slack = await composeHarness({
      config: { provider: 'slack' as const, retryBackoffMs: 1 },
      fetchImpl: vi.fn(async () => new Response('not ok', { status: 200 })),
    })
    slack.emit(7)
    await vi.waitFor(() => expect(slack.markerOf()?.outcome).toBe('failed'))
    expect(slack.markerOf()?.reason).toContain('provider_error')
  })

  it('accepts a Slack ok body as delivered', async () => {
    const harness = await composeHarness({
      config: { provider: 'slack' as const },
      fetchImpl: vi.fn(async () => new Response('ok', { status: 200 })),
    })
    harness.emit(7)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('delivered'))
    expect(harness.markerOf()).toMatchObject({ outcome: 'delivered', provider: 'slack' })
  })

  it('records a timeout failure for a hanging webhook', async () => {
    const hangingFetch = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof globalThis.fetch
    const harness = await composeHarness({ config: { timeoutMs: 50, maxAttempts: 1, retryBackoffMs: 1 }, fetchImpl: hangingFetch })
    harness.emit(7)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('failed'))
    expect(harness.markerOf()?.reason).toContain('timeout')
  })

  it('skips silently when the webhook URL is missing or invalid', async () => {
    const missing = await composeHarness({ credential: null })
    missing.emit(7)
    await settle()
    expect(missing.fetchMock).not.toHaveBeenCalled()
    expect(missing.markerOf()).toBeUndefined()
    expect(missing.logger.warn).toHaveBeenCalled()

    const plainHttp = await composeHarness({ credential: 'http://im-hook.test/token' })
    plainHttp.emit(7)
    await settle()
    expect(plainHttp.fetchMock).not.toHaveBeenCalled()

    const embedded = await composeHarness({ credential: 'https://user:pass@im-hook.test/token' })
    embedded.emit(7)
    await settle()
    expect(embedded.fetchMock).not.toHaveBeenCalled()

    const unconfigured = await composeHarness({ config: { webhookUrlEnv: '' } })
    unconfigured.emit(7)
    await settle()
    expect(unconfigured.resolve).not.toHaveBeenCalled()
    expect(unconfigured.fetchMock).not.toHaveBeenCalled()
  })

  it('resolves the webhook URL through the credential reference', async () => {
    const harness = await composeHarness()
    harness.emit(7)
    await vi.waitFor(() => expect(harness.markerOf()?.outcome).toBe('delivered'))
    expect(harness.resolve).toHaveBeenCalledWith(expect.objectContaining({}))
  })

  it('logs a marker persistence failure without throwing', async () => {
    const harness = await composeHarness({ failMarkerPuts: true })
    harness.emit(7)
    await vi.waitFor(() => expect(harness.logger.error).toHaveBeenCalled())
    expect(harness.markerOf()).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects invalid portal and numeric configuration at load', async () => {
    await expect(composeHarness({ config: { portalBaseUrl: 'ftp://portal.example.test' } })).rejects.toThrow()
    await expect(composeHarness({ config: { portalBaseUrl: 'https://u:p@portal.example.test' } })).rejects.toThrow()
    await expect(composeHarness({ config: { maxAttempts: 0 } })).rejects.toThrow()
    await expect(composeHarness({ config: { timeoutMs: 0 } })).rejects.toThrow()
    await expect(composeHarness({ config: { webhookUrlEnv: 'not a name!' } })).rejects.toThrow()
  })
})
