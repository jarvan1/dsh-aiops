/**
 * Read-only Alertmanager Service Definition and HTTP API Provider.
 * @module @deepseek-ai/dsh-aiops-alertmanager
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AiopsHttpReadError, readAiopsHttp } from '@deepseek-ai/dsh-aiops-http-read'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import type {
  AlertmanagerAlert,
  AlertmanagerAlertsRequest,
  AlertmanagerAlertsResult,
  AlertmanagerAlertsSpec,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    alertmanager: AlertmanagerRuntime
  }
}

const TIMEOUT_CODE = 'ALERTMANAGER_TIMEOUT'

/** HTTP Alertmanager Provider configuration. */
export interface Config {
  /** Alertmanager server base URL, including a deployment path prefix when used. */
  baseUrl?: string
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
  /** Maximum complete response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum combined count of alert and receiver-label matcher expressions. */
  maxFilterCount?: number
  /** Maximum characters in one matcher or receiver expression. */
  maxQueryValueChars?: number
}

/** Stable failure returned by the Alertmanager capability. */
export class AlertmanagerQueryError extends Error {
  /** Failure class used by tool Consumers. */
  readonly code: 'invalid_request' | 'http_error' | 'provider_error' | 'response_too_large' | 'timeout'

  /**
   * Create one contained Alertmanager query failure.
   * @param code - stable failure class.
   * @param message - operator-safe diagnostic.
   * @param cause - optional transport or parser failure.
   */
  constructor(code: AlertmanagerQueryError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AlertmanagerQueryError'
    this.code = code
  }
}

/** Provider-neutral read-only Alertmanager runtime. */
export abstract class AlertmanagerRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'alertmanager')
  }

  /**
   * Apply Provider-owned defaults and limits to a current-alert request.
   * @param request - optional alert state, label, and receiver filters.
   * @returns fully specified query for {@link alerts}.
   */
  abstract resolveAlerts(request: AlertmanagerAlertsRequest): AlertmanagerAlertsSpec

  /**
   * Read current alerts from Alertmanager API v2.
   * @param spec - fully resolved query from {@link resolveAlerts}.
   * @param signal - caller cancellation.
   * @returns detached current alert objects.
   */
  abstract alerts(spec: AlertmanagerAlertsSpec, signal?: AbortSignal): Promise<AlertmanagerAlertsResult>
}

interface ResolvedConfig {
  readonly baseUrl: URL | undefined
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxFilterCount: number
  readonly maxQueryValueChars: number
}

type Fetch = typeof globalThis.fetch

/** Read-only Provider backed by Alertmanager's `GET /api/v2/alerts` endpoint. */
export class AlertmanagerHttpRuntime extends AlertmanagerRuntime {
  static Config: z<Config> = z.object({
    baseUrl: z.string().default(''),
    timeoutMs: z.number().default(30_000),
    maxResponseBytes: z.number().default(2_000_000),
    maxFilterCount: z.number().default(20),
    maxQueryValueChars: z.number().default(1_000),
  })

  private source: () => Config
  private readonly fetchImpl: Fetch

  /**
   * Construct the HTTP Provider.
   * @param ctx - Cordis context that receives `ctx.alertmanager`.
   * @param config - validated Provider configuration.
   * @param fetchImpl - HTTP implementation; tests supply a deterministic fake.
   */
  constructor(ctx: Context, config: Config, fetchImpl: Fetch = globalThis.fetch) {
    super(ctx)
    resolveConfig(config)
    this.source = () => config
    this.fetchImpl = fetchImpl
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, 'aiops-alertmanager', AlertmanagerHttpRuntime.Config, config, {
        validate: resolveConfig,
        setSource: (current) => { this.source = current },
        onChange: () => {},
      })
    })
  }

  override resolveAlerts(request: AlertmanagerAlertsRequest): AlertmanagerAlertsSpec {
    const config = resolveConfig(this.source())
    const filters = request.filters ?? []
    const receiverMatchers = request.receiverMatchers ?? []
    if (filters.length + receiverMatchers.length > config.maxFilterCount) {
      throw new AlertmanagerQueryError(
        'invalid_request',
        `Alertmanager query accepts at most ${config.maxFilterCount} matcher expressions.`,
      )
    }
    return {
      active: request.active ?? true,
      silenced: request.silenced ?? true,
      inhibited: request.inhibited ?? true,
      unprocessed: request.unprocessed ?? true,
      filters: filters.map(value => queryValue('filter', value, config.maxQueryValueChars)),
      ...(request.receiver === undefined
        ? {}
        : { receiver: queryValue('receiver', request.receiver, config.maxQueryValueChars) }),
      receiverMatchers: receiverMatchers.map(value =>
        queryValue('receiver matcher', value, config.maxQueryValueChars)),
    }
  }

  override async alerts(spec: AlertmanagerAlertsSpec, signal?: AbortSignal): Promise<AlertmanagerAlertsResult> {
    const config = resolveConfig(this.source())
    if (config.baseUrl === undefined) {
      throw new AlertmanagerQueryError('invalid_request', 'Alertmanager URL is not configured. Open AIOps settings to add it.')
    }
    const url = new URL('api/v2/alerts', config.baseUrl)
    url.searchParams.set('active', String(spec.active))
    url.searchParams.set('silenced', String(spec.silenced))
    url.searchParams.set('inhibited', String(spec.inhibited))
    url.searchParams.set('unprocessed', String(spec.unprocessed))
    for (const filter of spec.filters) url.searchParams.append('filter', filter)
    if (spec.receiver !== undefined) url.searchParams.set('receiver', spec.receiver)
    for (const matcher of spec.receiverMatchers) url.searchParams.append('receiver_matchers', matcher)

    const received = await readAiopsHttp({
      url,
      signal,
      timeoutMs: config.timeoutMs,
      timeoutCode: TIMEOUT_CODE,
      maxResponseBytes: config.maxResponseBytes,
      fetchImpl: this.fetchImpl,
    }).catch((error: unknown) => throwAlertmanagerHttpError(error, config))
    if (!received.response.ok) {
      throw new AlertmanagerQueryError('http_error', `Alertmanager returned HTTP ${received.response.status}.`)
    }
    return decodeAlerts(received.body)
  }
}

/** Default Loader export: the HTTP Provider plus the stable abstract service. */
export default AlertmanagerHttpRuntime

function resolveConfig(config: Config): ResolvedConfig {
  const rawBaseUrl = config.baseUrl?.trim() ?? ''
  let baseUrl: URL | undefined
  if (rawBaseUrl !== '') {
    try {
      baseUrl = new URL(rawBaseUrl)
    } catch (error: unknown) {
      throw new AlertmanagerQueryError('invalid_request', 'aiops-alertmanager: baseUrl must be an absolute URL.', error)
    }
    if ((baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')
      || baseUrl.username !== '' || baseUrl.password !== '' || baseUrl.search !== '' || baseUrl.hash !== '') {
      throw new AlertmanagerQueryError(
        'invalid_request',
        'aiops-alertmanager: baseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
      )
    }
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/'
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxResponseBytes = config.maxResponseBytes ?? 2_000_000
  const maxFilterCount = config.maxFilterCount ?? 20
  const maxQueryValueChars = config.maxQueryValueChars ?? 1_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new AlertmanagerQueryError('invalid_request', `aiops-alertmanager: timeoutMs must be within 1..${MAX_TIMER_DELAY_MS}.`)
  }
  for (const [name, value] of [
    ['maxResponseBytes', maxResponseBytes],
    ['maxFilterCount', maxFilterCount],
    ['maxQueryValueChars', maxQueryValueChars],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AlertmanagerQueryError('invalid_request', `aiops-alertmanager: ${name} must be a positive safe integer.`)
    }
  }
  return { baseUrl, timeoutMs, maxResponseBytes, maxFilterCount, maxQueryValueChars }
}

function queryValue(name: string, value: string, maxChars: number): string {
  const normalized = value.trim()
  if (normalized === '') throw new AlertmanagerQueryError('invalid_request', `${name} must be non-empty.`)
  if (normalized.length > maxChars) {
    throw new AlertmanagerQueryError('invalid_request', `${name} must not exceed ${maxChars} characters.`)
  }
  return normalized
}

function throwAlertmanagerHttpError(error: unknown, config: ResolvedConfig): never {
  const code = error instanceof AiopsHttpReadError ? error.code : 'transport'
  switch (code) {
    case 'response_too_large':
      throw new AlertmanagerQueryError(
        'response_too_large',
        `Alertmanager response exceeds ${config.maxResponseBytes} bytes.`,
        error,
      )
    case 'timeout':
      throw new AlertmanagerQueryError('timeout', `Alertmanager query exceeded ${config.timeoutMs}ms.`, error)
    case 'transport':
      throw new AlertmanagerQueryError('http_error', 'Alertmanager request failed.', error)
  }
}

function decodeAlerts(body: string): AlertmanagerAlertsResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (error: unknown) {
    throw new AlertmanagerQueryError('provider_error', 'Alertmanager returned invalid JSON.', error)
  }
  const value = snapshotJsonValue(parsed)
  if (value === undefined || !Array.isArray(value)
    || value.some(item => item === null || Array.isArray(item) || typeof item !== 'object')) {
    throw new AlertmanagerQueryError('provider_error', 'Alertmanager returned an invalid alerts array.')
  }
  return value as AlertmanagerAlert[]
}
