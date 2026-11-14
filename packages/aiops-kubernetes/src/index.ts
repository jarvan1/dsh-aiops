/**
 * Read-only Kubernetes service backed by registered cluster agents.
 *
 * There is no host-side kubeconfig and no process-level cluster access: every
 * read is one typed request over the agent WebSocket owned by
 * `ctx.aiopsAgents`. The target cluster comes from the diagnosis (the router
 * binds it from the routed alert's label) and falls back to `defaultCluster`
 * for sessions that were not opened by the router.
 *
 * @module @deepseek-ai/dsh-aiops-kubernetes
 */
import type { Context } from '@deepseek-ai/cordis'
import { AgentQueryError, type AgentReadRequest, type AgentReadResult, type AiopsAgentsApi } from '@deepseek-ai/dsh-aiops-agents'
import z from '@deepseek-ai/schemastery'
import type {
  KubernetesConnectionResult,
  KubernetesConnectionSpec,
  KubernetesEventsRequest,
  KubernetesGetRequest,
  KubernetesListRequest,
  KubernetesLogsRequest,
  KubernetesLogsResult,
  KubernetesLogsSpec,
  KubernetesReadResult,
} from './types.ts'
import {
  absoluteWindow,
  argumentValue,
  KubernetesQueryError,
  KubernetesRuntime,
  resolveLogsRequest,
  validateExecutionTarget,
  validateTarget,
} from './runtime.ts'

export type * from './types.ts'
export * from './runtime.ts'

export interface Config {
  /** Cluster read when a request names none; must be a registered agent name. */
  readonly defaultCluster?: string
  readonly defaultLogTailLines?: number
  readonly maxLogTailLines?: number
}
interface ResolvedConfig { readonly defaultCluster?: string; readonly defaultLogTailLines: number; readonly maxLogTailLines: number }

/** One agent name, matching the registry and `--name` validation. */
const CLUSTER_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/**
 * The Provider half of `ctx.kubernetes`: request validation and shaping stay
 * here, and the closed read set executes on the named cluster's agent.
 */
export class AgentKubernetesRuntime extends KubernetesRuntime {
  static Config: z<Config> = z.object({
    defaultCluster: z.string().default(''),
    defaultLogTailLines: z.number().default(200),
    maxLogTailLines: z.number().default(2_000),
  })

  // Reads need a connected agent; the service only activates once the registry
  // exists, which is also when the Portal can show why a cluster is offline.
  static inject = ['aiopsAgents']

  private source: () => Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx); resolveConfig(config); this.source = () => config
    // DSH 0.2.x projects this plugin entry's `static Config` into the settings
    // UI directly; a committed settings edit reloads the entry with new config.
  }

  override async get(request: KubernetesGetRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request)
    const cluster = resolveCluster(target.cluster, resolveConfig(this.source()))
    const result = await this.read(cluster, {
      op: 'get',
      resource: target.resource,
      name: argumentValue('name', request.name),
      ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
    }, signal)
    return asObject(result)
  }

  override async list(request: KubernetesListRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateTarget(request)
    const cluster = resolveCluster(target.cluster, resolveConfig(this.source()))
    const result = await this.read(cluster, {
      op: 'list',
      resource: target.resource,
      ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
      ...(request.labelSelector === undefined ? {} : { labelSelector: argumentValue('labelSelector', request.labelSelector) }),
      ...(request.fieldSelector === undefined ? {} : { fieldSelector: argumentValue('fieldSelector', request.fieldSelector) }),
    }, signal)
    return asObject(result)
  }

  override async events(request: KubernetesEventsRequest, signal?: AbortSignal): Promise<KubernetesReadResult> {
    const target = validateExecutionTarget(request)
    const window = absoluteWindow(request.sinceTime, request.untilTime)
    const cluster = resolveCluster(target.cluster, resolveConfig(this.source()))
    const result = await this.read(cluster, {
      op: 'events',
      ...(target.namespace === undefined ? {} : { namespace: target.namespace }),
      ...(request.labelSelector === undefined ? {} : { labelSelector: argumentValue('labelSelector', request.labelSelector) }),
      ...(request.fieldSelector === undefined ? {} : { fieldSelector: argumentValue('fieldSelector', request.fieldSelector) }),
      ...(window?.sinceTime === undefined ? {} : { sinceTime: window.sinceTime }),
      ...(window?.untilTime === undefined ? {} : { untilTime: window.untilTime }),
    }, signal)
    return asObject(result)
  }

  override resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec {
    return resolveLogsRequest(request, resolveConfig(this.source()))
  }

  override async logs(spec: KubernetesLogsSpec, signal?: AbortSignal): Promise<KubernetesLogsResult> {
    validateExecutionTarget(spec)
    const cluster = resolveCluster(spec.cluster, resolveConfig(this.source()))
    const result = await this.read(cluster, {
      op: 'logs',
      pod: spec.pod,
      ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
      ...(spec.container === undefined ? {} : { container: spec.container }),
      previous: spec.previous,
      tailLines: spec.tailLines,
      ...(spec.since === undefined ? {} : { since: spec.since }),
      ...(spec.sinceTime === undefined ? {} : { sinceTime: spec.sinceTime }),
      ...(spec.untilTime === undefined ? {} : { untilTime: spec.untilTime }),
      timestamps: spec.timestamps,
    }, signal)
    if (typeof result.data !== 'string') {
      throw new KubernetesQueryError('invalid_response', 'The cluster agent returned a non-text log result.')
    }
    return result.data
  }

  /** Probe one connected agent instead of testing a host-side credential. */
  override async testConnection(spec: KubernetesConnectionSpec, signal?: AbortSignal): Promise<KubernetesConnectionResult> {
    const cluster = resolveCluster(spec.cluster, resolveConfig(this.source()))
    let probe
    try {
      probe = await this.ctx.aiopsAgents.probe(cluster, signal)
    } catch (error: unknown) {
      throw mapAgentError(error)
    }
    return {
      cluster: probe.name,
      agentVersion: probe.version,
      protocol: probe.protocol,
      capabilities: {
        pods: probe.capabilities.resources.includes('pods'),
        events: probe.capabilities.events,
        podLogs: probe.capabilities.logs,
      },
      resources: probe.capabilities.resources,
    }
  }

  private async read(cluster: string, request: AgentReadRequest, signal?: AbortSignal): Promise<AgentReadResult> {
    const agents: AiopsAgentsApi = this.ctx.aiopsAgents
    try {
      return await agents.read(cluster, request, signal)
    } catch (error: unknown) {
      throw mapAgentError(error)
    }
  }
}

export default AgentKubernetesRuntime

function resolveConfig(config: Config): ResolvedConfig {
  const defaultCluster = config.defaultCluster?.trim() ?? ''
  if (defaultCluster !== '' && (defaultCluster.length > 63 || !CLUSTER_RE.test(defaultCluster))) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultCluster must be a lowercase DNS label of at most 63 characters.')
  }
  const defaultLogTailLines = config.defaultLogTailLines ?? 200
  const maxLogTailLines = config.maxLogTailLines ?? 2_000
  for (const [name, value] of Object.entries({ defaultLogTailLines, maxLogTailLines })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new KubernetesQueryError('invalid_request', `aiops-kubernetes: ${name} must be a positive safe integer.`)
    }
  }
  if (defaultLogTailLines > maxLogTailLines) {
    throw new KubernetesQueryError('invalid_request', 'aiops-kubernetes: defaultLogTailLines must not exceed maxLogTailLines.')
  }
  return { ...(defaultCluster === '' ? {} : { defaultCluster }), defaultLogTailLines, maxLogTailLines }
}

/**
 * Pick the cluster one read targets. A name supplied by the diagnosis wins;
 * otherwise the configured default applies. With neither, the diagnosis runs
 * without Kubernetes evidence and the error states why.
 */
function resolveCluster(name: string | undefined, config: ResolvedConfig): string {
  const normalized = name?.trim() ?? ''
  const cluster = normalized === '' ? config.defaultCluster : normalized
  if (cluster === undefined) {
    throw new KubernetesQueryError('unreachable', 'No cluster agent is bound to this diagnosis and aiops-kubernetes has no defaultCluster; Kubernetes evidence is unavailable.')
  }
  if (cluster.length > 63 || !CLUSTER_RE.test(cluster)) {
    throw new KubernetesQueryError('invalid_request', `cluster "${cluster}" must be a lowercase DNS label of at most 63 characters.`)
  }
  return cluster
}

/** An object read must carry a JSON object; logs are the only text result. */
function asObject(result: AgentReadResult): KubernetesReadResult {
  if (result.data === null || Array.isArray(result.data) || typeof result.data !== 'object') {
    throw new KubernetesQueryError('invalid_response', 'The cluster agent returned a non-object Kubernetes result.')
  }
  return result.data as KubernetesReadResult
}

/** Translate the agent taxonomy into the Kubernetes query taxonomy. */
function mapAgentError(error: unknown): KubernetesQueryError {
  if (error instanceof KubernetesQueryError) return error
  if (error instanceof AgentQueryError) return new KubernetesQueryError(error.code, error.message)
  return new KubernetesQueryError('unreachable', error instanceof Error ? error.message : 'Kubernetes cluster agent request failed.')
}
