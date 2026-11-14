import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WebSocket } from 'ws'
import { AGENT_WS_PATH, AgentRegistryError, AiopsAgents, isAgentToken, type AgentCapabilities } from '../src/index.ts'

const CAPABILITIES: AgentCapabilities = {
  resources: ['pods'],
  events: true,
  logs: true,
  maxResponseBytes: 2_000_000,
  maxTailLines: 2_000,
}
const hello = { type: 'hello', protocol: 1, name: 'local', version: '1.2.3', capabilities: CAPABILITIES }

/** Minimal webServer stand-in that exposes the upgrade table to the test. */
class FakeWebServer extends Service {
  readonly upgrades: WebUpgradeRoute[] = []
  constructor(ctx: Context) { super(ctx, 'webServer') }
  registerUpgrade(route: WebUpgradeRoute): () => void {
    this.upgrades.push(route)
    return () => { this.upgrades.splice(this.upgrades.indexOf(route), 1) }
  }
}

let root: string | undefined
let context: Context | undefined
let server: Server | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.terminate()
  }
  if (server !== undefined) {
    await new Promise<void>(resolve => { server?.close(() => resolve()) })
    server = undefined
  }
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function openRegistry(storageRoot: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(JsonBackend, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(FakeWebServer)
  await ctx.plugin(AiopsAgents, { requestTimeoutMs: 1_000, pingIntervalMs: 30_000, idleTimeoutMs: 60_000 })
  return ctx
}

async function fresh(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'aiops-agents-'))
  context = await openRegistry(root)
  return context
}

describe('agent registry', () => {
  it('issues a one-time token and keeps only its digest', async () => {
    const ctx = await fresh()
    const issued = await ctx.aiopsAgents.createCluster('local')
    expect(isAgentToken(issued.token)).toBe(true)
    expect(issued.token.startsWith('dsha_')).toBe(true)
    expect(issued.cluster).toMatchObject({ name: 'local', status: 'pending' })
    expect(issued).toEqual(expect.not.objectContaining({ tokenHash: expect.anything() }))
    expect(ctx.aiopsAgents.listClusters().map(row => row.name)).toEqual(['local'])
    expect(ctx.aiopsAgents.configured()).toBe(true)
  })

  it('rejects invalid names, duplicates, and unknown names', async () => {
    const ctx = await fresh()
    await expect(ctx.aiopsAgents.createCluster('Local')).rejects.toMatchObject({ code: 'invalid_name' })
    await expect(ctx.aiopsAgents.createCluster('')).rejects.toMatchObject({ code: 'invalid_name' })
    await ctx.aiopsAgents.createCluster('local')
    await expect(ctx.aiopsAgents.createCluster('local')).rejects.toMatchObject({ code: 'cluster_exists' })
    await expect(ctx.aiopsAgents.revokeCluster('absent')).rejects.toBeInstanceOf(AgentRegistryError)
    await expect(ctx.aiopsAgents.reissueToken('absent')).rejects.toMatchObject({ code: 'cluster_not_found' })
    expect(ctx.aiopsAgents.cluster('absent')).toBeUndefined()
  })

  it('reissues a pending token', async () => {
    const ctx = await fresh()
    const first = await ctx.aiopsAgents.createCluster('local')
    const second = await ctx.aiopsAgents.reissueToken('local')
    expect(second.token).not.toBe(first.token)
    expect(second.cluster).toMatchObject({ name: 'local', status: 'pending' })
  })

  it('persists rows across a restart as offline', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiops-agents-'))
    const first = await openRegistry(root)
    await first.aiopsAgents.createCluster('local')
    await first.fiber.dispose()

    const second = await openRegistry(root)
    context = second
    const cluster = second.aiopsAgents.cluster('local')
    expect(cluster).toMatchObject({ name: 'local', status: 'pending' })
  })

  it('revokes a cluster and allows the name to be issued again', async () => {
    const ctx = await fresh()
    const first = await ctx.aiopsAgents.createCluster('local')
    const revoked = await ctx.aiopsAgents.revokeCluster('local')
    expect(revoked.status).toBe('revoked')
    expect(revoked.revokedAt).toBeTypeOf('number')
    expect(ctx.aiopsAgents.configured()).toBe(false)

    const second = await ctx.aiopsAgents.createCluster('local')
    expect(second.token).not.toBe(first.token)
    expect(second.cluster).toMatchObject({ name: 'local', status: 'pending' })
    expect(second.cluster.revokedAt).toBeUndefined()
  })

  it('reports reads as unreachable while no agent is connected', async () => {
    const ctx = await fresh()
    await ctx.aiopsAgents.createCluster('local')
    await expect(ctx.aiopsAgents.read('local', { op: 'list', resource: 'pods' })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(ctx.aiopsAgents.probe('local')).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('accepts the issued token on the registered upgrade route and tracks the handshake', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiops-agents-'))
    const ctx = await openRegistry(root)
    context = ctx
    const { token } = await ctx.aiopsAgents.createCluster('local')
    const route = (ctx.webServer as unknown as FakeWebServer).upgrades.find(value => value.path === AGENT_WS_PATH)
    expect(route).toBeDefined()

    server = createServer()
    server.on('upgrade', (req, socket, head) => { void route?.handler(req, socket, head) })
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as AddressInfo
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    sockets.push(socket)
    await once(socket, 'open')
    const inbox: Record<string, unknown>[] = []
    socket.on('message', (raw: Buffer) => inbox.push(JSON.parse(raw.toString()) as Record<string, unknown>))
    socket.send(JSON.stringify(hello))
    await vi.waitFor(() => { expect(inbox[0]).toMatchObject({ type: 'welcome', clientId: 'local', protocol: 1 }) })

    const probing = ctx.aiopsAgents.probe('local')
    await vi.waitFor(() => { expect(inbox[1]).toMatchObject({ type: 'probe' }) })
    socket.send(JSON.stringify({
      type: 'result',
      id: inbox[1]?.id,
      ok: true,
      data: { name: 'local', version: '1.2.3', protocol: 1, capabilities: CAPABILITIES },
    }))
    await expect(probing).resolves.toMatchObject({ version: '1.2.3' })

    await vi.waitFor(() => {
      expect(ctx.aiopsAgents.cluster('local')).toMatchObject({
        status: 'connected',
        agentVersion: '1.2.3',
        protocol: 1,
        capabilities: CAPABILITIES,
      })
    })
    expect(ctx.aiopsAgents.cluster('local')?.lastSeenAt).toBeTypeOf('number')
    expect(ctx.aiopsAgents.isConnected('local')).toBe(true)
    // Once an agent has completed a handshake the token is fixed: an operator
    // revokes and issues a new cluster instead of rotating in place.
    await expect(ctx.aiopsAgents.reissueToken('local')).rejects.toMatchObject({ code: 'token_not_reissuable' })
  })

  it('prepares a rollout: persists the target version and drains the live agent', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiops-agents-'))
    const ctx = await openRegistry(root)
    context = ctx
    const { token } = await ctx.aiopsAgents.createCluster('local')
    const route = (ctx.webServer as unknown as FakeWebServer).upgrades.find(value => value.path === AGENT_WS_PATH)
    server = createServer()
    server.on('upgrade', (req, socket, head) => { void route?.handler(req, socket, head) })
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as AddressInfo
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    sockets.push(socket)
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>))
    socket.send(JSON.stringify(hello))
    await vi.waitFor(() => { expect(ctx.aiopsAgents.isConnected('local')).toBe(true) })

    await expect(ctx.aiopsAgents.upgradeCluster('local', 'bad version')).rejects.toMatchObject({ code: 'invalid_version' })
    const upgraded = await ctx.aiopsAgents.upgradeCluster('local', '2.0.0')
    expect(upgraded).toMatchObject({ status: 'connected', agentVersion: '1.2.3', desiredVersion: '2.0.0', draining: true })
    expect(ctx.aiopsAgents.isDraining('local')).toBe(true)
    await vi.waitFor(() => { expect(frames).toContainEqual(expect.objectContaining({ type: 'drain' })) })
    await expect(ctx.aiopsAgents.read('local', { op: 'list', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'unreachable' })

    const resumed = await ctx.aiopsAgents.resumeCluster('local')
    expect(resumed.draining).toBeUndefined()
    expect(resumed.desiredVersion).toBe('2.0.0')
    await vi.waitFor(() => { expect(frames).toContainEqual(expect.objectContaining({ type: 'resume' })) })
    expect(ctx.aiopsAgents.isDraining('local')).toBe(false)
  })

  it('refuses a revoked token on the socket and drops the live connection', async () => {
    root = await mkdtemp(join(tmpdir(), 'aiops-agents-'))
    const ctx = await openRegistry(root)
    context = ctx
    const { token } = await ctx.aiopsAgents.createCluster('local')
    const route = (ctx.webServer as unknown as FakeWebServer).upgrades.find(value => value.path === AGENT_WS_PATH)
    server = createServer()
    server.on('upgrade', (req, socket, head) => { void route?.handler(req, socket, head) })
    await new Promise<void>(resolve => { server?.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as AddressInfo
    const url = `ws://127.0.0.1:${address.port}${AGENT_WS_PATH}`

    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    sockets.push(socket)
    await once(socket, 'open')
    socket.send(JSON.stringify(hello))
    await vi.waitFor(() => { expect(ctx.aiopsAgents.isConnected('local')).toBe(true) })

    const closed = once(socket, 'close')
    await ctx.aiopsAgents.revokeCluster('local')
    const [code] = await closed as [number]
    expect(code).toBe(4001)
    expect(ctx.aiopsAgents.cluster('local')?.status).toBe('revoked')

    const rejected = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    sockets.push(rejected)
    const [, response] = await once(rejected, 'unexpected-response') as [unknown, { statusCode: number }]
    expect(response.statusCode).toBe(401)
  })
})
