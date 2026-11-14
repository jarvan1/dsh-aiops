import { Context } from '@deepseek-ai/cordis'
import { AgentQueryError, type AgentCapabilities, type AgentProbeResult, type AgentReadRequest, type AgentReadResult } from '@deepseek-ai/dsh-aiops-agents'
import { describe, expect, it, vi } from 'vitest'
import { AgentKubernetesRuntime, KubernetesQueryError } from '../src/index.ts'

const CAPABILITIES: AgentCapabilities = {
  resources: ['pods', 'events', 'deployments'],
  events: true,
  logs: true,
  maxResponseBytes: 2_000_000,
  maxTailLines: 2_000,
}

interface FakeAgents {
  readonly read: ReturnType<typeof vi.fn>
  readonly probe: ReturnType<typeof vi.fn>
  readonly calls: Array<{ cluster: string; request: AgentReadRequest }>
}

function fakeAgents(options: { data?: unknown; probe?: AgentProbeResult } = {}): FakeAgents {
  const calls: FakeAgents['calls'] = []
  const read = vi.fn(async (cluster: string, request: AgentReadRequest): Promise<AgentReadResult> => {
    calls.push({ cluster, request })
    return { data: options.data ?? { kind: 'Pod', metadata: { name: 'api-0' } }, truncated: false }
  })
  const probe = vi.fn(async (): Promise<AgentProbeResult> => options.probe ?? {
    name: 'prod', version: '1.2.3', protocol: 1, capabilities: CAPABILITIES,
  })
  return { read, probe, calls }
}

function runtime(agents: FakeAgents, config: ConstructorParameters<typeof AgentKubernetesRuntime>[1] = {}): AgentKubernetesRuntime {
  const ctx = new Context()
  ctx.provide('aiopsAgents', agents as never)
  return new AgentKubernetesRuntime(ctx, config)
}

describe('AgentKubernetesRuntime', () => {
  it('reads one object through the cluster named by the diagnosis', async () => {
    const agents = fakeAgents()
    const kubernetes = runtime(agents)
    await expect(kubernetes.get({
      cwd: '/workspace', cluster: 'prod-sh', resource: 'pods', name: 'api-0', namespace: 'payments',
    })).resolves.toEqual({ kind: 'Pod', metadata: { name: 'api-0' } })
    expect(agents.calls).toEqual([{
      cluster: 'prod-sh',
      request: { op: 'get', resource: 'pods', name: 'api-0', namespace: 'payments' },
    }])
  })

  it('falls back to the configured default cluster and refuses when neither exists', async () => {
    const agents = fakeAgents()
    await runtime(agents, { defaultCluster: 'staging' }).list({ cwd: '/workspace', resource: 'pods' })
    expect(agents.calls[0]?.cluster).toBe('staging')

    const unbound = runtime(fakeAgents())
    await expect(unbound.list({ cwd: '/workspace', resource: 'pods' })).rejects.toMatchObject({
      code: 'unreachable',
      message: expect.stringContaining('No cluster agent is bound to this diagnosis'),
    })
  })

  it('forwards selectors and namespaces for a list', async () => {
    const agents = fakeAgents()
    await runtime(agents, { defaultCluster: 'prod' }).list({
      cwd: '/workspace', resource: 'deployments', namespace: 'payments',
      labelSelector: 'app=checkout', fieldSelector: 'metadata.name=checkout',
    })
    expect(agents.calls[0]?.request).toEqual({
      op: 'list', resource: 'deployments', namespace: 'payments',
      labelSelector: 'app=checkout', fieldSelector: 'metadata.name=checkout',
    })
  })

  it('normalizes the Event window and rejects an inverted one before any agent call', async () => {
    const agents = fakeAgents({ data: { kind: 'EventList', items: [] } })
    const kubernetes = runtime(agents, { defaultCluster: 'prod' })
    await kubernetes.events({
      cwd: '/workspace', namespace: 'payments',
      sinceTime: '2026-09-06T01:00:00+08:00', untilTime: '2026-09-06T02:00:00+08:00',
    })
    expect(agents.calls[0]?.request).toEqual({
      op: 'events', namespace: 'payments',
      sinceTime: '2026-09-05T17:00:00.000Z', untilTime: '2026-09-05T18:00:00.000Z',
    })
    await expect(kubernetes.events({
      cwd: '/workspace', sinceTime: '2026-09-06T02:00:00Z', untilTime: '2026-09-06T01:00:00Z',
    })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(agents.calls).toHaveLength(1)
  })

  it('resolves a bounded log request and returns agent text', async () => {
    const agents = fakeAgents({ data: '2026-09-06T01:00:00Z restarted\n' })
    const kubernetes = runtime(agents, { defaultCluster: 'prod', defaultLogTailLines: 100, maxLogTailLines: 500 })
    const spec = kubernetes.resolveLogs({ cwd: '/workspace', pod: 'api-0', tailLines: 900, since: '15m' })
    expect(spec).toMatchObject({ pod: 'api-0', tailLines: 500, since: '15m', previous: false, timestamps: false })
    await expect(kubernetes.logs(spec)).resolves.toBe('2026-09-06T01:00:00Z restarted\n')
    expect(agents.calls[0]?.request).toEqual({
      op: 'logs', pod: 'api-0', previous: false, tailLines: 500, since: '15m', timestamps: false,
    })
  })

  it('rejects a log result that is not text', async () => {
    const agents = fakeAgents({ data: { kind: 'Pod' } })
    const kubernetes = runtime(agents, { defaultCluster: 'prod' })
    await expect(kubernetes.logs(kubernetes.resolveLogs({ cwd: '/workspace', pod: 'api-0' })))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('maps the agent taxonomy onto KubernetesQueryError with the same code', async () => {
    const agents = fakeAgents()
    agents.read.mockRejectedValueOnce(new AgentQueryError('forbidden', 'pods is forbidden'))
    const kubernetes = runtime(agents, { defaultCluster: 'prod' })
    const failure = kubernetes.get({ cwd: '/workspace', resource: 'pods', name: 'api-0' })
    await expect(failure).rejects.toBeInstanceOf(KubernetesQueryError)
    await expect(failure).rejects.toMatchObject({ code: 'forbidden', message: 'pods is forbidden' })
  })

  it('rejects an invalid cluster name before any agent call', async () => {
    const agents = fakeAgents()
    await expect(runtime(agents).list({ cwd: '/workspace', cluster: 'Prod_Cluster', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(agents.read).not.toHaveBeenCalled()
  })

  it('rejects a non-object read result', async () => {
    const agents = fakeAgents({ data: 'text' })
    await expect(runtime(agents, { defaultCluster: 'prod' }).get({ cwd: '/workspace', resource: 'pods', name: 'api-0' }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('tests connectivity by probing the agent and mapping its capabilities', async () => {
    const agents = fakeAgents()
    await expect(runtime(agents).testConnection({ cluster: 'prod-sh' })).resolves.toEqual({
      cluster: 'prod',
      agentVersion: '1.2.3',
      protocol: 1,
      capabilities: { pods: true, events: true, podLogs: true },
      resources: ['pods', 'events', 'deployments'],
    })
    expect(agents.probe).toHaveBeenCalledWith('prod-sh', undefined)
  })

  it('validates provider configuration', () => {
    expect(() => runtime(fakeAgents(), { defaultCluster: 'Prod' })).toThrow(KubernetesQueryError)
    expect(() => runtime(fakeAgents(), { defaultLogTailLines: 600, maxLogTailLines: 500 })).toThrow(KubernetesQueryError)
    expect(() => runtime(fakeAgents(), { maxLogTailLines: 0 })).toThrow(KubernetesQueryError)
  })
})
