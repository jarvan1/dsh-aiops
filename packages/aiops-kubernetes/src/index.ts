/** Read-only Kubernetes service and native API provider. */
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { AppsV1Api, AuthorizationV1Api, BatchV1Api, CoreV1Api, KubeConfig, Log, VersionApi } from '@kubernetes/client-node'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { KubernetesConnectionResult, KubernetesConnectionSpec, KubernetesEventsRequest, KubernetesGetRequest, KubernetesListRequest, KubernetesLogsRequest, KubernetesLogsResult, KubernetesLogsSpec, KubernetesReadResult } from './types.ts'
import { absoluteWindow, argumentValue, filterEventList, filterTimestampedLogLines, KubernetesQueryError, KubernetesRuntime, resolveLogsRequest, validateExecutionTarget, validateTarget } from './runtime.ts'

export type * from './types.ts'
export * from './runtime.ts'
export { KubectlKubernetesRuntime } from './kubectl.ts'

export interface Config extends KubernetesConnectionSpec {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly defaultLogTailLines?: number
  readonly maxLogTailLines?: number
}
interface ResolvedConfig { readonly kubeconfig?: string; readonly context?: string; readonly timeoutMs: number; readonly maxResponseBytes: number; readonly defaultLogTailLines: number; readonly maxLogTailLines: number }
type ApiClient = Record<string, (param: Record<string, unknown>) => Promise<unknown>>
type ApiKind = 'core' | 'apps' | 'batch'
interface ResourceDescriptor { readonly api: ApiKind; readonly namespaced: boolean; readonly read: string; readonly list: string }

const RESOURCES: Readonly<Record<string, ResourceDescriptor>> = {
  pod: namespaced('core', 'Pod'), pods: namespaced('core', 'Pod'),
  service: namespaced('core', 'Service'), services: namespaced('core', 'Service'),
  endpoint: namespaced('core', 'Endpoints'), endpoints: namespaced('core', 'Endpoints'),
  configmap: namespaced('core', 'ConfigMap'), configmaps: namespaced('core', 'ConfigMap'),
  persistentvolumeclaim: namespaced('core', 'PersistentVolumeClaim'), persistentvolumeclaims: namespaced('core', 'PersistentVolumeClaim'), pvc: namespaced('core', 'PersistentVolumeClaim'),
  node: cluster('core', 'Node'), nodes: cluster('core', 'Node'),
  namespace: cluster('core', 'Namespace'), namespaces: cluster('core', 'Namespace'),
  persistentvolume: cluster('core', 'PersistentVolume'), persistentvolumes: cluster('core', 'PersistentVolume'), pv: cluster('core', 'PersistentVolume'),
  deployment: namespaced('apps', 'Deployment'), deployments: namespaced('apps', 'Deployment'),
  statefulset: namespaced('apps', 'StatefulSet'), statefulsets: namespaced('apps', 'StatefulSet'),
  daemonset: namespaced('apps', 'DaemonSet'), daemonsets: namespaced('apps', 'DaemonSet'),
  replicaset: namespaced('apps', 'ReplicaSet'), replicasets: namespaced('apps', 'ReplicaSet'),
  job: namespaced('batch', 'Job'), jobs: namespaced('batch', 'Job'),
  cronjob: namespaced('batch', 'CronJob'), cronjobs: namespaced('batch', 'CronJob'),
}

export class NativeKubernetesRuntime extends KubernetesRuntime {
  static Config: z<Config> = z.object({
    kubeconfig: z.string().default(''), context: z.string().default(''), timeoutMs: z.number().default(30_000),
    maxResponseBytes: z.number().default(2_000_000), defaultLogTailLines: z.number().default(200), maxLogTailLines: z.number().default(2_000),
  })
  private source: () => Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx); resolveConfig(config); this.source = () => config
    ctx.inject(['settings'], settingsCtx => settingsCtx.settings.installSection(ctx, 'aiops-kubernetes', NativeKubernetesRuntime.Config, config, {
      validate: resolveConfig, setSource: current => { this.source = current }, onChange: () => {},
    }))
  }

  override async get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request); const descriptor = resourceDescriptor(target.resource); const config = resolveConfig(this.source()); const connection = loadConnection(config)
    const param: Record<string, unknown> = { name: argumentValue('name', request.name) }
    if (descriptor.namespaced) param['namespace'] = target.namespace ?? connection.namespace
    return this.invokeJson(apiClient(connection.kubeConfig, descriptor.api), descriptor.read, param, config, signal)
  }

  override async list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request); const descriptor = resourceDescriptor(target.resource); const config = resolveConfig(this.source()); const connection = loadConnection(config)
    const param: Record<string, unknown> = { ...(request.labelSelector === undefined ? {} : { labelSelector: argumentValue('labelSelector', request.labelSelector) }), ...(request.fieldSelector === undefined ? {} : { fieldSelector: argumentValue('fieldSelector', request.fieldSelector) }) }
    if (descriptor.namespaced) param['namespace'] = target.namespace ?? connection.namespace
    return this.invokeJson(apiClient(connection.kubeConfig, descriptor.api), descriptor.list, param, config, signal)
  }

  override async events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateExecutionTarget(request); const window = absoluteWindow(request.sinceTime, request.untilTime); const config = resolveConfig(this.source()); const connection = loadConnection(config)
    const result = await this.call(() => connection.kubeConfig.makeApiClient(CoreV1Api).listNamespacedEvent({ namespace: target.namespace ?? connection.namespace, ...(request.labelSelector === undefined ? {} : { labelSelector: argumentValue('labelSelector', request.labelSelector) }), ...(request.fieldSelector === undefined ? {} : { fieldSelector: argumentValue('fieldSelector', request.fieldSelector) }) }), config.timeoutMs, signal)
    return filterEventList(this.toJson(result, config.maxResponseBytes), window)
  }

  override resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec { return resolveLogsRequest(request, resolveConfig(this.source())) }

  override async logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult> {
    validateExecutionTarget(spec); const config = resolveConfig(this.source()); const connection = loadConnection(config)
    const sinceSeconds = spec.since === undefined ? undefined : durationSeconds(spec.since)
    const output = await this.call(() => readNativeLog(connection.kubeConfig, spec.namespace ?? connection.namespace, spec, config.maxResponseBytes, sinceSeconds), config.timeoutMs, signal)
    return spec.untilTime === undefined ? output : filterTimestampedLogLines(output, spec.untilTime)
  }

  override async testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult> {
    const base = resolveConfig(this.source()); const config = resolveConfig({ ...base, ...(spec.kubeconfig === undefined ? {} : { kubeconfig: spec.kubeconfig }), ...(spec.context === undefined ? {} : { context: spec.context }) }); const connection = loadConnection(config)
    const version = await this.call(() => connection.kubeConfig.makeApiClient(VersionApi).getCode({}), config.timeoutMs, signal)
    if (typeof version.gitVersion !== 'string') throw new KubernetesQueryError('invalid_response', 'Kubernetes version endpoint returned an invalid response.')
    const authorization = connection.kubeConfig.makeApiClient(AuthorizationV1Api)
    const checks = await Promise.all([
      this.call(() => accessReview(authorization, connection.namespace, 'get', 'pods'), config.timeoutMs, signal),
      this.call(() => accessReview(authorization, connection.namespace, 'list', 'events'), config.timeoutMs, signal),
      this.call(() => accessReview(authorization, connection.namespace, 'get', 'pods', 'log'), config.timeoutMs, signal),
    ])
    return { context: connection.context, cluster: connection.cluster, namespace: connection.namespace, server: connection.server, capabilities: { pods: checks[0]!, events: checks[1]!, podLogs: checks[2]! } }
  }

  private async invokeJson(client: ApiClient, method: string, param: Record<string, unknown>, config: ResolvedConfig, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const invoke = client[method]
    if (typeof invoke !== 'function') throw new KubernetesQueryError('unsupported_resource', `Kubernetes method ${method} is unavailable.`)
    return this.toJson(await this.call(() => invoke.call(client, param), config.timeoutMs, signal), config.maxResponseBytes)
  }
  private toJson(value: unknown, maxBytes: number): KubernetesReadResult {
    let serialized: string | undefined; try { serialized = JSON.stringify(value) } catch (error: unknown) { throw new KubernetesQueryError('invalid_response', 'Kubernetes returned a non-JSON response.', error) }
    if (serialized === undefined) throw new KubernetesQueryError('invalid_response', 'Kubernetes returned a non-JSON value.')
    if (Buffer.byteLength(serialized) > maxBytes) throw new KubernetesQueryError('response_too_large', `Kubernetes response exceeds ${maxBytes} bytes.`)
    const result = snapshotJsonValue(JSON.parse(serialized) as unknown); if (result === undefined) throw new KubernetesQueryError('invalid_response', 'Kubernetes returned a non-JSON value.')
    return result as KubernetesReadResult
  }
  private async call<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> { try { return await withDeadline(operation, timeoutMs, signal) } catch (error: unknown) { throw mapKubernetesError(error, timeoutMs) } }
}

export default NativeKubernetesRuntime

function namespaced(api: ApiKind, kind: string): ResourceDescriptor { return { api, namespaced: true, read: `readNamespaced${kind}`, list: `listNamespaced${kind}` } }
function cluster(api: ApiKind, kind: string): ResourceDescriptor { return { api, namespaced: false, read: `read${kind}`, list: `list${kind}` } }

function resolveConfig(config: Config): ResolvedConfig {
  const kubeconfig = optionalText(config.kubeconfig); const context = optionalText(config.context)
  if (kubeconfig !== undefined && !isAbsolute(kubeconfig)) throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: kubeconfig must be an absolute server-side path.')
  const timeoutMs = config.timeoutMs ?? 30_000; const maxResponseBytes = config.maxResponseBytes ?? 2_000_000; const defaultLogTailLines = config.defaultLogTailLines ?? 200; const maxLogTailLines = config.maxLogTailLines ?? 2_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: timeoutMs must be a positive timer delay.')
  for (const [name, value] of Object.entries({ maxResponseBytes, defaultLogTailLines, maxLogTailLines })) if (!Number.isSafeInteger(value) || value <= 0) throw new KubernetesQueryError('invalid_request', `aiops-kubernetes: ${name} must be a positive safe integer.`)
  if (defaultLogTailLines > maxLogTailLines) throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultLogTailLines must not exceed maxLogTailLines.')
  return { ...(kubeconfig === undefined ? {} : { kubeconfig }), ...(context === undefined ? {} : { context }), timeoutMs, maxResponseBytes, defaultLogTailLines, maxLogTailLines }
}
function optionalText(value: string | undefined): string | undefined { const normalized = value?.trim() ?? ''; return normalized === '' ? undefined : normalized }

function loadConnection(config: Pick<ResolvedConfig, 'kubeconfig' | 'context'>) {
  const kubeConfig = new KubeConfig()
  try { if (config.kubeconfig === undefined) kubeConfig.loadFromDefault(); else kubeConfig.loadFromFile(config.kubeconfig) } catch (error: unknown) { throw new KubernetesQueryError('invalid_request', 'Unable to load the configured kubeconfig file.', error) }
  if (config.context !== undefined) { if (kubeConfig.getContextObject(config.context) === null) throw new KubernetesQueryError('invalid_request', `Kubernetes context "${config.context}" does not exist in the kubeconfig.`); kubeConfig.setCurrentContext(config.context) }
  const context = kubeConfig.getCurrentContext(); const contextObject = kubeConfig.getContextObject(context); const clusterObject = kubeConfig.getCurrentCluster()
  if (context === '' || contextObject === null || clusterObject === null) throw new KubernetesQueryError('invalid_request', 'The kubeconfig has no usable current context and cluster.')
  return { kubeConfig, context, cluster: contextObject.cluster, namespace: contextObject.namespace?.trim() || 'default', server: clusterObject.server }
}
function resourceDescriptor(resource: string): ResourceDescriptor { const descriptor = RESOURCES[resource.toLowerCase()]; if (descriptor === undefined) throw new KubernetesQueryError('unsupported_resource', `Native Kubernetes provider does not support resource "${resource}".`); return descriptor }
function apiClient(kubeConfig: KubeConfig, api: ApiKind): ApiClient { return (api === 'core' ? kubeConfig.makeApiClient(CoreV1Api) : api === 'apps' ? kubeConfig.makeApiClient(AppsV1Api) : kubeConfig.makeApiClient(BatchV1Api)) as unknown as ApiClient }

async function accessReview(api: AuthorizationV1Api, namespace: string, verb: string, resource: string, subresource?: string): Promise<boolean> {
  const result = await api.createSelfSubjectAccessReview({ body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes: { group: '', namespace, verb, resource, ...(subresource === undefined ? {} : { subresource }) } } } })
  return result.status?.allowed === true
}
function readNativeLog(kubeConfig: KubeConfig, namespace: string, spec: KubernetesLogsSpec, maxBytes: number, sinceSeconds?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0
    const sink = new Writable({ write(chunk: Buffer | string, _encoding, done) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += value.byteLength
      if (bytes > maxBytes) { done(new KubernetesQueryError('response_too_large', `Kubernetes log response exceeds ${maxBytes} bytes.`)); return }
      chunks.push(value); done()
    } })
    sink.once('finish', () => resolve(Buffer.concat(chunks, bytes).toString('utf8')))
    sink.once('error', reject)
    void new Log(kubeConfig).log(namespace, spec.pod, spec.container ?? '', sink, {
      follow: false, limitBytes: maxBytes + 1, previous: spec.previous, tailLines: spec.tailLines, timestamps: spec.timestamps,
      ...(sinceSeconds === undefined ? {} : { sinceSeconds }), ...(spec.sinceTime === undefined ? {} : { sinceTime: spec.sinceTime }),
    }).catch(reject)
  })
}
function durationSeconds(value: string): number { const match = /^(\d+)(s|m|h|d)$/.exec(value.trim()); if (match === null) throw new KubernetesQueryError('invalid_request', 'since must be a Kubernetes duration such as 30s, 15m, 2h, or 1d.'); const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3_600, d: 86_400 }[match[2]!]!); if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new KubernetesQueryError('invalid_request', 'since duration is out of range.'); return seconds }

function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return }
    const timer = setTimeout(() => reject(new Error('KUBERNETES_TIMEOUT')), timeoutMs); const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); signal?.addEventListener('abort', abort, { once: true })
    operation().then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
  })
}
function mapKubernetesError(error: unknown, timeoutMs: number): KubernetesQueryError {
  if (error instanceof KubernetesQueryError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'KUBERNETES_TIMEOUT') return new KubernetesQueryError('timeout', `Kubernetes request exceeded ${timeoutMs}ms.`, error)
  if (error instanceof DOMException && error.name === 'AbortError') return new KubernetesQueryError('timeout', 'Kubernetes request was cancelled.', error)
  const status = httpStatus(error)
  if (status === 401) return new KubernetesQueryError('authentication_failed', 'Kubernetes rejected the configured credentials.', error)
  if (status === 403) return new KubernetesQueryError('forbidden', 'Kubernetes denied the requested read operation.', error)
  if (status === 404) return new KubernetesQueryError('not_found', 'The requested Kubernetes object was not found.', error)
  if (/ENOENT|not found|cannot find/i.test(message) && /exec|spawn|command/i.test(message)) return new KubernetesQueryError('credential_exec_missing', 'The kubeconfig credential exec command is not installed on the DSH host.', error)
  return new KubernetesQueryError('unreachable', 'Kubernetes API request failed.', error)
}
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  for (const key of ['statusCode', 'status', 'code']) { const value = Reflect.get(error, key); if (typeof value === 'number') return value }
  const response = Reflect.get(error, 'response'); if (typeof response === 'object' && response !== null) { const status = Reflect.get(response, 'status'); if (typeof status === 'number') return status }
  return undefined
}
