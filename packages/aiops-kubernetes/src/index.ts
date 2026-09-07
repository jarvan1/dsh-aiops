/**
 * Read-only Kubernetes Service Definition and a kubectl subprocess provider.
 * @module @deepseek-ai/dsh-aiops-kubernetes
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  KubernetesGetRequest,
  KubernetesEventsRequest,
  KubernetesListRequest,
  KubernetesLogsRequest,
  KubernetesLogsResult,
  KubernetesLogsSpec,
  KubernetesReadResult,
  KubernetesExecutionTarget,
  KubernetesTarget,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kubernetes: KubernetesRuntime
  }
}

/** kubectl-backed provider configuration. */
export interface Config {
  /** Executable path or PATH-resolved command. */
  command?: string
  /** Explicit kubectl context; omission uses kubeconfig's current context. */
  context?: string
  /** Explicit kubeconfig path; omission uses kubectl's normal discovery. */
  kubeconfig?: string
  /** Process-tree termination grace in milliseconds. */
  graceMs?: number
  /** Maximum retained stdout size in bytes. */
  maxOutputBytes?: number
  /** Recent line count used when a Pod-log request omits it. */
  defaultLogTailLines?: number
  /** Maximum recent line count accepted from a Pod-log request. */
  maxLogTailLines?: number
}

/** Stable failure returned by the Kubernetes capability. */
export class KubernetesQueryError extends Error {
  /** Failure class used by tool consumers. */
  readonly code: 'invalid_request' | 'command_failed' | 'invalid_response' | 'response_too_large'

  /**
   * Create one contained Kubernetes read failure.
   * @param code - stable failure class.
   * @param message - operator-safe diagnostic.
   * @param cause - optional subprocess or parser failure.
   */
  constructor(code: KubernetesQueryError['code'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'KubernetesQueryError'
    this.code = code
  }
}

/** Provider-neutral read-only Kubernetes runtime. */
export abstract class KubernetesRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'kubernetes')
  }

  /**
   * Read one named Kubernetes object.
   * @param request - target resource, object name, namespace, and execution directory.
   * @param signal - caller cancellation.
   * @returns Kubernetes API object as lossless JSON.
   */
  abstract get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

  /**
   * List Kubernetes objects.
   * @param request - target resource, namespace, selectors, and execution directory.
   * @param signal - caller cancellation.
   * @returns Kubernetes API list as lossless JSON.
   */
  abstract list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

  /**
   * List Kubernetes Event objects in chronological order.
   * @param request - namespace and optional server-side selectors.
   * @param signal - caller cancellation.
   * @returns Kubernetes EventList as lossless JSON.
   */
  abstract events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult>

  /**
   * Apply Provider-owned defaults and caps to a Pod-log request.
   * @param request - Pod, optional container, time window, and requested line count.
   * @returns a fully specified bounded log request for {@link logs}.
   */
  abstract resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec

  /**
   * Read one bounded non-streaming Pod-log snapshot.
   * @param spec - fully resolved request from {@link resolveLogs}.
   * @param signal - caller cancellation.
   * @returns exact kubectl stdout within the configured byte limit.
   */
  abstract logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult>
}

interface ResolvedConfig {
  readonly command: string
  readonly context?: string
  readonly kubeconfig?: string
  readonly graceMs: number
  readonly maxOutputBytes: number
  readonly defaultLogTailLines: number
  readonly maxLogTailLines: number
}

/** Read-only provider for fixed kubectl object, Event, and bounded log reads without a shell. */
export class KubectlKubernetesRuntime extends KubernetesRuntime {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({
    command: z.string().default('kubectl'),
    context: z.string(),
    kubeconfig: z.string(),
    graceMs: z.number().default(5_000),
    maxOutputBytes: z.number().default(2_000_000),
    defaultLogTailLines: z.number().default(200),
    maxLogTailLines: z.number().default(2_000),
  })

  private readonly subprocess: SubprocessRuntime
  private readonly config: ResolvedConfig

  /**
   * Construct the kubectl provider.
   * @param ctx - Cordis context carrying the subprocess capability.
   * @param config - validated provider configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.subprocess = ctx.subprocess
    this.config = resolveConfig(config)
  }

  override async get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request)
    const name = argumentValue('name', request.name)
    return this.runJson(target.cwd, [...this.baseArgv(), 'get', target.resource, name,
      ...namespaceArgs(target.namespace), '--output=json'], signal)
  }

  override async list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request)
    return this.runJson(target.cwd, [...this.baseArgv(), 'get', target.resource,
      ...namespaceArgs(target.namespace),
      ...selectorArgs(request.labelSelector, request.fieldSelector), '--output=json'], signal)
  }

  override async events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateExecutionTarget(request)
    const window = absoluteWindow(request.sinceTime, request.untilTime)
    const result = await this.runJson(target.cwd, [...this.baseArgv(), 'get', 'events',
      ...namespaceArgs(target.namespace),
      ...selectorArgs(request.labelSelector, request.fieldSelector),
      '--sort-by=.metadata.creationTimestamp', '--output=json'], signal)
    return window === undefined ? result : filterEventList(result, window)
  }

  override resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec {
    const target = validateExecutionTarget(request)
    const tailLines = request.tailLines ?? this.config.defaultLogTailLines
    if (!Number.isSafeInteger(tailLines) || tailLines <= 0) {
      throw new KubernetesQueryError('invalid_request', 'tailLines must be a positive safe integer.')
    }
    if (request.since !== undefined && request.sinceTime !== undefined) {
      throw new KubernetesQueryError('invalid_request', 'since and sinceTime are mutually exclusive.')
    }
    const window = absoluteWindow(request.sinceTime, request.untilTime)
    if (request.untilTime !== undefined && request.timestamps === false) {
      throw new KubernetesQueryError('invalid_request', 'untilTime requires timestamps to be enabled.')
    }
    return {
      ...target,
      pod: argumentValue('pod', request.pod),
      ...(request.container === undefined ? {} : { container: argumentValue('container', request.container) }),
      previous: request.previous ?? false,
      tailLines: Math.min(tailLines, this.config.maxLogTailLines),
      ...(request.since === undefined ? {} : { since: argumentValue('since', request.since) }),
      ...(window?.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
      ...(window?.untilTime === undefined ? {} : { untilTime: window.untilTime }),
      timestamps: request.timestamps ?? request.untilTime !== undefined,
    }
  }

  override async logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult> {
    const output = await this.read(spec.cwd, [...this.baseArgv(), 'logs', spec.pod,
      ...namespaceArgs(spec.namespace),
      ...(spec.container === undefined ? [] : ['--container', spec.container]),
      '--tail', String(spec.tailLines),
      ...(spec.since === undefined ? [] : ['--since', spec.since]),
      ...(spec.sinceTime === undefined ? [] : ['--since-time', spec.sinceTime]),
      ...(spec.previous ? ['--previous'] : []),
      ...(spec.timestamps ? ['--timestamps'] : [])], signal)
    return spec.untilTime === undefined ? output : filterTimestampedLogLines(output, spec.untilTime)
  }

  private baseArgv(): string[] {
    return [
      this.config.command,
      ...(this.config.context === undefined ? [] : ['--context', this.config.context]),
      ...(this.config.kubeconfig === undefined ? [] : ['--kubeconfig', this.config.kubeconfig]),
    ]
  }

  private async read(cwd: string, argv: string[], signal?: AbortSignal): Promise<string> {
    const executable = await this.subprocess.resolveExecutable(this.config.command, undefined, signal)
    argv[0] = executable
    const handle = this.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: Math.min(this.config.maxOutputBytes, 65_536) },
      },
      graceMs: this.config.graceMs,
      signal,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error: unknown) {
      throw new KubernetesQueryError('command_failed', 'kubectl could not start.', error)
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined) {
      throw new KubernetesQueryError('command_failed', 'kubectl stdout was not collected.')
    }
    if (stdout.lossy) {
      throw new KubernetesQueryError(
        'response_too_large',
        `kubectl response exceeds ${this.config.maxOutputBytes} bytes.`,
      )
    }
    if (outcome.exitCode !== 0) {
      const detail = stderr?.text.trim()
      throw new KubernetesQueryError(
        'command_failed',
        `kubectl exited with ${outcome.exitCode === null ? outcome.signal ?? 'a signal' : `code ${outcome.exitCode}`}`
          + (detail === undefined || detail === '' ? '.' : `: ${detail}`),
      )
    }
    return stdout.text
  }

  private async runJson(cwd: string, argv: string[], signal?: AbortSignal): Promise<KubernetesReadResult> {
    const stdout = await this.read(cwd, argv, signal)
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout) as unknown
    } catch (error: unknown) {
      throw new KubernetesQueryError('invalid_response', 'kubectl returned invalid JSON.', error)
    }
    const value = snapshotJsonValue(parsed)
    if (value === undefined) {
      throw new KubernetesQueryError('invalid_response', 'kubectl returned a non-JSON value.')
    }
    return value as KubernetesReadResult
  }
}

/** Default Loader export: the kubectl provider plus the stable abstract service. */
export default KubectlKubernetesRuntime

function resolveConfig(config: Config): ResolvedConfig {
  const command = argumentValue('command', config.command ?? 'kubectl')
  const context = config.context === undefined ? undefined : argumentValue('context', config.context)
  const kubeconfig = config.kubeconfig === undefined ? undefined : argumentValue('kubeconfig', config.kubeconfig)
  const graceMs = config.graceMs ?? 5_000
  const maxOutputBytes = config.maxOutputBytes ?? 2_000_000
  const defaultLogTailLines = config.defaultLogTailLines ?? 200
  const maxLogTailLines = config.maxLogTailLines ?? 2_000
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2_147_483_647) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: graceMs must be a positive timer delay.')
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: maxOutputBytes must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(defaultLogTailLines) || defaultLogTailLines <= 0) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultLogTailLines must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(maxLogTailLines) || maxLogTailLines <= 0) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: maxLogTailLines must be a positive safe integer.')
  }
  if (defaultLogTailLines > maxLogTailLines) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultLogTailLines must not exceed maxLogTailLines.')
  }
  return {
    command,
    ...(context === undefined ? {} : { context }),
    ...(kubeconfig === undefined ? {} : { kubeconfig }),
    graceMs,
    maxOutputBytes,
    defaultLogTailLines,
    maxLogTailLines,
  }
}

function validateExecutionTarget(target: KubernetesExecutionTarget): KubernetesExecutionTarget {
  const cwd = target.cwd.trim()
  if (cwd === '') throw new KubernetesQueryError('invalid_request', 'cwd must be non-empty.')
  return {
    cwd,
    ...(target.namespace === undefined ? {} : { namespace: argumentValue('namespace', target.namespace) }),
  }
}

function validateTarget(target: KubernetesTarget): KubernetesTarget {
  const execution = validateExecutionTarget(target)
  return {
    ...execution,
    resource: argumentValue('resource', target.resource),
  }
}

function argumentValue(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.startsWith('-')) {
    throw new KubernetesQueryError('invalid_request', `${name} must be non-empty and must not start with "-".`)
  }
  return normalized
}

function namespaceArgs(namespace: string | undefined): string[] {
  return namespace === undefined ? [] : ['--namespace', namespace]
}

function selectorArgs(labelSelector: string | undefined, fieldSelector: string | undefined): string[] {
  return [
    ...(labelSelector === undefined ? [] : ['--selector', argumentValue('labelSelector', labelSelector)]),
    ...(fieldSelector === undefined ? [] : ['--field-selector', argumentValue('fieldSelector', fieldSelector)]),
  ]
}

interface AbsoluteWindow {
  readonly sinceTime?: string
  readonly untilTime?: string
  readonly sinceEpochMs?: number
  readonly untilEpochMs?: number
}

function absoluteWindow(sinceTime: string | undefined, untilTime: string | undefined): AbsoluteWindow | undefined {
  if (sinceTime === undefined && untilTime === undefined) return undefined
  const since = sinceTime === undefined ? undefined : normalizeTimestamp('sinceTime', sinceTime)
  const until = untilTime === undefined ? undefined : normalizeTimestamp('untilTime', untilTime)
  if (since !== undefined && until !== undefined && since.epochMs > until.epochMs) {
    throw new KubernetesQueryError('invalid_request', 'sinceTime must not be after untilTime.')
  }
  return {
    ...(since === undefined ? {} : { sinceTime: since.time, sinceEpochMs: since.epochMs }),
    ...(until === undefined ? {} : { untilTime: until.time, untilEpochMs: until.epochMs }),
  }
}

function normalizeTimestamp(name: string, value: string): { time: string; epochMs: number } {
  const normalized = value.trim()
  const epochMs = Date.parse(normalized)
  if (normalized === '' || !Number.isFinite(epochMs)) {
    throw new KubernetesQueryError('invalid_request', `${name} must be a valid timestamp.`)
  }
  return { time: new Date(epochMs).toISOString(), epochMs }
}

function filterEventList(value: KubernetesReadResult, window: AbsoluteWindow): KubernetesReadResult {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new KubernetesQueryError('invalid_response', 'kubectl Event response must be an object.')
  }
  const source = value as Record<string, KubernetesReadResult>
  const items = source['items']
  if (!Array.isArray(items)) {
    throw new KubernetesQueryError('invalid_response', 'kubectl Event response has no items array.')
  }
  return {
    ...source,
    items: items.filter(item => eventOverlaps(item, window)),
  }
}

function eventOverlaps(value: KubernetesReadResult, window: AbsoluteWindow): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const event = value as Record<string, KubernetesReadResult>
  const metadata = objectValue(event['metadata'])
  const series = objectValue(event['series'])
  const start = firstTimestamp(event['firstTimestamp'], metadata?.['creationTimestamp'], event['eventTime'])
  const end = firstTimestamp(series?.['lastObservedTime'], event['lastTimestamp'], event['eventTime'], start)
  if (start === undefined || end === undefined) return false
  return (window.sinceEpochMs === undefined || end >= window.sinceEpochMs)
    && (window.untilEpochMs === undefined || start <= window.untilEpochMs)
}

function objectValue(value: KubernetesReadResult | undefined): Record<string, KubernetesReadResult> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
    ? value as Record<string, KubernetesReadResult>
    : undefined
}

function firstTimestamp(...values: (KubernetesReadResult | number | undefined)[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function filterTimestampedLogLines(output: string, untilTime: string): string {
  const untilEpochMs = normalizeTimestamp('untilTime', untilTime).epochMs
  return output.split(/(?<=\n)/u).filter(line => {
    const separator = line.indexOf(' ')
    if (separator <= 0) return false
    const parsed = Date.parse(line.slice(0, separator))
    return Number.isFinite(parsed) && parsed <= untilEpochMs
  }).join('')
}
