import { Context, Service } from '@deepseek-ai/cordis'
import type {
  KubernetesConnectionSpec, KubernetesConnectionResult, KubernetesEventsRequest,
  KubernetesExecutionTarget, KubernetesGetRequest, KubernetesListRequest,
  KubernetesLogsRequest, KubernetesLogsResult, KubernetesLogsSpec,
  KubernetesReadResult, KubernetesTarget,
} from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { kubernetes: KubernetesRuntime } }

export type KubernetesQueryErrorCode =
  | 'invalid_request' | 'command_failed' | 'invalid_response' | 'response_too_large'
  | 'authentication_failed' | 'forbidden' | 'not_found' | 'timeout'
  | 'credential_exec_missing' | 'unsupported_resource' | 'unreachable'

export class KubernetesQueryError extends Error {
  readonly code: KubernetesQueryErrorCode
  constructor(code: KubernetesQueryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'KubernetesQueryError'
    this.code = code
  }
}

export abstract class KubernetesRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'kubernetes') }
  abstract get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult>
  abstract list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult>
  abstract events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult>
  abstract resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec
  abstract logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult>
  abstract testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult>
}

export interface LogLimits { readonly defaultLogTailLines: number; readonly maxLogTailLines: number }

export function resolveLogsRequest(request: KubernetesLogsRequest, limits: LogLimits): KubernetesLogsSpec {
  const target = validateExecutionTarget(request)
  const tailLines = request.tailLines ?? limits.defaultLogTailLines
  if (!Number.isSafeInteger(tailLines) || tailLines <= 0) throw new KubernetesQueryError('invalid_request', 'tailLines must be a positive safe integer.')
  if (request.since !== undefined && request.sinceTime !== undefined) throw new KubernetesQueryError('invalid_request', 'since and sinceTime are mutually exclusive.')
  const window = absoluteWindow(request.sinceTime, request.untilTime)
  if (request.untilTime !== undefined && request.timestamps === false) throw new KubernetesQueryError('invalid_request', 'untilTime requires timestamps to be enabled.')
  return {
    ...target, pod: argumentValue('pod', request.pod),
    ...(request.container === undefined ? {} : { container: argumentValue('container', request.container) }),
    previous: request.previous ?? false,
    tailLines: Math.min(tailLines, limits.maxLogTailLines),
    ...(request.since === undefined ? {} : { since: argumentValue('since', request.since) }),
    ...(window?.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
    ...(window?.untilTime === undefined ? {} : { untilTime: window.untilTime }),
    timestamps: request.timestamps ?? request.untilTime !== undefined,
  }
}

export function validateExecutionTarget(target: KubernetesExecutionTarget): KubernetesExecutionTarget {
  const cwd = target.cwd.trim()
  if (cwd === '') throw new KubernetesQueryError('invalid_request', 'cwd must be non-empty.')
  return { cwd, ...(target.namespace === undefined ? {} : { namespace: argumentValue('namespace', target.namespace) }) }
}

export function validateTarget(target: KubernetesTarget): KubernetesTarget {
  return { ...validateExecutionTarget(target), resource: argumentValue('resource', target.resource) }
}

export function argumentValue(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.startsWith('-')) throw new KubernetesQueryError('invalid_request', `${name} must be non-empty and must not start with "-".`)
  return normalized
}

export function namespaceArgs(namespace: string | undefined): string[] { return namespace === undefined ? [] : ['--namespace', namespace] }
export function selectorArgs(labelSelector: string | undefined, fieldSelector: string | undefined): string[] {
  return [...(labelSelector === undefined ? [] : ['--selector', argumentValue('labelSelector', labelSelector)]), ...(fieldSelector === undefined ? [] : ['--field-selector', argumentValue('fieldSelector', fieldSelector)])]
}

export interface AbsoluteWindow { readonly sinceTime?: string; readonly untilTime?: string; readonly sinceEpochMs?: number; readonly untilEpochMs?: number }
export function absoluteWindow(sinceTime: string | undefined, untilTime: string | undefined): AbsoluteWindow | undefined {
  if (sinceTime === undefined && untilTime === undefined) return undefined
  const since = sinceTime === undefined ? undefined : normalizeTimestamp('sinceTime', sinceTime)
  const until = untilTime === undefined ? undefined : normalizeTimestamp('untilTime', untilTime)
  if (since !== undefined && until !== undefined && since.epochMs > until.epochMs) throw new KubernetesQueryError('invalid_request', 'sinceTime must not be after untilTime.')
  return { ...(since === undefined ? {} : { sinceTime: since.time, sinceEpochMs: since.epochMs }), ...(until === undefined ? {} : { untilTime: until.time, untilEpochMs: until.epochMs }) }
}

export function normalizeTimestamp(name: string, value: string): { time: string; epochMs: number } {
  const normalized = value.trim(); const epochMs = Date.parse(normalized)
  if (normalized === '' || !Number.isFinite(epochMs)) throw new KubernetesQueryError('invalid_request', `${name} must be a valid timestamp.`)
  return { time: new Date(epochMs).toISOString(), epochMs }
}

export function filterEventList(value: KubernetesReadResult, window?: AbsoluteWindow): KubernetesReadResult {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new KubernetesQueryError('invalid_response', 'Kubernetes Event response must be an object.')
  const source = value as Record<string, KubernetesReadResult>; const items = source['items']
  if (!Array.isArray(items)) throw new KubernetesQueryError('invalid_response', 'Kubernetes Event response has no items array.')
  const sorted = [...items].sort((left, right) => (eventStart(left) ?? 0) - (eventStart(right) ?? 0))
  return { ...source, items: window === undefined ? sorted : sorted.filter(item => eventOverlaps(item, window)) }
}

function eventOverlaps(value: KubernetesReadResult, window: AbsoluteWindow): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const event = value as Record<string, KubernetesReadResult>; const metadata = objectValue(event['metadata']); const series = objectValue(event['series'])
  const start = firstTimestamp(event['firstTimestamp'], metadata?.['creationTimestamp'], event['eventTime'])
  const end = firstTimestamp(series?.['lastObservedTime'], event['lastTimestamp'], event['eventTime'], start)
  if (start === undefined || end === undefined) return false
  return (window.sinceEpochMs === undefined || end >= window.sinceEpochMs) && (window.untilEpochMs === undefined || start <= window.untilEpochMs)
}
function eventStart(value: KubernetesReadResult): number | undefined {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined
  const event = value as Record<string, KubernetesReadResult>
  return firstTimestamp(event['firstTimestamp'], objectValue(event['metadata'])?.['creationTimestamp'], event['eventTime'])
}
function objectValue(value: KubernetesReadResult | undefined): Record<string, KubernetesReadResult> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, KubernetesReadResult> : undefined
}
function firstTimestamp(...values: (KubernetesReadResult | number | undefined)[]): number | undefined {
  for (const value of values) { if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed } }
  return undefined
}
export function filterTimestampedLogLines(output: string, untilTime: string): string {
  const untilEpochMs = normalizeTimestamp('untilTime', untilTime).epochMs
  return output.split(/(?<=\n)/u).filter(line => { const separator = line.indexOf(' '); if (separator <= 0) return false; const parsed = Date.parse(line.slice(0, separator)); return Number.isFinite(parsed) && parsed <= untilEpochMs }).join('')
}
