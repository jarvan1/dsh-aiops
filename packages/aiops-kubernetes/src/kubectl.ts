/** Optional kubectl compatibility provider. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { KubernetesConnectionResult, KubernetesConnectionSpec, KubernetesEventsRequest, KubernetesGetRequest, KubernetesListRequest, KubernetesLogsRequest, KubernetesLogsResult, KubernetesLogsSpec, KubernetesReadResult } from './types.ts'
import { absoluteWindow, argumentValue, filterEventList, filterTimestampedLogLines, KubernetesQueryError, KubernetesRuntime, namespaceArgs, resolveLogsRequest, selectorArgs, validateExecutionTarget, validateTarget } from './runtime.ts'

export interface Config { command?: string; context?: string; kubeconfig?: string; graceMs?: number; maxOutputBytes?: number; defaultLogTailLines?: number; maxLogTailLines?: number }
interface ResolvedConfig { readonly command: string; readonly context?: string; readonly kubeconfig?: string; readonly graceMs: number; readonly maxOutputBytes: number; readonly defaultLogTailLines: number; readonly maxLogTailLines: number }

export class KubectlKubernetesRuntime extends KubernetesRuntime {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({ command: z.string().default('kubectl'), context: z.string(), kubeconfig: z.string(), graceMs: z.number().default(5_000), maxOutputBytes: z.number().default(2_000_000), defaultLogTailLines: z.number().default(200), maxLogTailLines: z.number().default(2_000) })
  private readonly subprocess: SubprocessRuntime
  private readonly config: ResolvedConfig
  constructor(ctx: Context, config: Config = {}) { super(ctx); this.subprocess = ctx.subprocess; this.config = resolveConfig(config) }
  override async get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult> { const target = validateTarget(request); return this.runJson(target.cwd, [...this.baseArgv(), 'get', target.resource, argumentValue('name', request.name), ...namespaceArgs(target.namespace), '--output=json'], signal) }
  override async list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult> { const target = validateTarget(request); return this.runJson(target.cwd, [...this.baseArgv(), 'get', target.resource, ...namespaceArgs(target.namespace), ...selectorArgs(request.labelSelector, request.fieldSelector), '--output=json'], signal) }
  override async events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult> { const target = validateExecutionTarget(request); const window = absoluteWindow(request.sinceTime, request.untilTime); const result = await this.runJson(target.cwd, [...this.baseArgv(), 'get', 'events', ...namespaceArgs(target.namespace), ...selectorArgs(request.labelSelector, request.fieldSelector), '--sort-by=.metadata.creationTimestamp', '--output=json'], signal); return filterEventList(result, window) }
  override resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec { return resolveLogsRequest(request, this.config) }
  override async logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult> { const output = await this.read(spec.cwd, [...this.baseArgv(), 'logs', spec.pod, ...namespaceArgs(spec.namespace), ...(spec.container === undefined ? [] : ['--container', spec.container]), '--tail', String(spec.tailLines), ...(spec.since === undefined ? [] : ['--since', spec.since]), ...(spec.sinceTime === undefined ? [] : ['--since-time', spec.sinceTime]), ...(spec.previous ? ['--previous'] : []), ...(spec.timestamps ? ['--timestamps'] : [])], signal); return spec.untilTime === undefined ? output : filterTimestampedLogLines(output, spec.untilTime) }
  override async testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult> { const kubeconfig = spec.kubeconfig?.trim() || this.config.kubeconfig; const context = spec.context?.trim() || this.config.context; await this.read(process.cwd(), [this.config.command, ...(context === undefined ? [] : ['--context', context]), ...(kubeconfig === undefined ? [] : ['--kubeconfig', kubeconfig]), 'auth', 'can-i', 'get', 'pods'], signal); return { context: context ?? 'current', cluster: 'kubectl', namespace: 'default', server: 'kubectl', capabilities: { pods: true, events: true, podLogs: true } } }
  private baseArgv(): string[] { return [this.config.command, ...(this.config.context === undefined ? [] : ['--context', this.config.context]), ...(this.config.kubeconfig === undefined ? [] : ['--kubeconfig', this.config.kubeconfig])] }
  private async read(cwd: string, argv: string[], signal?: AbortSignal): Promise<string> {
    const executable = await this.subprocess.resolveExecutable(this.config.command, undefined, signal); argv[0] = executable
    const handle = this.subprocess.spawn({ argv, cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: Math.min(this.config.maxOutputBytes, 65_536) } }, graceMs: this.config.graceMs, signal })
    let outcome; try { outcome = await handle.done } catch (error: unknown) { throw new KubernetesQueryError('command_failed', 'kubectl could not start.', error) }
    const stdout = handle.collected.stdout?.readFrom(0); const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined) throw new KubernetesQueryError('command_failed', 'kubectl stdout was not collected.')
    if (stdout.lossy) throw new KubernetesQueryError('response_too_large', `kubectl response exceeds ${this.config.maxOutputBytes} bytes.`)
    if (outcome.exitCode !== 0) { const detail = stderr?.text.trim(); throw new KubernetesQueryError('command_failed', `kubectl exited with ${outcome.exitCode === null ? outcome.signal ?? 'a signal' : `code ${outcome.exitCode}`}${detail === undefined || detail === '' ? '.' : `: ${detail}`}`) }
    return stdout.text
  }
  private async runJson(cwd: string, argv: string[], signal?: AbortSignal): Promise<KubernetesReadResult> { const stdout = await this.read(cwd, argv, signal); let parsed: unknown; try { parsed = JSON.parse(stdout) as unknown } catch (error: unknown) { throw new KubernetesQueryError('invalid_response', 'kubectl returned invalid JSON.', error) }; const value = snapshotJsonValue(parsed); if (value === undefined) throw new KubernetesQueryError('invalid_response', 'kubectl returned a non-JSON value.'); return value as KubernetesReadResult }
}
export default KubectlKubernetesRuntime

function resolveConfig(config: Config): ResolvedConfig {
  const command = argumentValue('command', config.command ?? 'kubectl'); const context = config.context === undefined ? undefined : argumentValue('context', config.context); const kubeconfig = config.kubeconfig === undefined ? undefined : argumentValue('kubeconfig', config.kubeconfig)
  const graceMs = config.graceMs ?? 5_000; const maxOutputBytes = config.maxOutputBytes ?? 2_000_000; const defaultLogTailLines = config.defaultLogTailLines ?? 200; const maxLogTailLines = config.maxLogTailLines ?? 2_000
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2_147_483_647) throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: graceMs must be a positive timer delay.')
  for (const [name, value] of Object.entries({ maxOutputBytes, defaultLogTailLines, maxLogTailLines })) if (!Number.isSafeInteger(value) || value <= 0) throw new KubernetesQueryError('invalid_request', `aiops-kubernetes: ${name} must be a positive safe integer.`)
  if (defaultLogTailLines > maxLogTailLines) throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultLogTailLines must not exceed maxLogTailLines.')
  return { command, ...(context === undefined ? {} : { context }), ...(kubeconfig === undefined ? {} : { kubeconfig }), graceMs, maxOutputBytes, defaultLogTailLines, maxLogTailLines }
}
