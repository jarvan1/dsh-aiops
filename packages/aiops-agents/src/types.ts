/**
 * Wire protocol and registry shapes shared by the server-side agent gateway.
 *
 * The protocol is the TypeScript half of `agent/internal/protocol/messages.go`:
 * one major version, a closed message set, and a closed error-code taxonomy.
 * Field names are wire names, not TypeScript conventions; changing one is a
 * protocol change and must land in the Go agent in the same release.
 *
 * @module @deepseek-ai/dsh-aiops-agents/src/types
 */

/** WebSocket path the Go agent dials. */
export const AGENT_WS_PATH = '/api/aiops/agent'

/** Protocol major version implemented here. The agent rejects any other value. */
export const AGENT_PROTOCOL_VERSION = 1

/** Prefix on every server-issued agent token; it makes leaked tokens greppable. */
export const AGENT_TOKEN_PREFIX = 'dsha_'

/** Agent token characters after the prefix: 32 random bytes, base64url. */
const AGENT_TOKEN_BODY_RE = /^[A-Za-z0-9_-]{43}$/

/** Closed read-operation set. Anything else is rejected before reaching the agent. */
export type AgentReadOp = 'get' | 'list' | 'events' | 'logs'

/** Closed failure taxonomy shared with the agent and the Kubernetes query layer. */
export type AgentQueryErrorCode =
  | 'invalid_request'
  | 'unsupported_resource'
  | 'not_found'
  | 'forbidden'
  | 'authentication_failed'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_response'
  | 'unreachable'

/** `busy` is the agent's load shedding answer; the registry reports it as unreachable. */
export type AgentWireErrorCode = AgentQueryErrorCode | 'busy'

/** What an agent advertises so the server can render a row without a probe. */
export interface AgentCapabilities {
  readonly resources: string[]
  readonly events: boolean
  readonly logs: boolean
  readonly maxResponseBytes: number
  readonly maxTailLines: number
}

/** One bounded read; `op` decides which fields are required. */
export interface AgentReadRequest {
  readonly op: AgentReadOp
  readonly resource?: string
  readonly namespace?: string
  readonly name?: string
  readonly labelSelector?: string
  readonly fieldSelector?: string
  readonly sinceTime?: string
  readonly untilTime?: string
  readonly pod?: string
  readonly container?: string
  readonly previous?: boolean
  readonly tailLines?: number
  readonly since?: string
  readonly timestamps?: boolean
}

/** Answer to one read: raw Kubernetes JSON for get/list/events, text for logs. */
export interface AgentReadResult {
  readonly data: unknown
  readonly truncated: boolean
}

/** Agent self-description returned by `probe`. */
export interface AgentProbeResult {
  readonly name: string
  readonly version: string
  readonly protocol: number
  readonly capabilities: AgentCapabilities
}

/** Emitted on `hello`, before any request is answered. */
export interface AgentHello {
  readonly type: 'hello'
  readonly protocol: number
  readonly name: string
  readonly version: string
  readonly capabilities: AgentCapabilities
}

/** Periodic liveness and load report. */
export interface AgentHeartbeat {
  readonly type: 'heartbeat'
  readonly version: string
  readonly inflight: number
}

/** Answer to one read or probe. */
export interface AgentResult {
  readonly type: 'result'
  readonly id: string
  readonly ok: boolean
  readonly data?: unknown
  readonly truncated?: boolean
  readonly code?: string
  readonly message?: string
}

/** Server → agent messages. The agent treats an unknown type as fatal. */
export interface AgentWelcome {
  readonly type: 'welcome'
  readonly protocol: number
  readonly clientId: string
  readonly desiredVersion?: string
}

export interface AgentWireRead extends AgentReadRequest {
  readonly type: 'read'
  readonly id: string
}

export interface AgentWireProbe {
  readonly type: 'probe'
  readonly id: string
}

export interface AgentWireUpgrade {
  readonly type: 'upgrade'
  readonly id: string
  readonly targetVersion: string
}

export interface AgentWireDrain {
  readonly type: 'drain'
}

export interface AgentWireResume {
  readonly type: 'resume'
}

export interface AgentWireError {
  readonly type: 'error'
  readonly code: string
  readonly message: string
}

export type AgentServerMessage =
  | AgentWelcome
  | AgentWireRead
  | AgentWireProbe
  | AgentWireUpgrade
  | AgentWireDrain
  | AgentWireResume
  | AgentWireError

/**
 * Lifecycle a cluster row shows. `pending` means a token was issued but no
 * agent ever completed a handshake; `offline` means one did and is not here now.
 */
export type AgentClusterStatus = 'pending' | 'connected' | 'offline' | 'revoked'

/** Public cluster row. It never carries the token or its hash. */
export interface AgentClusterView {
  readonly name: string
  readonly status: AgentClusterStatus
  readonly createdAt: number
  readonly lastSeenAt?: number
  readonly revokedAt?: number
  readonly agentVersion?: string
  readonly protocol?: number
  readonly capabilities?: AgentCapabilities
  /** Version the operator asked this cluster to run, if any. */
  readonly desiredVersion?: string
  /** True while the live agent is draining for a rollout. */
  readonly draining?: boolean
}

/** Result of issuing a token; the plaintext is returned exactly once. */
export interface AgentTokenIssuance {
  readonly cluster: AgentClusterView
  readonly token: string
}

/** Gateway-side failure with the same codes the provider layer already handles. */
export class AgentQueryError extends Error {
  readonly code: AgentQueryErrorCode
  constructor(code: AgentQueryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AgentQueryError'
    this.code = code
  }
}

/** Whether a string has the shape of a server-issued agent token. */
export function isAgentToken(value: string): boolean {
  return value.startsWith(AGENT_TOKEN_PREFIX) && AGENT_TOKEN_BODY_RE.test(value.slice(AGENT_TOKEN_PREFIX.length))
}

/** Map the agent's wire code onto the shared query taxonomy. */
export function queryCodeOf(code: string): AgentQueryErrorCode {
  switch (code) {
    case 'invalid_request':
    case 'unsupported_resource':
    case 'not_found':
    case 'forbidden':
    case 'authentication_failed':
    case 'timeout':
    case 'response_too_large':
    case 'invalid_response':
    case 'unreachable':
      return code
    // `busy` and every unknown code mean the cluster could not answer now.
    default:
      return 'unreachable'
  }
}
