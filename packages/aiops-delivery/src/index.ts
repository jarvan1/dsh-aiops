/**
 * Push completed AIOps diagnoses to IM incoming webhooks (Feishu, DingTalk, Slack).
 * @module @deepseek-ai/dsh-aiops-delivery
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { clampText, renderDeliveryMessage } from './templates.ts'
import type { DeliveryMessage } from './templates.ts'
import type { AiopsDeliveryId, AiopsDeliveryProvider, AiopsDeliveryRecord } from './types.ts'

export type * from './types.ts'
export {
  clampText,
  renderDeliveryMessage,
  renderDingtalkDelivery,
  renderFeishuDelivery,
  renderSlackDelivery,
  topHypothesis,
} from './templates.ts'
export type { DeliveryMeta, DeliveryMessage } from './templates.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'aiops-delivery'

/** Services required to observe incident changes and persist audit markers. */
export const inject = ['credentials', 'sessionProjections', 'sessionQuery', 'sessions']

const DELIVERY_RECORD_TYPE = 'plugin:aiops/delivery'
const TIMEOUT_CODE = 'AIOPS_DELIVERY_TIMEOUT'
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const
const MAX_REASON_CHARS = 200
const MAX_WARNED_SESSIONS = 1000

/** Diagnosis push configuration. */
export interface Config {
  /** Target IM incoming-webhook family. Defaults to `feishu`. */
  provider?: AiopsDeliveryProvider
  /**
   * Credential-reference name (environment variable) holding the IM webhook
   * URL. The URL itself never enters the committed patch or settings store.
   */
  webhookUrlEnv?: string
  /** Lowest severity that is pushed. Defaults to `warning`. */
  minSeverity?: 'info' | 'warning' | 'critical'
  /** Absolute Portal base URL rendered as the message deep link. */
  portalBaseUrl?: string
  /** Per-request deadline in milliseconds. Defaults to 10000. */
  timeoutMs?: number
  /** Delivery attempts per report, including the first. Defaults to 2. */
  maxAttempts?: number
  /** Fixed backoff between attempts in milliseconds. Defaults to 2000. */
  retryBackoffMs?: number
  /** Maximum complete response body size in bytes. Defaults to 65536. */
  maxResponseBytes?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  provider: z.union(['feishu', 'dingtalk', 'slack'] as const).default('feishu'),
  webhookUrlEnv: z.string().role('credential-ref').default(''),
  minSeverity: z.union(['info', 'warning', 'critical'] as const).default('warning'),
  portalBaseUrl: z.string().default(''),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  maxAttempts: z.number().step(1).min(1).max(5).default(2),
  retryBackoffMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(2_000),
  maxResponseBytes: z.number().step(1).min(1).max(1_000_000).default(65_536),
})

/** Stable failure returned by the delivery capability. */
export class AiopsDeliveryError extends Error {
  /** Failure class used by the audit marker and operator logs. */
  readonly code: 'invalid_request' | 'http_error' | 'provider_error' | 'response_too_large' | 'timeout' | 'transport'

  /**
   * Create one contained delivery failure.
   * @param code - stable failure class.
   * @param message - operator-safe diagnostic.
   * @param cause - optional transport or parser failure.
   */
  constructor(code: AiopsDeliveryError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AiopsDeliveryError'
    this.code = code
  }
}

interface ResolvedConfig {
  readonly provider: AiopsDeliveryProvider
  readonly webhookUrlEnv: string
  readonly minSeverity: 'info' | 'warning' | 'critical'
  readonly portalBaseUrl: URL | undefined
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly retryBackoffMs: number
  readonly maxResponseBytes: number
}

function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'feishu'
  const webhookUrlEnv = config.webhookUrlEnv?.trim() ?? ''
  const minSeverity = config.minSeverity ?? 'warning'
  const timeoutMs = config.timeoutMs ?? 10_000
  const maxAttempts = config.maxAttempts ?? 2
  const retryBackoffMs = config.retryBackoffMs ?? 2_000
  const maxResponseBytes = config.maxResponseBytes ?? 65_536
  if (webhookUrlEnv !== '' && !isCredentialRefName(webhookUrlEnv)) {
    throw new AiopsDeliveryError('invalid_request', `aiops-delivery: webhookUrlEnv "${webhookUrlEnv}" is not a valid credential-reference name.`)
  }
  let portalBaseUrl: URL | undefined
  const rawPortalBaseUrl = config.portalBaseUrl?.trim() ?? ''
  if (rawPortalBaseUrl !== '') {
    try {
      portalBaseUrl = new URL(rawPortalBaseUrl)
    } catch (error: unknown) {
      throw new AiopsDeliveryError('invalid_request', 'aiops-delivery: portalBaseUrl must be an absolute URL.', error)
    }
    if ((portalBaseUrl.protocol !== 'http:' && portalBaseUrl.protocol !== 'https:')
      || portalBaseUrl.username !== '' || portalBaseUrl.password !== ''
      || portalBaseUrl.search !== '' || portalBaseUrl.hash !== '') {
      throw new AiopsDeliveryError(
        'invalid_request',
        'aiops-delivery: portalBaseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
      )
    }
    if (!portalBaseUrl.pathname.endsWith('/')) portalBaseUrl.pathname += '/'
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new AiopsDeliveryError('invalid_request', `aiops-delivery: timeoutMs must be within 1..${MAX_TIMER_DELAY_MS}.`)
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new AiopsDeliveryError('invalid_request', 'aiops-delivery: maxAttempts must be an integer within 1..5.')
  }
  if (!Number.isSafeInteger(retryBackoffMs) || retryBackoffMs <= 0 || retryBackoffMs > MAX_TIMER_DELAY_MS) {
    throw new AiopsDeliveryError('invalid_request', `aiops-delivery: retryBackoffMs must be within 1..${MAX_TIMER_DELAY_MS}.`)
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new AiopsDeliveryError('invalid_request', 'aiops-delivery: maxResponseBytes must be a positive safe integer.')
  }
  return {
    provider,
    webhookUrlEnv,
    minSeverity,
    portalBaseUrl,
    timeoutMs,
    maxAttempts,
    retryBackoffMs,
    maxResponseBytes,
  }
}

/** One pending or coalesced push decision. */
interface Work {
  readonly session: Session
  readonly incident: AiopsIncidentState
  readonly reportSeq: number
}

/** Register the incident change subscription that drives IM delivery. */
export function apply(ctx: Context, config: Config, fetchImpl: typeof globalThis.fetch = globalThis.fetch): void {
  const settings = resolveConfig(config)
  let disposed = false
  const lifetime = new AbortController()
  const inFlight = new Map<string, { dirty: boolean; next: Work | undefined }>()
  const delivered = new Set<string>()
  const warned = new Set<string>()

  ctx.effect(() => ctx.sessionProjections.onChanged((session, key, value, seq) => {
    if (disposed || key !== 'aiopsIncident' || value === null || value === undefined) return
    schedule({ session, incident: value as AiopsIncidentState, reportSeq: Number(seq) })
  }), 'aiops-delivery: subscribe')

  ctx.effect(() => () => {
    disposed = true
    lifetime.abort()
    inFlight.clear()
    delivered.clear()
    warned.clear()
  }, 'aiops-delivery: dispose')

  function schedule(work: Work): void {
    const key = String(work.session.id)
    const pending = inFlight.get(key)
    if (pending !== undefined) {
      pending.dirty = true
      pending.next = work
      return
    }
    const record = { dirty: false, next: undefined as Work | undefined }
    inFlight.set(key, record)
    void evaluate(work)
      .catch((error: unknown) => ctx.logger.error('aiops-delivery: unexpected evaluation failure.', error))
      .finally(() => {
        inFlight.delete(key)
        if (!disposed && record.dirty && record.next !== undefined) schedule(record.next)
      })
  }

  async function evaluate(work: Work): Promise<void> {
    const sessionId = String(work.session.id)
    if (disposed || delivered.has(sessionId)) return
    if (SEVERITY_RANK[work.incident.severity] < SEVERITY_RANK[settings.minSeverity]) return
    if (await hasDeliveredMarker(work.session.id)) {
      delivered.add(sessionId)
      return
    }
    const url = await resolveWebhookUrl(sessionId)
    if (url === undefined) return
    const portalUrl = settings.portalBaseUrl?.href
    const message = renderDeliveryMessage(settings.provider, work.incident, {
      sessionId,
      reportSeq: work.reportSeq,
      ...(portalUrl === undefined ? {} : { portalUrl }),
    })
    const failure = await deliver(url, message)
    if (disposed) return
    if (failure === undefined) {
      delivered.add(sessionId)
      await appendMarker(work, 'delivered')
      return
    }
    ctx.logger.error(`aiops-delivery: ${failure.message}`)
    await appendMarker(work, failure)
  }

  async function hasDeliveredMarker(sessionId: SessionId): Promise<boolean> {
    const events = await ctx.sessionQuery.listEvents(sessionId)
    for (const hit of events) {
      if (hit.type !== (DELIVERY_RECORD_TYPE as typeof hit.type)) continue
      const window = await ctx.sessionQuery.readEvent({ sessionId, seq: hit.seq })
      const record = pluginRecordOf(window.target)
      if (record !== undefined && record.type === DELIVERY_RECORD_TYPE
        && (record.data as AiopsDeliveryRecord).outcome === 'delivered') {
        return true
      }
    }
    return false
  }

  async function resolveWebhookUrl(sessionId: string): Promise<URL | undefined> {
    if (settings.webhookUrlEnv === '') {
      warnOnce(sessionId, 'webhookUrlEnv is not configured; diagnosis delivery is disabled.')
      return undefined
    }
    let rawUrl = ''
    try {
      const credential = await ctx.credentials.resolve(credentialRef(settings.webhookUrlEnv))
      rawUrl = credential?.value?.trim() ?? ''
    } catch (error: unknown) {
      warnOnce(sessionId, `credential "${settings.webhookUrlEnv}" could not be resolved; diagnosis delivery is disabled.`)
      ctx.logger.warn('aiops-delivery: credential resolution failure.', error)
      return undefined
    }
    if (rawUrl === '') {
      warnOnce(sessionId, `credential "${settings.webhookUrlEnv}" is empty or missing; diagnosis delivery is disabled.`)
      return undefined
    }
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== 'https:' || url.hostname === ''
        || url.username !== '' || url.password !== '' || url.hash !== '') {
        throw new AiopsDeliveryError(
          'invalid_request',
          'The IM webhook URL must be an https URL without embedded credentials or fragment.',
        )
      }
      return url
    } catch {
      warnOnce(sessionId, 'the configured IM webhook URL is invalid; diagnosis delivery is disabled.')
      return undefined
    }
  }

  async function deliver(url: URL, message: DeliveryMessage): Promise<AiopsDeliveryError | undefined> {
    let lastError = new AiopsDeliveryError('transport', 'delivery was not attempted.')
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      if (disposed) return undefined
      try {
        await postOnce(url, message.body)
        return undefined
      } catch (error: unknown) {
        lastError = error instanceof AiopsDeliveryError
          ? error
          : new AiopsDeliveryError('transport', 'IM webhook request failed.', error)
        if (attempt < settings.maxAttempts && !disposed) await sleepOrAbort(settings.retryBackoffMs)
      }
    }
    return lastError
  }

  async function postOnce(url: URL, body: string): Promise<void> {
    using requestDeadline = deadline(lifetime.signal, settings.timeoutMs, TIMEOUT_CODE)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'error',
        signal: requestDeadline.signal,
      })
    } catch (error: unknown) {
      if (timeoutOf(requestDeadline.signal, TIMEOUT_CODE) !== undefined) {
        throw new AiopsDeliveryError('timeout', `IM webhook exceeded ${settings.timeoutMs}ms.`, error)
      }
      throw new AiopsDeliveryError('transport', 'IM webhook request failed.', error)
    }
    if (!response.ok) {
      throw new AiopsDeliveryError('http_error', `IM webhook returned HTTP ${response.status}.`)
    }
    validateProviderResponse(settings.provider, await readBounded(response))
  }

  async function readBounded(response: Response): Promise<string> {
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > settings.maxResponseBytes) {
      throw new AiopsDeliveryError('response_too_large', `IM webhook response exceeds ${settings.maxResponseBytes} bytes.`)
    }
    if (response.body === null) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let body = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > settings.maxResponseBytes) {
        await reader.cancel().catch(() => {})
        throw new AiopsDeliveryError('response_too_large', `IM webhook response exceeds ${settings.maxResponseBytes} bytes.`)
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  }

  async function sleepOrAbort(ms: number): Promise<void> {
    if (lifetime.signal.aborted) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      lifetime.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  async function appendMarker(work: Work, outcome: 'delivered' | AiopsDeliveryError): Promise<void> {
    try {
      if (!await ctx.sessions.flush(work.session)) {
        throw new Error('AIOps delivery persistence is uncertain; inspect the session before retrying.')
      }
      const data: AiopsDeliveryRecord = {
        version: 1,
        deliveryId: brandString<AiopsDeliveryId>(`delivery-${createHash('sha256')
          .update(`${String(work.session.id)}\0${work.reportSeq}\0${settings.provider}`)
          .digest('hex').slice(0, 32)}`),
        incidentId: work.incident.incidentId,
        reportSeq: work.reportSeq,
        provider: settings.provider,
        outcome: outcome === 'delivered' ? 'delivered' : 'failed',
        ...(outcome === 'delivered' ? {} : { reason: clampText(`${outcome.code}: ${outcome.message}`, MAX_REASON_CHARS) }),
        deliveredAt: Date.now(),
      }
      appendPluginRecord(work.session, 'plugin:aiops/delivery', data)
      if (!await ctx.sessions.flush(work.session)) {
        throw new Error('AIOps delivery persistence is uncertain; inspect the session before retrying.')
      }
    } catch (error: unknown) {
      ctx.logger.error('aiops-delivery: failed to persist the delivery marker.', error)
    }
  }

  function warnOnce(sessionId: string, message: string): void {
    if (warned.has(sessionId)) return
    if (warned.size >= MAX_WARNED_SESSIONS) warned.clear()
    warned.add(sessionId)
    ctx.logger.warn(`aiops-delivery: ${message} (session ${sessionId})`)
  }
}

function validateProviderResponse(provider: AiopsDeliveryProvider, body: string): void {
  if (provider === 'slack') {
    if (body.trim() !== 'ok') {
      throw new AiopsDeliveryError('provider_error', 'Slack webhook rejected the message.')
    }
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (error: unknown) {
    throw new AiopsDeliveryError('provider_error', `${provider} webhook returned invalid JSON.`, error)
  }
  const envelope = typeof parsed === 'object' && parsed !== null
    ? parsed as { readonly code?: unknown; readonly errcode?: unknown }
    : undefined
  if (provider === 'feishu') {
    if (envelope?.code !== 0) {
      throw new AiopsDeliveryError('provider_error', `Feishu webhook rejected the message (code ${String(envelope?.code)}).`)
    }
    return
  }
  if (envelope?.errcode !== 0) {
    throw new AiopsDeliveryError('provider_error', `DingTalk webhook rejected the message (errcode ${String(envelope?.errcode)}).`)
  }
}
