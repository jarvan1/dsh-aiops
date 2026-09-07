/**
 * Read-only Prometheus query Service Definition and its HTTP API provider.
 * @module @deepseek-ai/dsh-aiops-prometheus
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AiopsHttpReadError, readAiopsHttp } from '@deepseek-ai/dsh-aiops-http-read'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import type {
  PrometheusInstantQuery,
  PrometheusQueryResult,
  PrometheusRangeQuery,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    prometheus: PrometheusRuntime
  }
}

const RESULT_TYPES = new Set(['matrix', 'vector', 'scalar', 'string'])
const TIMEOUT_CODE = 'PROMETHEUS_TIMEOUT'

/** Configuration for the HTTP Prometheus provider. */
export interface Config {
  /** Prometheus server base URL, including a deployment path prefix when used. */
  baseUrl?: string
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
  /** Maximum complete response body size in bytes. */
  maxResponseBytes?: number
}

/** Error reported by the Prometheus capability. */
export class PrometheusQueryError extends Error {
  /** Stable failure class for callers that need containment decisions. */
  readonly code: 'invalid_request' | 'http_error' | 'provider_error' | 'response_too_large' | 'timeout'

  /**
   * Create one contained Prometheus query failure.
   * @param code - stable failure class.
   * @param message - operator-safe diagnostic.
   * @param cause - optional underlying transport or parser failure.
   */
  constructor(code: PrometheusQueryError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PrometheusQueryError'
    this.code = code
  }
}

/** Provider-neutral read-only Prometheus runtime. */
export abstract class PrometheusRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'prometheus')
  }

  /**
   * Evaluate one PromQL expression at one instant.
   * @param request - expression and optional evaluation time.
   * @param signal - caller cancellation.
   * @returns normalized successful query data.
   */
  abstract query(request: PrometheusInstantQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>

  /**
   * Evaluate one PromQL expression over a time range.
   * @param request - expression, range, and resolution.
   * @param signal - caller cancellation.
   * @returns normalized successful query data.
   */
  abstract queryRange(request: PrometheusRangeQuery, signal?: AbortSignal): Promise<PrometheusQueryResult>
}

interface ResolvedConfig {
  readonly baseUrl: URL | undefined
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

type Fetch = typeof globalThis.fetch

/** Read-only provider backed by Prometheus's `/api/v1/query*` HTTP endpoints. */
export class PrometheusHttpRuntime extends PrometheusRuntime {
  static Config: z<Config> = z.object({
    baseUrl: z.string().default(''),
    timeoutMs: z.number().default(30_000),
    maxResponseBytes: z.number().default(2_000_000),
  })

  private source: () => Config
  private readonly fetchImpl: Fetch

  /**
   * Construct the HTTP provider.
   * @param ctx - Cordis context that receives `ctx.prometheus`.
   * @param config - validated provider configuration.
   * @param fetchImpl - HTTP implementation; tests supply a deterministic fake.
   */
  constructor(ctx: Context, config: Config, fetchImpl: Fetch = globalThis.fetch) {
    super(ctx)
    resolveConfig(config)
    this.source = () => config
    this.fetchImpl = fetchImpl
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, 'aiops-prometheus', PrometheusHttpRuntime.Config, config, {
        validate: resolveConfig,
        setSource: (current) => { this.source = current },
        onChange: () => {},
      })
    })
  }

  override query(request: PrometheusInstantQuery, signal?: AbortSignal): Promise<PrometheusQueryResult> {
    const query = requiredText('query', request.query)
    const params = new URLSearchParams({ query })
    if (request.time !== undefined) params.set('time', requiredText('time', request.time))
    return this.request('api/v1/query', params, signal)
  }

  override queryRange(request: PrometheusRangeQuery, signal?: AbortSignal): Promise<PrometheusQueryResult> {
    const params = new URLSearchParams({
      query: requiredText('query', request.query),
      start: requiredText('start', request.start),
      end: requiredText('end', request.end),
      step: requiredText('step', request.step),
    })
    return this.request('api/v1/query_range', params, signal)
  }

  private async request(
    endpoint: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<PrometheusQueryResult> {
    const config = resolveConfig(this.source())
    if (config.baseUrl === undefined) {
      throw new PrometheusQueryError('invalid_request', 'Prometheus URL is not configured. Open AIOps settings to add it.')
    }
    const url = new URL(endpoint, config.baseUrl)
    url.search = params.toString()
    const received = await readAiopsHttp({
      url,
      signal,
      timeoutMs: config.timeoutMs,
      timeoutCode: TIMEOUT_CODE,
      maxResponseBytes: config.maxResponseBytes,
      fetchImpl: this.fetchImpl,
    }).catch((error: unknown) => throwPrometheusHttpError(error, config))
    if (!received.response.ok) {
      throw new PrometheusQueryError('http_error', `Prometheus returned HTTP ${received.response.status}.`)
    }
    return decodeResponse(received.body)
  }
}

/** Default Loader export: the current HTTP provider plus the stable abstract service. */
export default PrometheusHttpRuntime

function resolveConfig(config: Config): ResolvedConfig {
  const rawBaseUrl = config.baseUrl?.trim() ?? ''
  let baseUrl: URL | undefined
  if (rawBaseUrl !== '') {
    try {
      baseUrl = new URL(rawBaseUrl)
    } catch (error: unknown) {
      throw new PrometheusQueryError('invalid_request', 'aiops-prometheus: baseUrl must be an absolute URL.', error)
    }
    if ((baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')
      || baseUrl.username !== '' || baseUrl.password !== '' || baseUrl.search !== '' || baseUrl.hash !== '') {
      throw new PrometheusQueryError(
        'invalid_request',
        'aiops-prometheus: baseUrl must be an HTTP(S) URL without credentials, query, or fragment.',
      )
    }
    if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/'
  }
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxResponseBytes = config.maxResponseBytes ?? 2_000_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new PrometheusQueryError('invalid_request', `aiops-prometheus: timeoutMs must be within 1..${MAX_TIMER_DELAY_MS}.`)
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new PrometheusQueryError('invalid_request', 'aiops-prometheus: maxResponseBytes must be a positive safe integer.')
  }
  return { baseUrl, timeoutMs, maxResponseBytes }
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new PrometheusQueryError('invalid_request', `${name} must be non-empty.`)
  return normalized
}

function throwPrometheusHttpError(error: unknown, config: ResolvedConfig): never {
  const code = error instanceof AiopsHttpReadError ? error.code : 'transport'
  switch (code) {
    case 'response_too_large':
      throw new PrometheusQueryError(
        'response_too_large',
        `Prometheus response exceeds ${config.maxResponseBytes} bytes.`,
        error,
      )
    case 'timeout':
      throw new PrometheusQueryError('timeout', `Prometheus query exceeded ${config.timeoutMs}ms.`, error)
    case 'transport':
      throw new PrometheusQueryError('http_error', 'Prometheus request failed.', error)
  }
}

function decodeResponse(body: string): PrometheusQueryResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch (error: unknown) {
    throw new PrometheusQueryError('provider_error', 'Prometheus returned invalid JSON.', error)
  }
  const value = snapshotJsonValue(parsed)
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new PrometheusQueryError('provider_error', 'Prometheus returned an invalid response object.')
  }
  const envelope = value as Record<string, JsonValue>
  if (envelope['status'] !== 'success') {
    const message = typeof envelope['error'] === 'string' ? envelope['error'] : 'Prometheus query failed.'
    throw new PrometheusQueryError('provider_error', message)
  }
  const data = envelope['data']
  if (data === null || Array.isArray(data) || typeof data !== 'object') {
    throw new PrometheusQueryError('provider_error', 'Prometheus success response has no data object.')
  }
  const queryData = data as Record<string, JsonValue>
  const resultType = queryData['resultType']
  const result: JsonValue | undefined = queryData['result']
  if (typeof resultType !== 'string' || !RESULT_TYPES.has(resultType) || result === undefined) {
    throw new PrometheusQueryError('provider_error', 'Prometheus success response has invalid query data.')
  }
  return { resultType: resultType as PrometheusQueryResult['resultType'], result }
}
