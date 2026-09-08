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
  PrometheusDiscoveryRequest,
  PrometheusDiscoveryResult,
  PrometheusInstantQuery,
  PrometheusLabelMatcher,
  PrometheusQueryResult,
  PrometheusRangeQuery,
  PrometheusRulesRequest,
  PrometheusRulesResult,
  PrometheusRuleSummary,
  PrometheusTargetsRequest,
  PrometheusTargetsResult,
  PrometheusTargetSummary,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    prometheus: PrometheusRuntime
  }
}

const RESULT_TYPES = new Set(['matrix', 'vector', 'scalar', 'string'])
const TIMEOUT_CODE = 'PROMETHEUS_TIMEOUT'
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Configuration for the HTTP Prometheus provider. */
export interface Config {
  /** Prometheus server base URL, including a deployment path prefix when used. */
  baseUrl?: string
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
  /** Maximum complete response body size in bytes. */
  maxResponseBytes?: number
  /** Default maximum result count for rule, target, and metadata discovery. */
  defaultDiscoveryLimit?: number
  /** Hard maximum result count accepted from callers. */
  maxDiscoveryLimit?: number
  /** Maximum exact label or series-selector filters on one request. */
  maxMatcherCount?: number
  /** Maximum characters in one caller-supplied discovery value. */
  maxInputChars?: number
  /** Maximum absolute series-discovery window in seconds. */
  maxDiscoveryWindowSeconds?: number
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

  /** Find bounded alerting-rule definitions and their exact PromQL expressions. */
  abstract rules(request: PrometheusRulesRequest, signal?: AbortSignal): Promise<PrometheusRulesResult>

  /** Find bounded scrape-target health and last scrape errors. */
  abstract targets(request: PrometheusTargetsRequest, signal?: AbortSignal): Promise<PrometheusTargetsResult>

  /** Discover bounded series identities or label names/values over an absolute window. */
  abstract discover(request: PrometheusDiscoveryRequest, signal?: AbortSignal): Promise<PrometheusDiscoveryResult>
}

interface ResolvedConfig {
  readonly baseUrl: URL | undefined
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly defaultDiscoveryLimit: number
  readonly maxDiscoveryLimit: number
  readonly maxMatcherCount: number
  readonly maxInputChars: number
  readonly maxDiscoveryWindowSeconds: number
}

type Fetch = typeof globalThis.fetch

/** Read-only provider backed by Prometheus's `/api/v1/query*` HTTP endpoints. */
export class PrometheusHttpRuntime extends PrometheusRuntime {
  static Config: z<Config> = z.object({
    baseUrl: z.string().default(''),
    timeoutMs: z.number().default(30_000),
    maxResponseBytes: z.number().default(2_000_000),
    defaultDiscoveryLimit: z.number().default(20),
    maxDiscoveryLimit: z.number().default(100),
    maxMatcherCount: z.number().default(20),
    maxInputChars: z.number().default(2_000),
    maxDiscoveryWindowSeconds: z.number().default(86_400),
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

  override async rules(request: PrometheusRulesRequest, signal?: AbortSignal): Promise<PrometheusRulesResult> {
    const config = resolveConfigured(this.source())
    const alertName = requiredBoundedText('alertName', request.alertName, config.maxInputChars)
    const labelMatchers = resolveLabelMatchers(request.labelMatchers ?? [], config)
    const limit = resolveLimit(request.limit, config)
    const generatorExpression = request.generatorUrl === undefined
      ? undefined
      : parseGeneratorExpression(request.generatorUrl, config)
    const params = new URLSearchParams({ type: 'alert', exclude_alerts: 'true' })
    params.append('rule_name[]', alertName)
    const data = await this.requestData('api/v1/rules', params, signal, config)
    const rules = decodeRules(data, alertName, labelMatchers)
    return {
      alertName,
      ...(generatorExpression === undefined ? {} : { generatorExpression }),
      rules: rules.slice(0, limit),
      truncated: rules.length > limit,
    }
  }

  override async targets(request: PrometheusTargetsRequest, signal?: AbortSignal): Promise<PrometheusTargetsResult> {
    const config = resolveConfigured(this.source())
    const labelMatchers = resolveLabelMatchers(request.labelMatchers ?? [], config)
    const scrapePool = request.scrapePool === undefined
      ? undefined
      : requiredBoundedText('scrapePool', request.scrapePool, config.maxInputChars)
    if (labelMatchers.length === 0 && scrapePool === undefined) {
      throw new PrometheusQueryError('invalid_request', 'targets requires at least one label matcher or scrapePool.')
    }
    const state = request.state ?? 'any'
    if (state !== 'active' && state !== 'dropped' && state !== 'any') {
      throw new PrometheusQueryError('invalid_request', 'state must be active, dropped, or any.')
    }
    const limit = resolveLimit(request.limit, config)
    const params = new URLSearchParams({ state })
    if (scrapePool !== undefined) params.set('scrapePool', scrapePool)
    const data = await this.requestData('api/v1/targets', params, signal, config)
    const targets = decodeTargets(data, state, labelMatchers, scrapePool)
    return { targets: targets.slice(0, limit), truncated: targets.length > limit }
  }

  override async discover(
    request: PrometheusDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<PrometheusDiscoveryResult> {
    const config = resolveConfigured(this.source())
    if (request.kind !== 'series' && request.kind !== 'label_names' && request.kind !== 'label_values') {
      throw new PrometheusQueryError('invalid_request', 'kind must be series, label_names, or label_values.')
    }
    if (!Array.isArray(request.matchers) || request.matchers.length === 0
      || request.matchers.length > config.maxMatcherCount) {
      throw new PrometheusQueryError(
        'invalid_request',
        `matchers must contain 1..${config.maxMatcherCount} concrete series selectors.`,
      )
    }
    const matchers = request.matchers.map((value, index) => {
      const matcher = requiredBoundedText(`matchers[${index}]`, value, config.maxInputChars)
      if (!isBoundedSeriesSelector(matcher)) {
        throw new PrometheusQueryError(
          'invalid_request',
          `matchers[${index}] must name a metric or contain a non-empty exact label matcher.`,
        )
      }
      return matcher
    })
    const start = requiredBoundedText('start', request.start, config.maxInputChars)
    const end = requiredBoundedText('end', request.end, config.maxInputChars)
    validateDiscoveryWindow(start, end, config.maxDiscoveryWindowSeconds)
    const labelName = request.labelName === undefined
      ? undefined
      : requiredBoundedText('labelName', request.labelName, config.maxInputChars)
    if (request.kind === 'label_values') {
      if (labelName === undefined || !LABEL_NAME.test(labelName)) {
        throw new PrometheusQueryError('invalid_request', 'labelName must be a standard Prometheus label name.')
      }
    } else if (labelName !== undefined) {
      throw new PrometheusQueryError('invalid_request', 'labelName is only valid for label_values discovery.')
    }
    const limit = resolveLimit(request.limit, config)
    const params = new URLSearchParams({ start, end, limit: String(limit + 1) })
    for (const matcher of matchers) params.append('match[]', matcher)
    const endpoint = request.kind === 'series'
      ? 'api/v1/series'
      : request.kind === 'label_names'
        ? 'api/v1/labels'
        : `api/v1/label/${encodeURIComponent(labelName as string)}/values`
    const data = await this.requestData(endpoint, params, signal, config)
    const items = decodeDiscovery(data, request.kind)
    return {
      kind: request.kind,
      ...(labelName === undefined ? {} : { labelName }),
      items: items.slice(0, limit),
      truncated: items.length > limit,
    }
  }

  private async request(
    endpoint: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<PrometheusQueryResult> {
    const config = resolveConfigured(this.source())
    const data = await this.requestData(endpoint, params, signal, config)
    return decodeQueryData(data)
  }

  private async requestData(
    endpoint: string,
    params: URLSearchParams,
    signal: AbortSignal | undefined,
    config: ResolvedConfig & { readonly baseUrl: URL },
  ): Promise<JsonValue> {
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
    return decodeEnvelope(received.body)
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
  const defaultDiscoveryLimit = config.defaultDiscoveryLimit ?? 20
  const maxDiscoveryLimit = config.maxDiscoveryLimit ?? 100
  const maxMatcherCount = config.maxMatcherCount ?? 20
  const maxInputChars = config.maxInputChars ?? 2_000
  const maxDiscoveryWindowSeconds = config.maxDiscoveryWindowSeconds ?? 86_400
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new PrometheusQueryError('invalid_request', `aiops-prometheus: timeoutMs must be within 1..${MAX_TIMER_DELAY_MS}.`)
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new PrometheusQueryError('invalid_request', 'aiops-prometheus: maxResponseBytes must be a positive safe integer.')
  }
  for (const [name, value] of [
    ['defaultDiscoveryLimit', defaultDiscoveryLimit],
    ['maxDiscoveryLimit', maxDiscoveryLimit],
    ['maxMatcherCount', maxMatcherCount],
    ['maxInputChars', maxInputChars],
    ['maxDiscoveryWindowSeconds', maxDiscoveryWindowSeconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PrometheusQueryError('invalid_request', `aiops-prometheus: ${name} must be a positive safe integer.`)
    }
  }
  if (defaultDiscoveryLimit > maxDiscoveryLimit) {
    throw new PrometheusQueryError(
      'invalid_request',
      'aiops-prometheus: defaultDiscoveryLimit must not exceed maxDiscoveryLimit.',
    )
  }
  return {
    baseUrl,
    timeoutMs,
    maxResponseBytes,
    defaultDiscoveryLimit,
    maxDiscoveryLimit,
    maxMatcherCount,
    maxInputChars,
    maxDiscoveryWindowSeconds,
  }
}

function resolveConfigured(config: Config): ResolvedConfig & { readonly baseUrl: URL } {
  const resolved = resolveConfig(config)
  if (resolved.baseUrl === undefined) {
    throw new PrometheusQueryError('invalid_request', 'Prometheus URL is not configured. Open AIOps settings to add it.')
  }
  return { ...resolved, baseUrl: resolved.baseUrl }
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new PrometheusQueryError('invalid_request', `${name} must be non-empty.`)
  return normalized
}

function requiredBoundedText(name: string, value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new PrometheusQueryError('invalid_request', `${name} must be a string.`)
  }
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maxChars) {
    throw new PrometheusQueryError('invalid_request', `${name} must contain 1..${maxChars} characters.`)
  }
  return normalized
}

function resolveLimit(limit: number | undefined, config: ResolvedConfig): number {
  const value = limit ?? config.defaultDiscoveryLimit
  if (!Number.isSafeInteger(value) || value <= 0 || value > config.maxDiscoveryLimit) {
    throw new PrometheusQueryError(
      'invalid_request',
      `limit must be an integer within 1..${config.maxDiscoveryLimit}.`,
    )
  }
  return value
}

function resolveLabelMatchers(
  values: readonly PrometheusLabelMatcher[],
  config: ResolvedConfig,
): readonly PrometheusLabelMatcher[] {
  if (!Array.isArray(values) || values.length > config.maxMatcherCount) {
    throw new PrometheusQueryError(
      'invalid_request',
      `labelMatchers must contain at most ${config.maxMatcherCount} entries.`,
    )
  }
  const seen = new Set<string>()
  const result = values.map((matcher, index) => {
    if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) {
      throw new PrometheusQueryError('invalid_request', `labelMatchers[${index}] must be an object.`)
    }
    const name = requiredBoundedText(`labelMatchers[${index}].name`, matcher.name, config.maxInputChars)
    if (!LABEL_NAME.test(name)) {
      throw new PrometheusQueryError('invalid_request', `labelMatchers[${index}].name is not a valid label name.`)
    }
    if (seen.has(name)) {
      throw new PrometheusQueryError('invalid_request', `labelMatchers contains duplicate label ${name}.`)
    }
    seen.add(name)
    if (typeof matcher.value !== 'string' || matcher.value.length > config.maxInputChars) {
      throw new PrometheusQueryError(
        'invalid_request',
        `labelMatchers[${index}].value must contain at most ${config.maxInputChars} characters.`,
      )
    }
    return { name, value: matcher.value }
  })
  return result.sort((left, right) => left.name.localeCompare(right.name))
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

function decodeEnvelope(body: string): JsonValue {
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
  if (data === undefined || data === null) {
    throw new PrometheusQueryError('provider_error', 'Prometheus success response has no data object.')
  }
  return data
}

function decodeQueryData(data: JsonValue): PrometheusQueryResult {
  if (Array.isArray(data) || typeof data !== 'object') {
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

function jsonRecord(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  return value as Record<string, JsonValue>
}

function jsonArray(value: JsonValue | undefined, field: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  return value
}

function responseString(record: Record<string, JsonValue>, key: string, field: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  return value
}

function optionalResponseString(
  record: Record<string, JsonValue>,
  key: string,
  field: string,
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  return value
}

function optionalResponseNumber(
  record: Record<string, JsonValue>,
  key: string,
  field: string,
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  return value
}

function canonicalStringMap(value: JsonValue | undefined, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  const source = jsonRecord(value, field)
  const result: Record<string, string> = {}
  for (const key of Object.keys(source).sort()) {
    const item = source[key]
    if (typeof item !== 'string') {
      throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.${key}.`)
    }
    result[key] = item
  }
  return result
}

function decodeRules(
  data: JsonValue,
  alertName: string,
  matchers: readonly PrometheusLabelMatcher[],
): PrometheusRuleSummary[] {
  const root = jsonRecord(data, 'rules data')
  const groups = jsonArray(root['groups'], 'rules groups')
  const result: PrometheusRuleSummary[] = []
  for (const [groupIndex, groupValue] of groups.entries()) {
    const group = jsonRecord(groupValue, `rules groups[${groupIndex}]`)
    const groupName = responseString(group, 'name', `rules groups[${groupIndex}].name`)
    const file = responseString(group, 'file', `rules groups[${groupIndex}].file`)
    const interval = optionalResponseNumber(group, 'interval', `rules groups[${groupIndex}].interval`)
    const groupEvaluationTime = optionalResponseNumber(
      group,
      'evaluationTime',
      `rules groups[${groupIndex}].evaluationTime`,
    )
    const groupLastEvaluation = optionalResponseString(
      group,
      'lastEvaluation',
      `rules groups[${groupIndex}].lastEvaluation`,
    )
    const rules = jsonArray(group['rules'], `rules groups[${groupIndex}].rules`)
    for (const [ruleIndex, ruleValue] of rules.entries()) {
      const field = `rules groups[${groupIndex}].rules[${ruleIndex}]`
      const rule = jsonRecord(ruleValue, field)
      if (rule['type'] !== 'alerting') continue
      const name = responseString(rule, 'name', `${field}.name`)
      if (name !== alertName) continue
      const labels = canonicalStringMap(rule['labels'], `${field}.labels`)
      const matchingLabels: string[] = []
      const conflictingLabels: string[] = []
      for (const matcher of matchers) {
        const configured = labels[matcher.name]
        if (configured === undefined) continue
        if (configured === matcher.value) matchingLabels.push(matcher.name)
        else if (!configured.includes('{{') && !configured.includes('}}')) conflictingLabels.push(matcher.name)
      }
      const duration = optionalResponseNumber(rule, 'duration', `${field}.duration`)
      const keepFiringFor = optionalResponseNumber(rule, 'keepFiringFor', `${field}.keepFiringFor`)
      const health = optionalResponseString(rule, 'health', `${field}.health`)
      const lastError = optionalResponseString(rule, 'lastError', `${field}.lastError`)
      const evaluationTime = optionalResponseNumber(rule, 'evaluationTime', `${field}.evaluationTime`)
      const lastEvaluation = optionalResponseString(rule, 'lastEvaluation', `${field}.lastEvaluation`)
      result.push({
        name,
        query: responseString(rule, 'query', `${field}.query`),
        ...(duration === undefined ? {} : { duration }),
        ...(keepFiringFor === undefined ? {} : { keepFiringFor }),
        labels,
        annotations: canonicalStringMap(rule['annotations'], `${field}.annotations`),
        ...(health === undefined ? {} : { health }),
        ...(lastError === undefined ? {} : { lastError }),
        ...(evaluationTime === undefined ? {} : { evaluationTime }),
        ...(lastEvaluation === undefined ? {} : { lastEvaluation }),
        group: {
          name: groupName,
          file,
          ...(interval === undefined ? {} : { interval }),
          ...(groupEvaluationTime === undefined ? {} : { evaluationTime: groupEvaluationTime }),
          ...(groupLastEvaluation === undefined ? {} : { lastEvaluation: groupLastEvaluation }),
        },
        matchingLabels,
        conflictingLabels,
      })
    }
  }
  return result.sort((left, right) =>
    right.matchingLabels.length - left.matchingLabels.length
    || left.conflictingLabels.length - right.conflictingLabels.length
    || left.group.file.localeCompare(right.group.file)
    || left.group.name.localeCompare(right.group.name)
    || left.query.localeCompare(right.query))
}

function parseGeneratorExpression(raw: string, config: ResolvedConfig & { readonly baseUrl: URL }): string | undefined {
  const text = requiredBoundedText('generatorUrl', raw, config.maxInputChars)
  let url: URL
  try {
    url = new URL(text)
  } catch (error: unknown) {
    throw new PrometheusQueryError('invalid_request', 'generatorUrl must be an absolute URL.', error)
  }
  const base = config.baseUrl
  const relativePath = url.pathname.slice(base.pathname.length).replace(/^\/+|\/+$/g, '')
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '' || url.origin !== base.origin
    || !url.pathname.startsWith(base.pathname) || relativePath !== 'graph') {
    throw new PrometheusQueryError(
      'invalid_request',
      'generatorUrl must identify the configured Prometheus graph endpoint.',
    )
  }
  const values = [...url.searchParams.getAll('g0.expr'), ...url.searchParams.getAll('expr')]
    .filter(value => value.trim() !== '')
  if (values.length === 0) return undefined
  if (values.length !== 1) {
    throw new PrometheusQueryError('invalid_request', 'generatorUrl contains an ambiguous PromQL expression.')
  }
  return requiredBoundedText('generatorUrl expression', values[0], config.maxInputChars)
}

function targetMatches(
  target: PrometheusTargetSummary,
  matchers: readonly PrometheusLabelMatcher[],
  scrapePool: string | undefined,
): boolean {
  if (scrapePool !== undefined && target.scrapePool !== scrapePool) return false
  return matchers.every(({ name, value }) =>
    target.labels[name] === value || target.discoveredLabels[name] === value)
}

function sanitizeObservedUrl(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`, error)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${field}.`)
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeTarget(value: JsonValue, state: 'active' | 'dropped', field: string): PrometheusTargetSummary {
  const source = jsonRecord(value, field)
  const scrapePool = optionalResponseString(source, 'scrapePool', `${field}.scrapePool`)
  const scrapeUrl = sanitizeObservedUrl(optionalResponseString(source, 'scrapeUrl', `${field}.scrapeUrl`), `${field}.scrapeUrl`)
  const globalUrl = sanitizeObservedUrl(optionalResponseString(source, 'globalUrl', `${field}.globalUrl`), `${field}.globalUrl`)
  const health = optionalResponseString(source, 'health', `${field}.health`)
  const lastError = optionalResponseString(source, 'lastError', `${field}.lastError`)
  const lastScrape = optionalResponseString(source, 'lastScrape', `${field}.lastScrape`)
  const lastScrapeDuration = optionalResponseNumber(source, 'lastScrapeDuration', `${field}.lastScrapeDuration`)
  const scrapeInterval = optionalResponseString(source, 'scrapeInterval', `${field}.scrapeInterval`)
  const scrapeTimeout = optionalResponseString(source, 'scrapeTimeout', `${field}.scrapeTimeout`)
  return {
    state,
    labels: canonicalStringMap(source['labels'], `${field}.labels`),
    discoveredLabels: canonicalStringMap(source['discoveredLabels'], `${field}.discoveredLabels`),
    ...(scrapePool === undefined ? {} : { scrapePool }),
    ...(scrapeUrl === undefined ? {} : { scrapeUrl }),
    ...(globalUrl === undefined ? {} : { globalUrl }),
    ...(health === undefined ? {} : { health }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastScrape === undefined ? {} : { lastScrape }),
    ...(lastScrapeDuration === undefined ? {} : { lastScrapeDuration }),
    ...(scrapeInterval === undefined ? {} : { scrapeInterval }),
    ...(scrapeTimeout === undefined ? {} : { scrapeTimeout }),
  }
}

function decodeTargets(
  data: JsonValue,
  state: 'active' | 'dropped' | 'any',
  matchers: readonly PrometheusLabelMatcher[],
  scrapePool: string | undefined,
): PrometheusTargetSummary[] {
  const root = jsonRecord(data, 'targets data')
  const result: PrometheusTargetSummary[] = []
  if (state !== 'dropped') {
    for (const [index, value] of jsonArray(root['activeTargets'], 'activeTargets').entries()) {
      result.push(normalizeTarget(value, 'active', `activeTargets[${index}]`))
    }
  }
  if (state !== 'active') {
    for (const [index, value] of jsonArray(root['droppedTargets'], 'droppedTargets').entries()) {
      result.push(normalizeTarget(value, 'dropped', `droppedTargets[${index}]`))
    }
  }
  return result.filter(target => targetMatches(target, matchers, scrapePool)).sort((left, right) =>
    left.state.localeCompare(right.state)
    || (left.scrapePool ?? '').localeCompare(right.scrapePool ?? '')
    || JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels))
    || JSON.stringify(left.discoveredLabels).localeCompare(JSON.stringify(right.discoveredLabels)))
}

function isBoundedSeriesSelector(value: string): boolean {
  if (/^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\s*\{|\s*$)/.test(value)) return true
  return /[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*"(?:[^"\\]|\\.)+"/.test(value)
}

function prometheusTime(value: string, field: string): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric * 1_000
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new PrometheusQueryError('invalid_request', `${field} must be an absolute RFC3339 or Unix timestamp.`)
  }
  return timestamp
}

function validateDiscoveryWindow(start: string, end: string, maxSeconds: number): void {
  const startTime = prometheusTime(start, 'start')
  const endTime = prometheusTime(end, 'end')
  if (endTime < startTime) {
    throw new PrometheusQueryError('invalid_request', 'end must not be earlier than start.')
  }
  if (endTime - startTime > maxSeconds * 1_000) {
    throw new PrometheusQueryError('invalid_request', `discovery window must not exceed ${maxSeconds} seconds.`)
  }
}

function decodeDiscovery(
  data: JsonValue,
  kind: PrometheusDiscoveryRequest['kind'],
): (string | Readonly<Record<string, string>>)[] {
  const source = jsonArray(data, `${kind} data`)
  if (kind !== 'series') {
    const strings = source.map((value, index) => {
      if (typeof value !== 'string') {
        throw new PrometheusQueryError('provider_error', `Prometheus response has invalid ${kind}[${index}].`)
      }
      return value
    })
    return [...new Set(strings)].sort((left, right) => left.localeCompare(right))
  }
  const maps = source.map((value, index) => canonicalStringMap(value, `series[${index}]`))
  const unique = new Map(maps.map(value => [JSON.stringify(value), value]))
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value)
}
