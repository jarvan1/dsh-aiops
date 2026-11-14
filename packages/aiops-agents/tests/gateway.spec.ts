import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import {
  AgentGateway,
  AgentQueryError,
  AGENT_WS_PATH,
  type AgentCapabilities,
  type GatewayOptions,
} from '../src/index.ts'

const TOKEN = 'dsha_0123456789012345678901234567890123456789012'
const CAPABILITIES: AgentCapabilities = {
  resources: ['pods', 'events'],
  events: true,
  logs: true,
  maxResponseBytes: 2_000_000,
  maxTailLines: 2_000,
}
const hello = { type: 'hello', protocol: 1, name: 'local', version: '1.2.3', capabilities: CAPABILITIES }

let server: Server | undefined
let gateway: AgentGateway | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.terminate()
  }
  gateway?.close()
  gateway = undefined
  if (server !== undefined) {
    await new Promise<void>(resolve => { server?.close(() => resolve()) })
    server = undefined
  }
})

interface Harness {
  readonly gateway: AgentGateway
  readonly url: string
  readonly events: string[]
}

async function harness(overrides: Partial<GatewayOptions> = {}): Promise<Harness> {
  const events: string[] = []
  gateway = new AgentGateway({
    authenticate: token => (token === TOKEN ? { name: 'local' } : undefined),
    onConnected: (_identity, facts) => { events.push(`connected:${facts.version}`) },
    onHeartbeat: () => { events.push('heartbeat') },
    onDisconnected: name => { events.push(`disconnected:${name}`) },
    requestTimeoutMs: 2_000,
    handshakeTimeoutMs: 1_000,
    pingIntervalMs: 30_000,
    idleTimeoutMs: 60_000,
    ...overrides,
  })
  server = createServer()
  server.on('upgrade', (req, socket, head) => { gateway?.accept(req, socket, head) })
  await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { gateway, url: `ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`, events }
}

/** Minimal agent side of the protocol: send JSON, await the next JSON frame. */
function connect(url: string, token = TOKEN): WebSocket {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  sockets.push(socket)
  return socket
}

function messages(socket: WebSocket): { next: (timeoutMs?: number) => Promise<Record<string, unknown>> } {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<(value: Record<string, unknown>) => void> = []
  socket.on('message', (raw: Buffer) => {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter === undefined) queue.push(value)
    else waiter(value)
  })
  return {
    next(timeoutMs = 2_000) {
      const buffered = queue.shift()
      if (buffered !== undefined) return Promise.resolve(buffered)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no frame arrived')), timeoutMs)
        waiters.push(value => { clearTimeout(timer); resolve(value) })
      })
    },
  }
}

async function open(url: string, token = TOKEN): Promise<{ socket: WebSocket; inbox: ReturnType<typeof messages> }> {
  const socket = connect(url, token)
  await once(socket, 'open')
  const inbox = messages(socket)
  socket.send(JSON.stringify(hello))
  const welcome = await inbox.next()
  expect(welcome).toMatchObject({ type: 'welcome', protocol: 1, clientId: 'local' })
  return { socket, inbox }
}

describe('agent gateway', () => {
  it('refuses an unknown token before upgrading the socket', async () => {
    const { url } = await harness()
    const socket = connect(url, 'dsha_fffffffffffffffffffffffffffffffffffffffffff')
    const [request, response] = await once(socket, 'unexpected-response') as [unknown, { statusCode: number }]
    expect(request).toBeDefined()
    expect(response.statusCode).toBe(401)
  })

  it('refuses a malformed authorization header', async () => {
    const { url } = await harness()
    const socket = connect(url, 'not-a-token')
    const [, response] = await once(socket, 'unexpected-response') as [unknown, { statusCode: number }]
    expect(response.statusCode).toBe(401)
  })

  it('welcomes a validated hello and answers probe and read', async () => {
    const { gateway: live, url, events } = await harness()
    const { socket, inbox } = await open(url)
    expect(events).toContain('connected:1.2.3')

    const probing = live.probe('local')
    const probe = await inbox.next()
    expect(probe).toMatchObject({ type: 'probe' })
    socket.send(JSON.stringify({
      type: 'result',
      id: probe.id,
      ok: true,
      data: { name: 'local', version: '1.2.3', protocol: 1, capabilities: CAPABILITIES },
    }))
    await expect(probing).resolves.toMatchObject({ name: 'local', version: '1.2.3', protocol: 1 })

    const reading = live.read('local', { op: 'get', resource: 'pods', name: 'api-0', namespace: 'prod' })
    const read = await inbox.next()
    expect(read).toMatchObject({ type: 'read', op: 'get', resource: 'pods', name: 'api-0', namespace: 'prod' })
    expect(String(read.id)).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
    socket.send(JSON.stringify({ type: 'result', id: read.id, ok: true, data: { kind: 'Pod' }, truncated: true }))
    await expect(reading).resolves.toEqual({ data: { kind: 'Pod' }, truncated: true })
  })

  it('records heartbeats and rejects unexpected message types', async () => {
    const { url, events } = await harness()
    const { socket } = await open(url)
    socket.send(JSON.stringify({ type: 'heartbeat', version: '1.2.3', inflight: 2 }))
    await vi.waitFor(() => { expect(events).toContain('heartbeat') })
    socket.send(JSON.stringify({ type: 'read', id: 'ignored' }))
    const [code] = await once(socket, 'close') as [number]
    expect(code).toBe(4005)
  })

  it('closes a hello that announces a different cluster name', async () => {
    const { url, gateway: live } = await harness()
    const socket = connect(url)
    await once(socket, 'open')
    const inbox = messages(socket)
    socket.send(JSON.stringify({ ...hello, name: 'other' }))
    await expect(inbox.next()).resolves.toMatchObject({ type: 'error', code: 'invalid_request' })
    const [code] = await once(socket, 'close') as [number]
    expect(code).toBe(4003)
    expect(live.isConnected('local')).toBe(false)
  })

  it('closes a hello with an incompatible protocol major version', async () => {
    const { url } = await harness()
    const socket = connect(url)
    await once(socket, 'open')
    const inbox = messages(socket)
    socket.send(JSON.stringify({ ...hello, protocol: 2 }))
    await expect(inbox.next()).resolves.toMatchObject({ type: 'error', code: 'incompatible_protocol' })
    const [code] = await once(socket, 'close') as [number]
    expect(code).toBe(4002)
  })

  it('closes a malformed hello without registering a connection', async () => {
    const { url, gateway: live } = await harness()
    const socket = connect(url)
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, name: 'local' }))
    const [code] = await once(socket, 'close') as [number]
    expect(code).toBe(4005)
    expect(live.isConnected('local')).toBe(false)
  })

  it('maps agent failures onto query codes and busy onto unreachable', async () => {
    const { gateway: live, url } = await harness()
    const { socket, inbox } = await open(url)

    const forbidden = live.read('local', { op: 'get', resource: 'pods', name: 'api-0' })
    const first = await inbox.next()
    socket.send(JSON.stringify({ type: 'result', id: first.id, ok: false, code: 'forbidden', message: 'pods is forbidden' }))
    await expect(forbidden).rejects.toBeInstanceOf(AgentQueryError)
    await expect(forbidden).rejects.toMatchObject({ code: 'forbidden', message: 'pods is forbidden' })

    const busy = live.read('local', { op: 'list', resource: 'pods' })
    const second = await inbox.next()
    socket.send(JSON.stringify({ type: 'result', id: second.id, ok: false, code: 'busy', message: 'saturated' }))
    await expect(busy).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('answers timeout when the agent never replies', async () => {
    const { gateway: live, url } = await harness({ requestTimeoutMs: 100 })
    await open(url)
    await expect(live.read('local', { op: 'list', resource: 'pods' })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects reads when no agent is connected', async () => {
    const { gateway: live } = await harness()
    await expect(live.read('local', { op: 'list', resource: 'pods' })).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('honours caller cancellation as timeout', async () => {
    const { gateway: live, url } = await harness()
    await open(url)
    const controller = new AbortController()
    const reading = live.read('local', { op: 'list', resource: 'pods' }, controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ code: 'timeout' })
  })

  it('drops a revoked connection and refuses its in-flight reads', async () => {
    const { gateway: live, url, events } = await harness()
    const { socket } = await open(url)
    const reading = live.read('local', { op: 'list', resource: 'pods' })
    live.disconnect('local')
    await expect(reading).rejects.toMatchObject({ code: 'unreachable' })
    const [code] = await once(socket, 'close') as [number]
    expect(code).toBe(4001)
    expect(live.isConnected('local')).toBe(false)
    await vi.waitFor(() => { expect(events).toContain('disconnected:local') })
  })

  it('lets a newer connection replace the older one for the same cluster', async () => {
    const { gateway: live, url } = await harness()
    const first = await open(url)
    const closed = once(first.socket, 'close')
    const second = await open(url)
    const [code] = await closed as [number]
    expect(code).toBe(4006)
    expect(live.isConnected('local')).toBe(true)

    const reading = live.read('local', { op: 'list', resource: 'pods' })
    const request = await second.inbox.next()
    second.socket.send(JSON.stringify({ type: 'result', id: request.id, ok: true, data: { items: [] } }))
    await expect(reading).resolves.toEqual({ data: { items: [] }, truncated: false })
  })

  it('drains a live agent, refuses reads, and resumes on request', async () => {
    const { gateway: live, url } = await harness()
    const { socket, inbox } = await open(url)
    expect(live.drain('local')).toBe(true)
    await expect(inbox.next()).resolves.toMatchObject({ type: 'drain' })
    expect(live.isDraining('local')).toBe(true)
    await expect(live.read('local', { op: 'list', resource: 'pods' })).rejects.toMatchObject({
      code: 'unreachable',
      message: expect.stringContaining('draining'),
    })

    expect(live.resume('local')).toBe(true)
    await expect(inbox.next()).resolves.toMatchObject({ type: 'resume' })
    expect(live.isDraining('local')).toBe(false)
    const reading = live.read('local', { op: 'list', resource: 'pods' })
    const request = await inbox.next()
    socket.send(JSON.stringify({ type: 'result', id: request.id, ok: true, data: { items: [] } }))
    await expect(reading).resolves.toEqual({ data: { items: [] }, truncated: false })
  })

  it('reports drain and resume as no-ops without a live agent', async () => {
    const { gateway: live } = await harness()
    expect(live.drain('local')).toBe(false)
    expect(live.resume('local')).toBe(false)
    expect(live.isDraining('local')).toBe(false)
  })

  it('does not carry a drain into a replacement connection', async () => {
    const { gateway: live, url } = await harness()
    const first = await open(url)
    live.drain('local')
    await first.inbox.next()
    expect(live.isDraining('local')).toBe(true)
    const closed = once(first.socket, 'close')
    await open(url)
    await closed
    expect(live.isDraining('local')).toBe(false)
  })

  it('rejects a probe that describes a different cluster than the token', async () => {
    const { gateway: live, url } = await harness()
    const { socket, inbox } = await open(url)
    const probing = live.probe('local')
    const request = await inbox.next()
    socket.send(JSON.stringify({
      type: 'result',
      id: request.id,
      ok: true,
      data: { name: 'other', version: '1.2.3', protocol: 1, capabilities: CAPABILITIES },
    }))
    await expect(probing).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects a read result whose payload is neither object nor text', async () => {
    const { gateway: live, url } = await harness()
    const { socket, inbox } = await open(url)
    const reading = live.read('local', { op: 'list', resource: 'pods' })
    const request = await inbox.next()
    socket.send(JSON.stringify({ type: 'result', id: request.id, ok: true, data: 42 }))
    await expect(reading).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
