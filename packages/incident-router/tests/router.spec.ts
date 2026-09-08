import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
  type WebhookRule,
} from '@deepseek-ai/dsh-webhook'
import type { AlertmanagerAlert, AlertmanagerWebhookEvent } from '@deepseek-ai/dsh-webhook-alertmanager'
import { afterEach, describe, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import AiopsIncidentRouter, { Config as RouterConfig, type Config, type RoutingSettings } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface FakeAgent extends Agent {
  readonly events: SessionEvent[]
  readonly followups: unknown[]
  settle(): void
}

function alert(status: 'firing' | 'resolved', overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return {
    status,
    labels: { alertname: 'KubePodCrashLooping', severity: 'critical' },
    annotations: { summary: 'pod restarts' },
    startsAt: '2026-09-06T01:00:00Z',
    endsAt: status === 'resolved' ? '2026-09-06T01:05:00Z' : '0001-01-01T00:00:00Z',
    fingerprint: '0123456789abcdef',
    fingerprintSource: 'provider',
    ...overrides,
  }
}

function delivery(
  deliveryId: string,
  status: 'firing' | 'resolved' = 'firing',
  alertValue: AlertmanagerAlert = alert(status),
): VerifiedWebhookDelivery<'alertmanager'> {
  const event: AlertmanagerWebhookEvent = {
    version: 1,
    payloadDigest: `sha256:${deliveryId}`,
    status,
    receiver: 'platform',
    groupKey: 'group-1',
    truncatedAlerts: 0,
    groupLabels: { alertname: alertValue.labels['alertname'] ?? '' },
    commonLabels: { severity: alertValue.labels['severity'] ?? '' },
    commonAnnotations: {},
    alerts: [alertValue],
  }
  return {
    kind: 'alertmanager',
    source: WebhookSourceId('primary'),
    deliveryId: WebhookDeliveryId(deliveryId),
    event,
    receivedAt: Date.now(),
  }
}

function makeAgent(id: ReturnType<typeof SessionId>, cwd = '/workspace', manualIdle = false): FakeAgent {
  const events: SessionEvent[] = []
  const followups: unknown[] = []
  let idle = Promise.resolve()
  let settle = () => {}
  const session = {
    id,
    header: { cwd },
    ownEvents: () => events,
    append(type: string, data: unknown, options?: { ignorable?: true }) {
      const event = {
        seq: events.length,
        type,
        data,
        ...(options?.ignorable === true ? { ignorable: true } : {}),
      } as unknown as SessionEvent
      events.push(event)
      return event
    },
  }
  return {
    id,
    session,
    events,
    followups,
    followup: message => {
      followups.push(message)
      if (manualIdle) idle = new Promise<void>(resolve => { settle = resolve })
    },
    whenIdle: () => idle,
    settle: () => { settle() },
  } as unknown as FakeAgent
}

const config = {
  source: 'primary',
  ruleId: 'aiops-router-test',
  statePath: ':memory:',
  workspacePath: '/workspace',
  agentPreset: 'standard',
  permissionPreset: 'read-only',
  routingPolicy: {
    ignoredAlertnames: ['Watchdog', 'InfoInhibitor'],
    defaultSeverity: 'warning',
  },
  severityMap: { critical: 'critical', warning: 'warning' },
  modelBudgets: { info: 1000, warning: 2000, critical: 3000 },
  stormControl: {
    cooldownSeconds: 0,
    maxQueueSize: 100,
    maxQueueAgeSeconds: 300,
    maxDispatchAttempts: 3,
    retryBackoffSeconds: 1,
    globalConcurrency: 10,
    severityConcurrency: { info: 10, warning: 10, critical: 10 },
    globalReservedTokens: 30_000,
    severityReservedTokens: { info: 10_000, warning: 20_000, critical: 30_000 },
  },
  diagnosisWindow: {
    beforeSeconds: 900,
    afterSeconds: 1800,
    prometheusStepSeconds: 30,
    logTailLines: 1000,
  },
} satisfies Config

function harness(options: { persisted?: boolean; manualIdle?: boolean; config?: Config; locale?: string } = {}): {
  ctx: Context
  rule: () => WebhookRule<'alertmanager'>
  agents: Map<string, FakeAgent>
  create: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  updatePolicy: (next: RoutingSettings) => void
  router: AiopsIncidentRouter
} {
  const ctx = new Context()
  contexts.push(ctx)
  const agents = new Map<string, FakeAgent>()
  let registered: WebhookRule<'alertmanager'> | undefined
  const create = vi.fn(async (input: CreateAgentOptions) => {
    await Promise.resolve()
    const agent = makeAgent(input.sessionId, '/workspace', options.manualIdle)
    agents.set(input.sessionId, agent)
    return { agent, dispose: async () => { agents.delete(input.sessionId) } }
  })
  const resume = vi.fn(async (input: ResumeAgentOptions) => {
    const agent = makeAgent(input.resumeSessionId, '/workspace', options.manualIdle)
    agents.set(input.resumeSessionId, agent)
    return { agent, dispose: async () => { agents.delete(input.resumeSessionId) } }
  })
  const attach = vi.fn(async () => {})
  let routingSettings: RoutingSettings | undefined
  const policyWatchers = new Set<(next: RoutingSettings, previous: RoutingSettings) => void>()
  ctx.provide('agents', {
    get: (id: string) => agents.get(id),
    create,
    resume,
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } as never)
  ctx.provide('agentPresets', {
    resolve: async (id: string) => ({ id }),
    standingKeyFor: async () => 'standing',
    mount: async () => {},
  } as never)
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() } as never)
  ctx.provide('sessionPersistence', {
    stat: async (id: string) => options.persisted ? { id, revision: 'r1' } : undefined,
  } as never)
  ctx.provide('settings', {
    get: (namespace: string) => namespace === 'locale'
      ? options.locale === undefined ? {} : { preference: options.locale }
      : undefined,
    register: (_namespace: string, _schema: unknown, registration: { base?: unknown }) => {
      routingSettings = registration.base as RoutingSettings
      return {
      get: () => routingSettings,
      watch: (callback: (next: RoutingSettings, previous: RoutingSettings) => void) => {
        policyWatchers.add(callback)
        return () => { policyWatchers.delete(callback) }
      },
      update: vi.fn(),
      replace: vi.fn(),
      }
    },
  } as never)
  ctx.provide('sessions', { flush: async () => true } as never)
  ctx.provide('sessionTitle', { rename: vi.fn() } as never)
  ctx.provide('workspaceRegistry', {
    create: async () => ({ path: '/workspace', attachSession: attach, detachSession: async () => {} }),
  } as never)
  ctx.provide('webhookRuntime', {
    register: (rule: WebhookRule<'alertmanager'>) => {
      registered = rule
      return async () => {}
    },
  } as never)
  ctx.provide('aiopsTelemetry', {
    markComponent: vi.fn(),
    recordWork: vi.fn(),
    recordDispatchFailure: vi.fn(),
    setRouterGauges: vi.fn(),
    observeDiagnosticLatency: vi.fn(),
  } as never)
  const router = new AiopsIncidentRouter(ctx, options.config ?? config)
  return {
    ctx,
    rule: () => {
      if (registered === undefined) throw new Error('rule was not registered')
      return registered
    },
    agents,
    create,
    resume,
    attach,
    updatePolicy: (next) => {
      const previous = routingSettings!
      routingSettings = next
      for (const watcher of policyWatchers) watcher(next, previous)
    },
    router,
  }
}

describe('AIOps incident router', () => {
  it('declares the settings service used to register its live policy scope', () => {
    expect(AiopsIncidentRouter.inject).toContain('settings')
  })

  it('loads the pre-F.2 allowlist shape with safe general-routing defaults for migration', () => {
    const { routingPolicy: _removed, ...legacy } = config
    const [migrated] = z.resolve({ ...legacy, alertnameAllowlist: ['TargetDown'] }, RouterConfig)
    expect(migrated.routingPolicy).toEqual({
      ignoredAlertnames: ['Watchdog', 'InfoInhibitor'],
      defaultSeverity: 'warning',
    })
    const migratedRouter = harness({ config: migrated }).router
    expect(migratedRouter.dryRun({ alertname: 'TargetDown' })).toMatchObject({ accepted: true, severity: 'warning' })
    expect(migratedRouter.dryRun({ alertname: 'Watchdog' })).toMatchObject({ accepted: false, reason: 'alertname-ignored' })
    const [cleanInstall] = z.resolve(config, RouterConfig)
    expect(cleanInstall.alertnameAllowlist).toEqual([])
  })

  it('applies versioned routing settings live, supports dry-run, and audits changes', async () => {
    const test = harness()
    const current = test.router.routingSettings()
    const next: RoutingSettings = {
      ...current,
      routingPolicy: { ignoredAlertnames: ['VendorHeartbeat'], defaultSeverity: 'critical' },
    }
    expect(test.router.dryRun({ alertname: 'VendorHeartbeat' }, next)).toMatchObject({
      accepted: false,
      reason: 'alertname-ignored',
    })
    test.updatePolicy(next)
    await test.rule().run(delivery('policy-filtered', 'firing', alert('firing', {
      labels: { alertname: 'VendorHeartbeat' },
      fingerprint: 'aaaaaaaaaaaaaaaa',
    })), new AbortController().signal)
    expect(test.create).not.toHaveBeenCalled()
    expect(test.router.routingSettings()).toEqual(next)
    expect(test.router.listPolicyAudit({ limit: 10 })).toEqual([
      expect.objectContaining({ version: 1, changedFields: ['routingPolicy'], previous: current, next }),
    ])
  })

  it('creates one deterministic Session and appends later firing and resolved deliveries', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.rule().run(delivery('d1'), signal)
    await test.rule().run(delivery('d2'), signal)
    await test.rule().run(delivery('d3', 'resolved'), signal)
    expect(test.create).toHaveBeenCalledOnce()
    expect(test.attach).toHaveBeenCalledOnce()
    const [agent] = [...test.agents.values()]
    expect(agent?.events.filter(event => event.type === 'aiops/alert-routed'))
      .toHaveLength(3)
    expect(agent?.followups).toHaveLength(3)
    expect(agent?.events.map(event => event.type === 'aiops/alert-routed' ? event.data.decision : undefined))
      .toEqual(['created', 'appended', 'resolved'])
    const routed = agent?.events.find(event => event.type === 'aiops/alert-routed')
    expect(routed?.type === 'aiops/alert-routed' ? routed.data : undefined).toMatchObject({
      version: 2,
      diagnosis: {
        anchor: { source: 'alert.startsAt', time: '2026-09-06T01:00:00.000Z' },
        prometheusQueryRange: { start: '2026-09-06T00:45:00.000Z', step: '30s' },
        kubernetesLogs: { since_time: '2026-09-06T00:45:00.000Z', tail_lines: 1000, timestamps: true },
      },
    })
    expect(JSON.stringify(agent?.followups[0])).toContain('Load and follow the aiops-diag skill')
    expect(JSON.stringify(agent?.followups[0])).toContain('Kubernetes is optional, not assumed')
    expect(JSON.stringify(agent?.followups[0])).toContain('2026-09-06T01:00:00.000Z')
    expect(JSON.stringify(agent?.followups[0])).toContain('English (en)')
  })

  it('uses the current DSH locale preference for model output and persisted report text', async () => {
    const test = harness({ locale: 'zh' })
    await test.rule().run(delivery('zh-locale'), new AbortController().signal)
    const [agent] = [...test.agents.values()]
    const prompt = JSON.stringify(agent?.followups[0])
    expect(prompt).toContain('Simplified Chinese (zh)')
    expect(prompt).toContain('user-facing narrative and persisted incident-report text')
  })

  it('suppresses an exact delivery replay after the route event is durable', async () => {
    const test = harness()
    const same = delivery('same')
    await test.rule().run(same, new AbortController().signal)
    await test.rule().run(same, new AbortController().signal)
    const [agent] = [...test.agents.values()]
    expect(test.create).toHaveBeenCalledOnce()
    expect(agent?.events).toHaveLength(1)
    expect(agent?.followups).toHaveLength(1)
  })

  it('coalesces concurrent deliveries for the first alert round', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await Promise.all([
      test.rule().run(delivery('parallel-1'), signal),
      test.rule().run(delivery('parallel-2'), signal),
    ])
    expect(test.create).toHaveBeenCalledOnce()
    const [agent] = [...test.agents.values()]
    expect(agent?.events).toHaveLength(2)
  })

  it('creates a new Session round after a resolved alert fires again', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.rule().run(delivery('d1'), signal)
    await test.rule().run(delivery('d2', 'resolved'), signal)
    await test.rule().run(delivery('d3'), signal)
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(test.agents.size).toBe(2)
    expect([...test.agents.keys()][0]).not.toBe([...test.agents.keys()][1])
  })

  it('ignores configured noise while routing arbitrary alerts with fallback severity', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.rule().run(delivery('ignored-name', 'firing', alert('firing', {
      labels: { alertname: 'Watchdog', severity: 'critical' },
      fingerprint: '1111111111111111',
    })), signal)
    await test.rule().run(delivery('custom-severity', 'firing', alert('firing', {
      labels: { alertname: 'DatabaseReplicationLag', severity: 'vendor-unknown' },
      fingerprint: '2222222222222222',
    })), signal)
    await test.rule().run(delivery('missing-severity', 'firing', alert('firing', {
      labels: { alertname: 'ExternalApiUnavailable' },
      fingerprint: '3333333333333333',
    })), signal)
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(test.router.listControlAudit({ limit: 20, outcome: 'filtered' }))
      .toEqual([expect.objectContaining({ deliveryId: 'ignored-name', reason: 'alertname-ignored' })])
    const routed = [...test.agents.values()].flatMap(agent => agent.events)
      .filter(event => event.type === 'aiops/alert-routed')
    expect(routed).toHaveLength(2)
    expect(routed.every(event => event.type === 'aiops/alert-routed' && event.data.severity === 'warning')).toBe(true)
  })

  it('matches configured severity labels case-insensitively', async () => {
    const test = harness()
    await test.rule().run(delivery('uppercase-severity', 'firing', alert('firing', {
      labels: { alertname: 'CustomCriticalAlert', severity: 'CRITICAL' },
      fingerprint: '4444444444444444',
    })), new AbortController().signal)
    const [agent] = [...test.agents.values()]
    const routed = agent?.events.find(event => event.type === 'aiops/alert-routed')
    expect(routed?.type === 'aiops/alert-routed' ? routed.data.severity : undefined).toBe('critical')
  })

  it('resumes a persisted deterministic Session after restart-style absence from the live registry', async () => {
    const test = harness({ persisted: true })
    await test.rule().run(delivery('after-restart'), new AbortController().signal)
    expect(test.resume).toHaveBeenCalledOnce()
    expect(test.create).not.toHaveBeenCalled()
    expect([...test.agents.values()][0]?.events).toHaveLength(1)
  })

  it('groups a same-fingerprint burst into one later model turn', async () => {
    const test = harness({ manualIdle: true })
    const signal = new AbortController().signal
    await test.rule().run(delivery('burst-1'), signal)
    const agent = [...test.agents.values()][0]
    if (agent === undefined) throw new Error('missing first burst agent')
    await Promise.all([
      test.rule().run(delivery('burst-2'), signal),
      test.rule().run(delivery('burst-3'), signal),
    ])
    expect(agent.events).toHaveLength(1)
    expect(agent.followups).toHaveLength(1)
    expect(test.router.listControlAudit({ limit: 20, outcome: 'grouped' })).toHaveLength(2)
    agent.settle()
    await Promise.resolve()
    await test.router.drainPending(signal)
    expect(agent.events.filter(event => event.type === 'aiops/alert-routed')).toHaveLength(3)
    expect(agent.followups).toHaveLength(2)
    expect(JSON.stringify(agent.followups[1])).toContain('grouped 2')
  })

  it('defers on reserved-token saturation and explicitly drops when the queue is full', async () => {
    const constrained: Config = {
      ...config,
      severityMap: { ...config.severityMap, info: 'info' },
      stormControl: {
        ...config.stormControl,
        maxQueueSize: 1,
        globalConcurrency: 10,
        globalReservedTokens: 3000,
      },
    }
    const test = harness({ manualIdle: true, config: constrained })
    const signal = new AbortController().signal
    await test.rule().run(delivery('capacity-1'), signal)
    await test.rule().run(delivery('capacity-2', 'firing', alert('firing', {
      fingerprint: '1111111111111111',
    })), signal)
    await test.rule().run(delivery('capacity-3', 'firing', alert('firing', {
      fingerprint: '2222222222222222',
    })), signal)
    expect(test.create).toHaveBeenCalledOnce()
    expect(test.router.listControlAudit({ limit: 20, outcome: 'deferred' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'global-token-budget' })]))
    expect(test.router.listControlAudit({ limit: 20, outcome: 'dropped' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ deliveryId: 'capacity-3', reason: 'queue-full' })]))
    const first = [...test.agents.values()][0]
    first?.settle()
    await Promise.resolve()
    await test.router.drainPending(signal)
    expect(test.create).toHaveBeenCalledTimes(2)
  })

  it('enforces severity and global concurrent-turn budgets before opening Agents', async () => {
    const constrained: Config = {
      ...config,
      severityMap: { ...config.severityMap, info: 'info' },
      stormControl: {
        ...config.stormControl,
        globalConcurrency: 2,
        severityConcurrency: { info: 1, warning: 1, critical: 1 },
      },
    }
    const test = harness({ manualIdle: true, config: constrained })
    const signal = new AbortController().signal
    await test.rule().run(delivery('critical-1'), signal)
    await test.rule().run(delivery('critical-2', 'firing', alert('firing', {
      fingerprint: '1111111111111111',
    })), signal)
    await test.rule().run(delivery('warning-1', 'firing', alert('firing', {
      labels: { alertname: 'KubePodCrashLooping', severity: 'warning' },
      fingerprint: '2222222222222222',
    })), signal)
    await test.rule().run(delivery('info-1', 'firing', alert('firing', {
      labels: { alertname: 'KubePodCrashLooping', severity: 'info' },
      fingerprint: '3333333333333333',
    })), signal)
    expect(test.create).toHaveBeenCalledTimes(2)
    const reasons = test.router.listControlAudit({ limit: 20, outcome: 'deferred' }).map(item => item.reason)
    expect(reasons).toContain('severity-concurrency')
    expect(reasons).toContain('global-concurrency')
  })

  it('audits capacity deferral discovered while draining one multi-alert delivery', async () => {
    const constrained: Config = {
      ...config,
      stormControl: {
        ...config.stormControl,
        globalConcurrency: 1,
        severityConcurrency: { info: 1, warning: 1, critical: 1 },
      },
    }
    const test = harness({ manualIdle: true, config: constrained })
    const single = delivery('batch-capacity')
    const batched: VerifiedWebhookDelivery<'alertmanager'> = {
      ...single,
      event: {
        ...single.event,
        alerts: [
          ...single.event.alerts,
          alert('firing', { fingerprint: '3333333333333333' }),
        ],
      },
    }
    await test.rule().run(batched, new AbortController().signal)
    expect(test.create).toHaveBeenCalledOnce()
    expect(test.router.listControlAudit({ limit: 20, outcome: 'deferred' }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ fingerprint: '3333333333333333', reason: 'global-concurrency' }),
      ]))
  })

  it('holds repeat work until the persisted fingerprint cooldown expires', async () => {
    let now = Date.parse('2026-09-06T02:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const cooled: Config = {
      ...config,
      stormControl: { ...config.stormControl, cooldownSeconds: 60 },
    }
    const test = harness({ config: cooled })
    const signal = new AbortController().signal
    await test.rule().run(delivery('cooldown-1'), signal)
    const agent = [...test.agents.values()][0]
    await test.rule().run(delivery('cooldown-2'), signal)
    expect(agent?.events).toHaveLength(1)
    expect(test.router.listControlAudit({ limit: 20, outcome: 'deferred' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'cooldown' })]))
    now += 60_000
    await test.router.drainPending(signal)
    expect(agent?.events).toHaveLength(2)
  })
})
