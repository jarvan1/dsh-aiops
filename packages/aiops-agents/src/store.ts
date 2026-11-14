/**
 * Durable cluster-agent registry and the `aiopsAgents` service.
 *
 * One record per cluster names the cluster, keeps only the token digest and
 * its last four characters, and records the last handshake. Live connections
 * are process state, not durable state: the durable row is what lets the
 * Portal show `pending`/`offline` after a restart.
 *
 * @module @deepseek-ai/dsh-aiops-agents/src/store
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { AgentGateway, isValidClusterName } from './gateway.ts'
import type { AgentIdentity, Logger } from './gateway.ts'
import { AGENT_WS_PATH, type AgentCapabilities, type AgentClusterStatus, type AgentClusterView, type AgentProbeResult, type AgentReadRequest, type AgentReadResult, type AgentTokenIssuance } from './types.ts'
import { digestMatches, hashAgentToken, issueAgentToken } from './tokens.ts'

const MAX_TOKEN_LAST4 = 4

const capabilitiesSchema = z.object({
  resources: z.array(z.string().min(1).max(64)).max(64),
  events: z.boolean(),
  logs: z.boolean(),
  maxResponseBytes: z.number().int().positive().safe(),
  maxTailLines: z.number().int().positive().safe(),
}).strict()

/** Storage-domain record schema for one cluster. */
export const clusterRecordSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenLast4: z.string().length(MAX_TOKEN_LAST4),
  createdAt: z.number().int().nonnegative().safe(),
  lastSeenAt: z.number().int().nonnegative().safe().optional(),
  revokedAt: z.number().int().nonnegative().safe().optional(),
  agentVersion: z.string().min(1).max(64).optional(),
  protocol: z.number().int().positive().optional(),
  capabilities: capabilitiesSchema.optional(),
  desiredVersion: z.string().min(1).max(64).optional(),
}).strict()

/** Persisted cluster row. */
export type AgentClusterRecord = z.infer<typeof clusterRecordSchema>

/**
 * One `aiops_agent` domain. `per-record` keeps each cluster independently
 * durable, and `backup-and-skip` treats a record that fails today's schema as
 * absent instead of refusing to open the domain.
 */
export const aiopsAgentDomainSpec = defineDomain({
  name: 'aiops_agent',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    clusters: domainTable<string, AgentClusterRecord>(clusterRecordSchema),
  },
})

/** Registry failures an HTTP layer maps onto status codes. */
export class AgentRegistryError extends Error {
  readonly code: 'invalid_name' | 'invalid_version' | 'cluster_exists' | 'cluster_not_found' | 'cluster_limit_reached' | 'token_not_reissuable'
  constructor(code: AgentRegistryError['code'], message: string) {
    super(message)
    this.name = 'AgentRegistryError'
    this.code = code
  }
}

/** The registry surface the Portal and the future agent-backed provider use. */
export interface AiopsAgentsApi {
  /** Every cluster row, ordered by name. Revoked rows stay visible. */
  listClusters(): AgentClusterView[]
  /** One row, or undefined when the name was never issued. */
  cluster(name: string): AgentClusterView | undefined
  /** Whether at least one non-revoked cluster exists. */
  configured(): boolean
  /** Issue a token for a new cluster, or for a revoked name being taken over. */
  createCluster(name: string): Promise<AgentTokenIssuance>
  /** Replace the token of a cluster that has never connected. */
  reissueToken(name: string): Promise<AgentTokenIssuance>
  /** Revoke a cluster: the token stops working and a live agent is dropped. */
  revokeCluster(name: string): Promise<AgentClusterView>
  /** Set the version an agent should run; reported to it on the next hello. */
  setDesiredVersion(name: string, version: string | undefined): Promise<AgentClusterView>
  /**
   * Prepare a rollout: persist the target version, then drain the live agent so
   * in-flight reads finish while new reads fail over. The operator applies the
   * image; a reconnecting agent reports the new version.
   */
  upgradeCluster(name: string, targetVersion: string): Promise<AgentClusterView>
  /** Allow reads again after a cancelled rollout. */
  resumeCluster(name: string): Promise<AgentClusterView>
  /** Ask the connected agent to describe itself. */
  probe(name: string, signal?: AbortSignal): Promise<AgentProbeResult>
  /** Run one bounded read through the connected agent. */
  read(name: string, request: AgentReadRequest, signal?: AbortSignal): Promise<AgentReadResult>
  /** Whether a validated agent connection is live for this cluster. */
  isConnected(name: string): boolean
  /** Whether the live agent is draining for a rollout. */
  isDraining(name: string): boolean
}

/** Registry limits; each is enforced before a record or a read is accepted. */
export interface AgentLimits {
  readonly maxClusters: number
  readonly requestTimeoutMs: number
  readonly handshakeTimeoutMs: number
  readonly pingIntervalMs: number
  readonly idleTimeoutMs: number
  readonly maxPendingRequests: number
}

const DEFAULT_LIMITS: AgentLimits = {
  maxClusters: 50,
  requestTimeoutMs: 30_000,
  handshakeTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  idleTimeoutMs: 90_000,
  maxPendingRequests: 32,
}

/** How often a heartbeat is allowed to rewrite the durable `lastSeenAt`. */
const SEEN_WRITE_INTERVAL_MS = 60_000

/**
 * The `aiopsAgents` service: opens the registry domain, mounts the WebSocket
 * gateway at the agent path, and serves both the Portal read model and the
 * provider read path.
 */
export class AiopsAgents extends Service implements AiopsAgentsApi {
  static inject = ['storageDomain']

  private readonly limits: AgentLimits
  private readonly logger: Logger
  private clusters!: KvTable<string, AgentClusterRecord>
  private gateway!: AgentGateway
  /** Token digest → cluster name. Rebuilt from the domain on every change. */
  private tokens = new Map<string, string>()
  /** Set before the storage domain closes; late socket callbacks must not read it. */
  private closed = false

  constructor(ctx: Context, limits: Partial<AgentLimits> = {}) {
    super(ctx, 'aiopsAgents')
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.logger = {
      warn: (message: unknown) => { ctx.logger?.warn(message) },
      info: (message: unknown) => { ctx.logger?.info(message) },
    }
  }

  async [Service.init](): Promise<void> {
    const domain: Domain<DomainSpec> = await this.ctx.storageDomain.open(aiopsAgentDomainSpec)
    this.ctx.effect(() => () => void domain.close(), 'aiopsAgents.domainClose')
    this.clusters = domain.table('clusters') as KvTable<string, AgentClusterRecord>
    this.reindex()

    this.gateway = new AgentGateway({
      authenticate: token => this.authenticate(token),
      onConnected: (identity, hello) => { void this.markConnected(identity, hello) },
      onHeartbeat: (name, heartbeat) => { void this.markHeartbeat(name, heartbeat.version) },
      onDisconnected: name => { if (!this.closed) this.viewOf(name) },
      onFailure: (name, reason) => { this.logger.warn(`agent ${name}: ${reason}`) },
      logger: this.logger,
      requestTimeoutMs: this.limits.requestTimeoutMs,
      handshakeTimeoutMs: this.limits.handshakeTimeoutMs,
      pingIntervalMs: this.limits.pingIntervalMs,
      idleTimeoutMs: this.limits.idleTimeoutMs,
      maxPendingRequests: this.limits.maxPendingRequests,
    })
    this.ctx.effect(() => () => {
      this.closed = true
      this.gateway.close()
    }, 'aiopsAgents.gatewayClose')

    this.ctx.inject(['webServer'], webCtx => {
      webCtx.effect(() => webCtx.webServer.registerUpgrade({
        path: AGENT_WS_PATH,
        handler: (req, socket, head) => { this.gateway.accept(req, socket, head) },
      }), `aiops-agents: ${AGENT_WS_PATH}`)
    })
  }

  listClusters(): AgentClusterView[] {
    const views: AgentClusterView[] = []
    for (const [, record] of this.clusters.entries()) views.push(this.view(record))
    return views.sort((left, right) => left.name.localeCompare(right.name))
  }

  cluster(name: string): AgentClusterView | undefined {
    const record = this.clusters.get(name)
    return record === undefined ? undefined : this.view(record)
  }

  configured(): boolean {
    for (const [, record] of this.clusters.entries()) if (record.revokedAt === undefined) return true
    return false
  }

  async createCluster(name: string): Promise<AgentTokenIssuance> {
    if (!isValidClusterName(name)) {
      throw new AgentRegistryError('invalid_name', 'cluster name must be a lowercase DNS label of at most 63 characters')
    }
    const existing = this.clusters.get(name)
    if (existing !== undefined && existing.revokedAt === undefined) {
      throw new AgentRegistryError('cluster_exists', `cluster ${name} already has an active token`)
    }
    if (existing === undefined && !this.withinClusterLimit()) {
      throw new AgentRegistryError('cluster_limit_reached', `the registry already holds ${this.limits.maxClusters} clusters`)
    }
    const issued = issueAgentToken()
    // A revoked name is taken over by a fresh record: the old digest is gone,
    // and the row starts again from `pending`.
    const record: AgentClusterRecord = {
      name,
      tokenHash: issued.hash,
      tokenLast4: issued.last4,
      createdAt: Date.now(),
    }
    await this.clusters.put(name, record)
    this.tokens.set(issued.hash, name)
    this.emitChanged(record)
    return { cluster: this.view(record), token: issued.token }
  }

  async reissueToken(name: string): Promise<AgentTokenIssuance> {
    const record = this.clusters.get(name)
    if (record === undefined || record.revokedAt !== undefined) {
      throw new AgentRegistryError('cluster_not_found', `cluster ${name} has no active token`)
    }
    if (record.lastSeenAt !== undefined || this.gateway.isConnected(name)) {
      throw new AgentRegistryError('token_not_reissuable', 'a cluster that has connected keeps its token; revoke it and issue a new one')
    }
    const issued = issueAgentToken()
    // Retire the old digest before the durable swap so a reconnect racing this
    // call cannot authenticate with the token that is being replaced.
    this.tokens.delete(record.tokenHash)
    const next = await this.clusters.update(name, current => ({
      ...current,
      tokenHash: issued.hash,
      tokenLast4: issued.last4,
    }))
    this.tokens.set(issued.hash, name)
    this.emitChanged(next)
    return { cluster: this.view(next), token: issued.token }
  }

  async revokeCluster(name: string): Promise<AgentClusterView> {
    const record = this.clusters.get(name)
    if (record === undefined) throw new AgentRegistryError('cluster_not_found', `cluster ${name} is not registered`)
    // Refuse reconnects immediately: removing the digest is what makes the
    // token dead, and only then is the live socket dropped and the row updated.
    this.tokens.delete(record.tokenHash)
    this.gateway.disconnect(name)
    const next = await this.clusters.update(name, current => ({
      ...current,
      revokedAt: current.revokedAt ?? Date.now(),
    }))
    this.emitChanged(next)
    return this.view(next)
  }

  async upgradeCluster(name: string, targetVersion: string): Promise<AgentClusterView> {
    const version = targetVersion.trim()
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) {
      throw new AgentRegistryError('invalid_version', 'target version must be 1 to 64 characters of letters, digits, dot, underscore, plus, or hyphen')
    }
    await this.setDesiredVersion(name, version)
    // Draining is best effort: an offline cluster picks the target version up
    // on its next hello, and a read against a draining agent fails explicitly.
    this.gateway.drain(name)
    return this.cluster(name) ?? this.requireCluster(name)
  }

  async resumeCluster(name: string): Promise<AgentClusterView> {
    this.requireCluster(name)
    this.gateway.resume(name)
    return this.cluster(name) ?? this.requireCluster(name)
  }

  /** Whether the live agent is draining for a rollout. */
  isDraining(name: string): boolean {
    return this.gateway.isDraining(name)
  }

  async setDesiredVersion(name: string, version: string | undefined): Promise<AgentClusterView> {
    const record = this.clusters.get(name)
    if (record === undefined) throw new AgentRegistryError('cluster_not_found', `cluster ${name} is not registered`)
    const next = await this.clusters.update(name, current => {
      const updated: AgentClusterRecord = { ...current }
      if (version === undefined) delete updated.desiredVersion
      else updated.desiredVersion = version
      return updated
    })
    this.emitChanged(next)
    return this.view(next)
  }

  probe(name: string, signal?: AbortSignal): Promise<AgentProbeResult> {
    return this.gateway.probe(name, signal)
  }

  read(name: string, request: AgentReadRequest, signal?: AbortSignal): Promise<AgentReadResult> {
    return this.gateway.read(name, request, signal)
  }

  isConnected(name: string): boolean {
    return this.gateway.isConnected(name)
  }

  /** Resolve a presented token. Called synchronously from the upgrade path. */
  private authenticate(token: string): AgentIdentity | undefined {
    const digest = hashAgentToken(token)
    const name = this.tokens.get(digest)
    if (name === undefined) return undefined
    const record = this.clusters.get(name)
    if (record === undefined || record.revokedAt !== undefined) return undefined
    if (!digestMatches(digest, record.tokenHash)) return undefined
    return { name, ...(record.desiredVersion === undefined ? {} : { desiredVersion: record.desiredVersion }) }
  }

  private async markConnected(identity: AgentIdentity, hello: { version: string; capabilities: AgentCapabilities }): Promise<void> {
    const now = Date.now()
    try {
      const next = await this.clusters.update(identity.name, current => ({
        ...current,
        lastSeenAt: now,
        agentVersion: hello.version,
        protocol: 1,
        capabilities: hello.capabilities,
      }))
      this.emitChanged(next)
      this.logger.info?.(`agent ${identity.name} connected (version ${hello.version})`)
    } catch (error: unknown) {
      this.logger.warn(`recording agent ${identity.name} connection failed: ${errorText(error)}`)
    }
  }

  private async markHeartbeat(name: string, version: string): Promise<void> {
    const record = this.clusters.get(name)
    // Heartbeats arrive every few seconds; only refresh the durable row when
    // the timestamp is actually stale, so a quiet cluster does not churn disk.
    if (record === undefined || (record.lastSeenAt !== undefined && Date.now() - record.lastSeenAt < SEEN_WRITE_INTERVAL_MS)) return
    try {
      await this.clusters.update(name, current => ({
        ...current,
        lastSeenAt: Date.now(),
        ...(current.agentVersion === undefined ? { agentVersion: version } : {}),
      }))
    } catch (error: unknown) {
      this.logger.warn(`recording agent ${name} heartbeat failed: ${errorText(error)}`)
    }
  }

  private withinClusterLimit(): boolean {
    let active = 0
    for (const [, record] of this.clusters.entries()) if (record.revokedAt === undefined) active += 1
    return active < this.limits.maxClusters
  }

  private reindex(): void {
    this.tokens.clear()
    for (const [, record] of this.clusters.entries()) {
      if (record.revokedAt === undefined) this.tokens.set(record.tokenHash, record.name)
    }
  }

  private viewOf(name: string): AgentClusterView | undefined {
    const cluster = this.cluster(name)
    this.ctx.emit('aiopsAgents/changed', cluster)
    return cluster
  }

  private requireCluster(name: string): AgentClusterView {
    const cluster = this.cluster(name)
    if (cluster === undefined) throw new AgentRegistryError('cluster_not_found', `cluster ${name} is not registered`)
    return cluster
  }

  private view(record: AgentClusterRecord): AgentClusterView {
    const connected = this.gateway?.isConnected(record.name) === true
    const status: AgentClusterStatus = record.revokedAt !== undefined ? 'revoked'
      : connected ? 'connected'
        : record.lastSeenAt === undefined ? 'pending' : 'offline'
    return {
      name: record.name,
      status,
      createdAt: record.createdAt,
      ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
      ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
      ...(record.agentVersion === undefined ? {} : { agentVersion: record.agentVersion }),
      ...(record.protocol === undefined ? {} : { protocol: record.protocol }),
      ...(record.capabilities === undefined ? {} : { capabilities: record.capabilities }),
      ...(record.desiredVersion === undefined ? {} : { desiredVersion: record.desiredVersion }),
      ...(connected && this.gateway.isDraining(record.name) ? { draining: true } : {}),
    }
  }

  private emitChanged(record: AgentClusterRecord): void {
    this.ctx.emit('aiopsAgents/changed', this.view(record))
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable cluster-agent registry and read gateway (the `aiopsAgents` service). */
    aiopsAgents: AiopsAgentsApi
  }
  interface Events {
    /** Emitted after a cluster row changes; carries the current public view. */
    'aiopsAgents/changed'(cluster: AgentClusterView | undefined): void
  }
}
