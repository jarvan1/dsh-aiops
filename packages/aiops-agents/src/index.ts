/**
 * Server-side multi-cluster agent gateway.
 *
 * This plugin owns the `aiopsAgents` service: a durable registry of cluster
 * names and token digests, plus the WebSocket endpoint every Go agent dials
 * outbound. The server never reaches into a cluster; it only answers requests
 * an authenticated agent already offered to serve.
 *
 * @module @deepseek-ai/dsh-aiops-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AiopsAgents, type AgentLimits } from './store.ts'

export type * from './types.ts'
export {
  AGENT_PROTOCOL_VERSION,
  AGENT_TOKEN_PREFIX,
  AGENT_WS_PATH,
  AgentQueryError,
  isAgentToken,
  queryCodeOf,
} from './types.ts'
export { AiopsAgents, AgentRegistryError, aiopsAgentDomainSpec, clusterRecordSchema } from './store.ts'
export type { AgentClusterRecord, AgentLimits, AiopsAgentsApi } from './store.ts'
export { bearerToken, digestMatches, hashAgentToken, issueAgentToken } from './tokens.ts'
export { AgentGateway, isValidClusterName } from './gateway.ts'
export type { AgentHelloFacts, AgentIdentity, AgentLifecycle, GatewayOptions, Logger as AgentLogger } from './gateway.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'aiops-agents'

export interface Config {
  /** Non-revoked clusters the registry accepts. */
  readonly maxClusters?: number
  /** Deadline for one read before the gateway answers `timeout`. */
  readonly requestTimeoutMs?: number
  /** Deadline for `hello` after the socket upgrade. */
  readonly handshakeTimeoutMs?: number
  /** Interval between server pings; an unanswered ping drops the connection. */
  readonly pingIntervalMs?: number
  /** Silence after which a connection is considered dead. */
  readonly idleTimeoutMs?: number
  /** Reads one cluster may have in flight before the gateway sheds load. */
  readonly maxPendingRequests?: number
}

export const Config: z<Config> = z.object({
  maxClusters: z.number().step(1).min(1).max(500).default(50),
  requestTimeoutMs: z.number().step(1).min(1000).max(300_000).default(30_000),
  handshakeTimeoutMs: z.number().step(1).min(1000).max(60_000).default(10_000),
  pingIntervalMs: z.number().step(1).min(5000).max(300_000).default(30_000),
  idleTimeoutMs: z.number().step(1).min(15_000).max(600_000).default(90_000),
  maxPendingRequests: z.number().step(1).min(1).max(1024).default(32),
})

function limitsOf(config: Config): AgentLimits {
  return {
    maxClusters: config.maxClusters ?? 50,
    requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
    handshakeTimeoutMs: config.handshakeTimeoutMs ?? 10_000,
    pingIntervalMs: config.pingIntervalMs ?? 30_000,
    idleTimeoutMs: config.idleTimeoutMs ?? 90_000,
    maxPendingRequests: config.maxPendingRequests ?? 32,
  }
}

/** Mount the registry service; it registers the agent WebSocket route itself. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  await ctx.plugin(AiopsAgents, limitsOf(config))
}
