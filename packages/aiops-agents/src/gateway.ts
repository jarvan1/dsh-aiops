/**
 * The server half of protocol v1: one upgraded WebSocket per cluster agent,
 * closed message dispatch, and request/result correlation.
 *
 * The gateway owns no durable state. It asks the registry to authenticate a
 * bearer token, reports lifecycle transitions back, and exposes typed reads
 * that the provider layer consumes. A connection is only ever routed to after
 * its `hello` has been validated; `hello` cannot rename the cluster, because
 * the token binds the name.
 *
 * @module @deepseek-ai/dsh-aiops-agents/src/gateway
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { RawData } from 'ws'
import { WebSocket, WebSocketServer } from 'ws'
import {
  AGENT_PROTOCOL_VERSION,
  AgentQueryError,
  queryCodeOf,
  type AgentCapabilities,
  type AgentProbeResult,
  type AgentReadRequest,
  type AgentReadResult,
  type AgentServerMessage,
  type AgentWireRead,
} from './types.ts'
import { bearerToken } from './tokens.ts'

/** Close codes this server uses. The agent treats every close as a reconnect. */
export const CLOSE_REVOKED = 4001
export const CLOSE_PROTOCOL_MISMATCH = 4002
export const CLOSE_NAME_MISMATCH = 4003
export const CLOSE_HANDSHAKE_TIMEOUT = 4004
export const CLOSE_PROTOCOL_VIOLATION = 4005
export const CLOSE_REPLACED = 4006
export const CLOSE_SHUTTING_DOWN = 4007

/** Inbound frames are bounded: the agent caps a Kubernetes response at 2 MB. */
const MAX_INBOUND_BYTES = 4 << 20
/** Derived names an agent advertises; anything else is a protocol violation. */
const MAX_RESOURCE_NAMES = 64
const MAX_CLUSTER_NAME_CHARS = 63

/** Who the presented token belongs to, as the registry sees it. */
export interface AgentIdentity {
  readonly name: string
  readonly desiredVersion?: string
}

/** Durable lifecycle callbacks; the registry writes the cluster row. */
export interface AgentLifecycle {
  /** An authenticated agent completed `hello` and may now receive reads. */
  onConnected(identity: AgentIdentity, hello: AgentHelloFacts): void
  /** A heartbeat arrived; `inflight` is the agent's own load report. */
  onHeartbeat(name: string, heartbeat: { version: string; inflight: number }): void
  /** The connection ended for any reason; a later reconnect is normal. */
  onDisconnected(name: string): void
  /** A connection was refused or dropped for an operator-visible reason. */
  onFailure?(name: string, reason: string): void
}

/** The validated `hello` facts a cluster row keeps. */
export interface AgentHelloFacts {
  readonly version: string
  readonly capabilities: AgentCapabilities
}

export interface GatewayOptions extends AgentLifecycle {
  /**
   * Resolve a presented token to its cluster. Returning undefined refuses the
   * upgrade with HTTP 401; revoked tokens are refused here too.
   */
  authenticate(token: string): AgentIdentity | undefined
  readonly logger?: Logger
  readonly requestTimeoutMs?: number
  readonly handshakeTimeoutMs?: number
  readonly pingIntervalMs?: number
  readonly idleTimeoutMs?: number
  readonly maxPendingRequests?: number
}

/** Minimal logger contract, so tests can pass a spy and the host a real logger. */
export interface Logger {
  warn(message: unknown): void
  info?(message: unknown): void
}

interface Pending {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: NodeJS.Timeout
  readonly cleanup: () => void
}

interface LiveAgent {
  readonly name: string
  readonly ws: WebSocket
  readonly version: string
  readonly capabilities: AgentCapabilities
  readonly connectedAt: number
  readonly pending: Map<string, Pending>
  inflight: number
  lastHeartbeatAt: number
  lastMessageAt: number
  alive: boolean
  /** New reads are refused while the operator prepares a rollout. */
  draining: boolean
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  handshakeTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  idleTimeoutMs: 90_000,
  maxPendingRequests: 32,
} as const

/** One cluster-name shape, shared with the agent's `--name` validation. */
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

export function isValidClusterName(value: string): boolean {
  return value.length <= MAX_CLUSTER_NAME_CHARS && NAME_RE.test(value)
}

/** Open WebSocket per authenticated cluster, plus the read correlation table. */
export class AgentGateway {
  private readonly wss: WebSocketServer
  private readonly live = new Map<string, LiveAgent>()
  private readonly options: Required<Pick<GatewayOptions,
    'requestTimeoutMs' | 'handshakeTimeoutMs' | 'pingIntervalMs' | 'idleTimeoutMs' | 'maxPendingRequests'>> & GatewayOptions
  private livenessTimer: NodeJS.Timeout | undefined

  constructor(options: GatewayOptions) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULTS.pingIntervalMs,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxPendingRequests: options.maxPendingRequests ?? DEFAULTS.maxPendingRequests,
      ...options,
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES })
    this.livenessTimer = setInterval(() => this.sweep(), this.options.pingIntervalMs)
    this.livenessTimer.unref()
  }

  /** Names with a validated, live connection. */
  connectedNames(): string[] {
    return [...this.live.keys()]
  }

  isConnected(name: string): boolean {
    return this.live.has(name)
  }

  /**
   * Own one `upgrade` event: authenticate, negotiate, then hand the socket to
   * the protocol loop. Refusals are written as plain HTTP because the upgrade
   * has not happened yet.
   */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = bearerToken(req.headers.authorization)
    if (token === undefined) {
      refuse(socket, 401, 'Unauthorized')
      return
    }
    const identity = this.options.authenticate(token)
    if (identity === undefined) {
      refuse(socket, 401, 'Unauthorized')
      return
    }
    try {
      this.wss.handleUpgrade(req, socket, head, ws => this.handshake(ws, identity))
    } catch (error: unknown) {
      this.options.logger?.warn(`agent upgrade failed: ${errorText(error)}`)
      socket.destroy()
    }
  }

  /**
   * Send one bounded read and await its result. Rejects with AgentQueryError:
   * `unreachable` when no agent is connected, `timeout` when the agent or the
   * caller gives up, and the agent's own code for an answered failure.
   */
  async read(name: string, request: AgentReadRequest, signal?: AbortSignal): Promise<AgentReadResult> {
    const result = await this.request(name, { ...request, type: 'read', id: randomUUID() }, signal)
    if (typeof result.data === 'string') return { data: result.data, truncated: result.truncated === true }
    if (typeof result.data !== 'object' || result.data === null) {
      throw new AgentQueryError('invalid_response', 'agent returned a read result without an object or text payload.')
    }
    return { data: result.data, truncated: result.truncated === true }
  }

  /** Ask one connected agent to describe itself. */
  async probe(name: string, signal?: AbortSignal): Promise<AgentProbeResult> {
    const result = await this.request(name, { type: 'probe', id: randomUUID() }, signal)
    const data = result.data
    if (typeof data !== 'object' || data === null) {
      throw new AgentQueryError('invalid_response', 'agent returned an empty probe result.')
    }
    const value = data as Record<string, unknown>
    if (value.protocol !== AGENT_PROTOCOL_VERSION || typeof value.version !== 'string' || typeof value.name !== 'string') {
      throw new AgentQueryError('invalid_response', 'agent returned a malformed probe result.')
    }
    if (value.name !== name) {
      throw new AgentQueryError('invalid_response', 'agent described a different cluster than the one it authenticated as.')
    }
    const capabilities = decodeCapabilities(value.capabilities)
    if (capabilities === undefined) {
      throw new AgentQueryError('invalid_response', 'agent returned malformed capabilities.')
    }
    return { name: value.name, version: value.version, protocol: value.protocol, capabilities }
  }

  /** Whether the live agent is draining for a rollout. */
  isDraining(name: string): boolean {
    return this.live.get(name)?.draining === true
  }

  /**
   * Ask one connected agent to drain: in-flight reads finish, new reads are
   * refused locally and by the agent, and the rollout can replace the pod
   * without failing a diagnosis. Returns false when no agent is connected.
   */
  drain(name: string): boolean {
    const agent = this.live.get(name)
    if (agent === undefined) return false
    if (!this.write(agent, { type: 'drain' })) return false
    agent.draining = true
    return true
  }

  /** Allow reads again, for example when a rollout is cancelled. */
  resume(name: string): boolean {
    const agent = this.live.get(name)
    if (agent === undefined) return false
    if (!this.write(agent, { type: 'resume' })) return false
    agent.draining = false
    return true
  }

  /**
   * Drop one connection immediately. A revoked cluster must not keep answering
   * reads even for the seconds a graceful close would take.
   */
  disconnect(name: string, reason = 'the cluster token was revoked'): void {
    const agent = this.live.get(name)
    if (agent === undefined) return
    this.live.delete(name)
    this.failPending(agent, new AgentQueryError('unreachable', reason))
    this.closeWith(agent.ws, CLOSE_REVOKED, reason)
  }

  /** Close every connection; the caller is shutting down. */
  close(): void {
    if (this.livenessTimer !== undefined) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = undefined
    }
    for (const agent of [...this.live.values()]) {
      agent.ws.close(CLOSE_SHUTTING_DOWN, 'server shutting down')
      agent.ws.terminate()
    }
    this.live.clear()
  }

  private handshake(ws: WebSocket, identity: AgentIdentity): void {
    const timer = setTimeout(() => {
      ws.close(CLOSE_HANDSHAKE_TIMEOUT, 'hello was not received in time')
    }, this.options.handshakeTimeoutMs)
    timer.unref()
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer)
      if (isBinary) {
        ws.close(CLOSE_PROTOCOL_VIOLATION, 'binary frames are not part of protocol v1')
        return
      }
      const hello = decodeHello(data)
      if (hello === undefined) {
        ws.close(CLOSE_PROTOCOL_VIOLATION, 'malformed hello')
        this.options.onFailure?.(identity.name, 'sent a malformed hello')
        return
      }
      if (hello.protocol !== AGENT_PROTOCOL_VERSION) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'incompatible_protocol',
          message: `server speaks protocol ${AGENT_PROTOCOL_VERSION}`,
        }))
        ws.close(CLOSE_PROTOCOL_MISMATCH, 'protocol major version mismatch')
        this.options.onFailure?.(identity.name, `reported protocol ${hello.protocol}`)
        return
      }
      if (hello.name !== identity.name) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'invalid_request',
          message: `token belongs to cluster ${identity.name}`,
        }))
        ws.close(CLOSE_NAME_MISMATCH, 'hello name does not match the token')
        this.options.onFailure?.(identity.name, `announced name ${hello.name}`)
        return
      }
      this.attach(ws, identity, hello)
    })
    ws.once('error', (error: Error) => {
      clearTimeout(timer)
      this.options.logger?.warn(`agent handshake failed: ${error.message}`)
    })
  }

  private attach(ws: WebSocket, identity: AgentIdentity, hello: AgentHelloFacts & { name: string }): void {
    const previous = this.live.get(identity.name)
    if (previous !== undefined) {
      // One cluster has one live connection: the newest handshake wins, and the
      // older socket is retired so no two agents answer for the same name.
      this.live.delete(identity.name)
      this.failPending(previous, new AgentQueryError('unreachable', 'the agent reconnected while the read was in flight.'))
      this.closeWith(previous.ws, CLOSE_REPLACED, 'replaced by a newer connection')
    }
    const now = Date.now()
    const agent: LiveAgent = {
      name: identity.name,
      ws,
      version: hello.version,
      capabilities: hello.capabilities,
      connectedAt: now,
      pending: new Map(),
      inflight: 0,
      lastHeartbeatAt: now,
      lastMessageAt: now,
      alive: true,
      draining: false,
    }
    this.live.set(identity.name, agent)
    this.write(agent, {
      type: 'welcome',
      protocol: AGENT_PROTOCOL_VERSION,
      clientId: agent.name,
      ...(identity.desiredVersion === undefined ? {} : { desiredVersion: identity.desiredVersion }),
    })
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(CLOSE_PROTOCOL_VIOLATION, 'binary frames are not part of protocol v1')
        return
      }
      this.onMessage(agent, data)
    })
    ws.on('pong', () => { agent.alive = true })
    ws.on('error', (error: Error) => {
      this.options.logger?.warn(`agent ${agent.name} socket error: ${error.message}`)
    })
    ws.on('close', (code: number) => {
      if (this.live.get(agent.name) === agent) this.live.delete(agent.name)
      this.failPending(agent, new AgentQueryError('unreachable', `the agent connection closed (code ${code}).`))
      this.options.onDisconnected(agent.name)
    })
    this.options.onConnected(identity, { version: hello.version, capabilities: hello.capabilities })
  }

  private onMessage(agent: LiveAgent, data: RawData): void {
    agent.lastMessageAt = Date.now()
    // Any frame proves the peer is alive, so a lost pong never drops an agent
    // that is still heartbeating.
    agent.alive = true
    let value: unknown
    try {
      value = JSON.parse(data.toString())
    } catch {
      agent.ws.close(CLOSE_PROTOCOL_VIOLATION, 'frames must be JSON')
      return
    }
    const type = typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined
    if (type === 'heartbeat') {
      const inflight = Reflect.get(value as object, 'inflight')
      const version = Reflect.get(value as object, 'version')
      if (typeof inflight !== 'number' || !Number.isSafeInteger(inflight) || inflight < 0) return
      agent.inflight = inflight
      agent.lastHeartbeatAt = Date.now()
      this.options.onHeartbeat(agent.name, { version: typeof version === 'string' ? version : agent.version, inflight })
      return
    }
    if (type === 'result') {
      this.onResult(agent, value as Record<string, unknown>)
      return
    }
    agent.ws.close(CLOSE_PROTOCOL_VIOLATION, `unexpected message type ${String(type)}`)
  }

  private onResult(agent: LiveAgent, value: Record<string, unknown>): void {
    const id = value.id
    if (typeof id !== 'string') return
    const pending = agent.pending.get(id)
    if (pending === undefined) return
    agent.pending.delete(id)
    clearTimeout(pending.timer)
    pending.cleanup()
    pending.resolve(value)
  }

  private request(
    name: string,
    message: AgentWireRead | { type: 'probe'; id: string },
    signal?: AbortSignal,
  ): Promise<{ data?: unknown; truncated?: boolean }> {
    const agent = this.live.get(name)
    if (agent === undefined) {
      return Promise.reject(new AgentQueryError('unreachable', `cluster agent ${name} is not connected.`))
    }
    if (agent.draining) {
      return Promise.reject(new AgentQueryError('unreachable', `cluster agent ${name} is draining for an upgrade and is not accepting reads.`))
    }
    if (agent.pending.size >= this.options.maxPendingRequests) {
      return Promise.reject(new AgentQueryError('unreachable', `cluster agent ${name} already has ${agent.pending.size} reads in flight.`))
    }
    if (signal?.aborted === true) {
      return Promise.reject(new AgentQueryError('timeout', 'the read was cancelled before it reached the agent.'))
    }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const pending = agent.pending.get(message.id)
        if (pending === undefined) return
        agent.pending.delete(message.id)
        clearTimeout(pending.timer)
        pending.cleanup()
        reject(new AgentQueryError('timeout', 'the read was cancelled before the agent answered.'))
      }
      const timer = setTimeout(() => {
        agent.pending.delete(message.id)
        signal?.removeEventListener('abort', abort)
        reject(new AgentQueryError('timeout', `cluster agent ${name} did not answer within ${this.options.requestTimeoutMs} ms.`))
      }, this.options.requestTimeoutMs)
      timer.unref()
      agent.pending.set(message.id, {
        resolve: result => {
          const answer = result as { ok?: unknown; data?: unknown; truncated?: unknown; code?: unknown; message?: unknown }
          if (answer.ok === true) {
            resolve({
              ...(answer.data === undefined ? {} : { data: answer.data }),
              ...(answer.truncated === true ? { truncated: true } : {}),
            })
            return
          }
          const code = typeof answer.code === 'string' ? answer.code : 'unreachable'
          const detail = typeof answer.message === 'string' && answer.message !== '' ? answer.message : `the agent reported ${code}.`
          reject(new AgentQueryError(queryCodeOf(code), detail))
        },
        reject,
        timer,
        cleanup: () => { signal?.removeEventListener('abort', abort) },
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (!this.write(agent, message)) {
        agent.pending.delete(message.id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(new AgentQueryError('unreachable', `writing to cluster agent ${name} failed.`))
      }
    })
  }

  private write(agent: LiveAgent, message: AgentServerMessage): boolean {
    if (agent.ws.readyState !== WebSocket.OPEN) return false
    try {
      agent.ws.send(JSON.stringify(message))
      return true
    } catch (error: unknown) {
      this.options.logger?.warn(`writing to agent ${agent.name} failed: ${errorText(error)}`)
      return false
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const agent of [...this.live.values()]) {
      if (!agent.alive || now - agent.lastMessageAt > this.options.idleTimeoutMs) {
        this.options.logger?.warn(`agent ${agent.name} stopped answering; dropping the connection`)
        agent.ws.terminate()
        continue
      }
      agent.alive = false
      try {
        agent.ws.ping()
      } catch {
        agent.ws.terminate()
      }
    }
  }

  /**
   * Ask the peer to close, then force the socket after a grace period. The
   * client must still receive the code: revoking and replacing both rely on it.
   */
  private closeWith(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
    const timer = setTimeout(() => ws.terminate(), 1_000)
    timer.unref()
    ws.once('close', () => clearTimeout(timer))
  }

  private failPending(agent: LiveAgent, error: AgentQueryError): void {
    for (const [id, pending] of agent.pending) {
      agent.pending.delete(id)
      clearTimeout(pending.timer)
      pending.cleanup()
      pending.reject(error)
    }
  }
}

function decodeHello(data: RawData): (AgentHelloFacts & { name: string; protocol: number }) | undefined {
  let value: unknown
  try {
    value = JSON.parse(data.toString())
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  if (Reflect.get(value, 'type') !== 'hello') return undefined
  const protocol = Reflect.get(value, 'protocol')
  const name = Reflect.get(value, 'name')
  const version = Reflect.get(value, 'version')
  const capabilities = decodeCapabilities(Reflect.get(value, 'capabilities'))
  if (typeof protocol !== 'number' || !Number.isSafeInteger(protocol)) return undefined
  if (typeof name !== 'string' || !isValidClusterName(name)) return undefined
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return undefined
  if (capabilities === undefined) return undefined
  return { protocol, name, version, capabilities }
}

function decodeCapabilities(value: unknown): AgentCapabilities | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const resources = Reflect.get(value, 'resources')
  const events = Reflect.get(value, 'events')
  const logs = Reflect.get(value, 'logs')
  const maxResponseBytes = Reflect.get(value, 'maxResponseBytes')
  const maxTailLines = Reflect.get(value, 'maxTailLines')
  if (!Array.isArray(resources) || resources.length > MAX_RESOURCE_NAMES) return undefined
  if (!resources.every(item => typeof item === 'string' && item.length > 0 && item.length <= 64)) return undefined
  if (typeof events !== 'boolean' || typeof logs !== 'boolean') return undefined
  if (typeof maxResponseBytes !== 'number' || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) return undefined
  if (typeof maxTailLines !== 'number' || !Number.isSafeInteger(maxTailLines) || maxTailLines <= 0) return undefined
  return { resources: resources as string[], events, logs, maxResponseBytes, maxTailLines }
}

/** Answer a pre-upgrade refusal without handing the socket to `ws`. */
function refuse(socket: Duplex, status: number, reason: string): void {
  // The socket is outside any HTTP server error handling once it reaches an
  // `upgrade` listener, so an unhandled reset here would take the process down.
  socket.on('error', () => {})
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
