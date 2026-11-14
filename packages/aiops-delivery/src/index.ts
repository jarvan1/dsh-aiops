/**
 * Push completed AIOps diagnoses to IM incoming webhooks (Feishu, DingTalk, Slack).
 * @module @deepseek-ai/dsh-aiops-delivery
 */

import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { clampText, renderDeliveryMessage } from './templates.ts'
import type { DeliveryMessage } from './templates.ts'
import type { AiopsDeliveryProvider, AiopsDeliveryRecord } from './types.ts'

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
export const inject = ['aiopsIncidents', 'credentials', 'storageDomain']

/** Storage-domain record schema for the `markers` table. */
const markerRecordSchema = zod.object({
  version: zod.literal(1),
  sessionId: zod.string().min(1).max(256),
  incidentId: zod.string().min(1).max(128),
  reportRevision: zod.number().int().positive().safe(),
  provider: zod.enum(['feishu', 'dingtalk', 'slack']),
  outcome: zod.enum(['delivered', 'failed']),
  reason: zod.string().max(400).optional(),
  deliveredAt: zod.number().int().nonnegative().safe(),
}).strict()

/**
 * One `aiops_delivery` domain: the latest terminal push decision per Session.
 * A `delivered` marker suppresses every later attempt for that Session; a
 * `failed` marker is replaced by the next attempt burst.
 */
export const aiopsDeliveryDomainSpec = defineDomain({
  name: 'aiops_delivery',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    markers: domainTable<string, zod.infer<typeof markerRecordSchema>>(markerRecordSchema),
  },
})

/** The marker store's public surface; in-memory fakes implement the same shape. */
export interface AiopsMarkerStoreApi {
  /** Latest terminal decision for one Session, or undefined when never attempted. */
  get(sessionId: string): AiopsDeliveryRecord | undefined
  /** Persist one terminal decision durably. */
  put(record: AiopsDeliveryRecord): Promise<void>
}

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
  /**
   * DingTalk only: credential-reference name holding the bot's signing secret
   * (`SEC...`). Leave empty to use DingTalk's keyword security mode instead.
   */
  signSecretEnv?: string
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
  signSecretEnv: z.string().role('credential-ref').default(''),
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
  readonly signSecretEnv: string
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
  const signSecretEnv = config.signSecretEnv?.trim() ?? ''
  const minSeverity = config.minSeverity ?? 'warning'
  const timeoutMs = config.timeoutMs ?? 10_000
  const maxAttempts = config.maxAttempts ?? 2
  const retryBackoffMs = config.retryBackoffMs ?? 2_000
  const maxResponseBytes = config.maxResponseBytes ?? 65_536
  if (webhookUrlEnv !== '' && !isCredentialRefName(webhookUrlEnv)) {
    throw new AiopsDeliveryError('invalid_request', `aiops-delivery: webhookUrlEnv "${webhookUrlEnv}" is not a valid credential-reference name.`)
  }
  if (signSecretEnv !== '' && !isCredentialRefName(signSecretEnv)) {
    throw new AiopsDeliveryError('invalid_request', `aiops-delivery: signSecretEnv "${signSecretEnv}" is not a valid credential-reference name.`)
  }
  if (signSecretEnv !== '' && provider !== 'dingtalk') {
    throw new AiopsDeliveryError('invalid_request', 'aiops-delivery: signSecretEnv is only supported for the dingtalk provider.')
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
    signSecretEnv,
    minSeverity,
    portalBaseUrl,
    timeoutMs,
    maxAttempts,
    retryBackoffMs,
    maxResponseBytes,
  }
}

/**
 * DingTalk security mode for one delivery: no signature (keyword mode), the
 * signing secret, or disabled because the configured secret is unusable.
 */
type Signing =
  | { readonly kind: 'none' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'secret'; readonly secret: string }

/**
 * Append DingTalk's `timestamp` and HMAC-SHA256 signature to a webhook URL.
 * The signature covers `timestamp + "\n" + secret`; the secret itself never
 * appears in the URL.
 */
export function signedDingtalkUrl(webhookUrl: URL, secret: string, timestampMs: number = Date.now()): URL {
  const timestamp = String(timestampMs)
  const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  const signed = new URL(webhookUrl)
  signed.searchParams.set('timestamp', timestamp)
  signed.searchParams.set('sign', sign)
  return signed
}

/** One pending or coalesced push decision. */
interface Work {
  readonly sessionId: string
  readonly incident: AiopsIncidentState
  readonly reportRevision: number
}

/** Register the incident change subscription that drives IM delivery. */
export async function apply(
  ctx: Context,
  config: Config,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const settings = resolveConfig(config)
  let disposed = false
  const lifetime = new AbortController()
  const inFlight = new Map<string, { dirty: boolean; next: Work | undefined }>()
  const delivered = new Set<string>()
  const warned = new Set<string>()

  const domain: Domain<DomainSpec> = await ctx.storageDomain.open(aiopsDeliveryDomainSpec)
  ctx.effect(() => () => void domain.close(), 'aiops-delivery: domainClose')
  const markers: AiopsMarkerStoreApi = {
    get: sessionId => {
      const record = (domain.table('markers') as KvTable<string, zod.infer<typeof markerRecordSchema>>).get(sessionId)
      if (record === undefined) return undefined
      const { reason, ...rest } = record
      // Stored plain-string identity is re-branded for the public record type.
      return {
        ...rest,
        incidentId: record.incidentId as AiopsDeliveryRecord['incidentId'],
        ...(reason === undefined ? {} : { reason }),
      }
    },
    put: async record => {
      await (domain.table('markers') as KvTable<string, zod.infer<typeof markerRecordSchema>>)
        .put(record.sessionId, markerRecordSchema.parse(record))
    },
  }

  ctx.effect(() => ctx.aiopsIncidents.onChanged(record => {
    if (disposed) return
    schedule({ sessionId: record.sessionId, incident: record.incident, reportRevision: record.revision })
  }), 'aiops-delivery: subscribe')

  ctx.effect(() => () => {
    disposed = true
    lifetime.abort()
    inFlight.clear()
    delivered.clear()
    warned.clear()
  }, 'aiops-delivery: dispose')

  function schedule(work: Work): void {
    const key = work.sessionId
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
    const sessionId = work.sessionId
    if (disposed || delivered.has(sessionId)) return
    if (SEVERITY_RANK[work.incident.severity] < SEVERITY_RANK[settings.minSeverity]) return
    if (markers.get(sessionId)?.outcome === 'delivered') {
      delivered.add(sessionId)
      return
    }
    const url = await resolveWebhookUrl(sessionId)
    if (url === undefined) return
    const signing = await resolveSigning(sessionId)
    if (signing.kind === 'disabled') return
    const portalUrl = settings.portalBaseUrl?.href
    const message = renderDeliveryMessage(settings.provider, work.incident, {
      sessionId,
      reportRevision: work.reportRevision,
      ...(portalUrl === undefined ? {} : { portalUrl }),
    })
    const failure = await deliver(url, message, signing)
    if (disposed) return
    if (failure === undefined) {
      delivered.add(sessionId)
      await appendMarker(work, 'delivered')
      return
    }
    ctx.logger.error(`aiops-delivery: ${failure.message}`)
    await appendMarker(work, failure)
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

  /**
   * Resolve DingTalk's optional signing secret per delivery, so rotating it
   * needs no restart. Keyword mode is the absence of a configured secret; a
   * configured but unusable secret disables the push instead of sending a
   * message DingTalk will reject.
   */
  async function resolveSigning(sessionId: string): Promise<Signing> {
    if (settings.provider !== 'dingtalk' || settings.signSecretEnv === '') return { kind: 'none' }
    let secret = ''
    try {
      const credential = await ctx.credentials.resolve(credentialRef(settings.signSecretEnv))
      secret = credential?.value?.trim() ?? ''
    } catch (error: unknown) {
      warnOnce(sessionId, `credential "${settings.signSecretEnv}" could not be resolved; DingTalk delivery is disabled.`)
      ctx.logger.warn('aiops-delivery: DingTalk signing credential resolution failure.', error)
      return { kind: 'disabled' }
    }
    if (secret === '') {
      warnOnce(sessionId, `credential "${settings.signSecretEnv}" is empty or missing; DingTalk delivery is disabled.`)
      return { kind: 'disabled' }
    }
    return { kind: 'secret', secret }
  }

  async function deliver(url: URL, message: DeliveryMessage, signing: Signing): Promise<AiopsDeliveryError | undefined> {
    let lastError = new AiopsDeliveryError('transport', 'delivery was not attempted.')
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      if (disposed) return undefined
      try {
        const attemptUrl = signing.kind === 'secret' ? signedDingtalkUrl(url, signing.secret) : url
        await postOnce(attemptUrl, message.body)
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
      const data: AiopsDeliveryRecord = {
        version: 1,
        sessionId: work.sessionId,
        incidentId: work.incident.incidentId,
        reportRevision: work.reportRevision,
        provider: settings.provider,
        outcome: outcome === 'delivered' ? 'delivered' : 'failed',
        ...(outcome === 'delivered' ? {} : { reason: clampText(`${outcome.code}: ${outcome.message}`, MAX_REASON_CHARS) }),
        deliveredAt: Date.now(),
      }
      await markers.put(data)
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
