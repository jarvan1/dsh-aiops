import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { filterPortalIncidents } from '../src/client/model.ts'
import { testEndpointConnection } from '../src/connectivity.ts'
import { apply, testPortalConnection } from '../src/index.ts'
import { readPortalSnapshot, summarizePortal } from '../src/snapshot.ts'
import { PORTAL_API_PATH, PORTAL_CONNECTION_TEST_API_PATH, PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH, PORTAL_WEBHOOK_CONFIGURATION_API_PATH, type PortalIncident } from '../src/types.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { RoutingSettings } from '@deepseek-ai/dsh-aiops-incident-router'

const routingSettings: RoutingSettings = {
  version: 1,
  routingPolicy: { ignoredAlertnames: ['Watchdog'], defaultSeverity: 'warning' },
  severityMap: { warning: 'warning', critical: 'critical' },
  modelBudgets: { info: 1000, warning: 2000, critical: 3000 },
  stormControl: {
    cooldownSeconds: 60, maxQueueSize: 100, maxQueueAgeSeconds: 900, maxDispatchAttempts: 3,
    retryBackoffSeconds: 10, globalConcurrency: 4,
    severityConcurrency: { info: 1, warning: 2, critical: 4 }, globalReservedTokens: 10_000,
    severityReservedTokens: { info: 1000, warning: 4000, critical: 10_000 },
  },
}

function incident(overrides: Partial<PortalIncident> = {}): PortalIncident {
  return {
    sessionId: 'aiops-session-1',
    reportSeq: 3,
    reportTime: 1_000,
    incident: {
      version: 1,
      incidentId: 'incident-1' as never,
      title: 'API latency on checkout',
      severity: 'critical',
      status: 'investigating',
      evidence: [{ id: 'metric-1' as never, kind: 'metric', summary: 'p99 latency is 4 seconds' }],
      hypotheses: [{ summary: 'database saturation', confidence: 'strong', evidenceIds: ['metric-1' as never] }],
      recommendations: [{ action: 'Inspect connection pool', risk: 'low' }],
    },
    ...overrides,
  }
}

describe('AIOps Portal read model', () => {
  it('ships a self-contained importable Host entry', async () => {
    const entry = new URL('../lib/index.js', import.meta.url)
    const source = await readFile(entry, 'utf8')
    expect(source).not.toMatch(/from ["']\.\//)
    const built = await import(entry.href)
    expect(built).toMatchObject({ name: 'aiops-portal', PORTAL_API_PATH })
  })

  it('registers a disposable exact route and rejects mutations before querying', async () => {
    const routes: WebRoute[] = []
    const dispose = vi.fn()
    const query = vi.fn()
    const ctx: Record<string, unknown> = {
      effect: (setup: () => () => void) => { setup() },
      webServer: { register: (next: WebRoute) => { routes.push(next); return dispose } },
      sessionQuery: { filterSessions: query },
      aiopsIncidentRouter: { workspacePath: '/srv/prod', listControlAudit: () => [] },
      credentials: { resolve: vi.fn(async () => ({ value: 'portal-test-secret' })) },
      logger: { warn: vi.fn() },
    }
    ctx.inject = (_services: string[], mount: (value: unknown) => void) => mount(ctx)
    apply(ctx as never, { webhookUrl: 'https://dsh.example.test:3081/alertmanager' })
    const route = routes.find(value => value.path === PORTAL_API_PATH)
    expect(route).toMatchObject({ kind: 'exact', path: PORTAL_API_PATH })
    expect(routes).toContainEqual(expect.objectContaining({ kind: 'exact', path: PORTAL_CONNECTION_TEST_API_PATH }))
    expect(routes).toContainEqual(expect.objectContaining({ kind: 'exact', path: PORTAL_WEBHOOK_CONFIGURATION_API_PATH }))
    expect(routes).toContainEqual(expect.objectContaining({ kind: 'exact', path: PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH }))
    const req = Object.assign(new EventEmitter(), { method: 'POST' })
    const headers = new Map<string, unknown>()
    const res = {
      statusCode: 0,
      writableEnded: false,
      setHeader: (name: string, value: unknown) => headers.set(name, value),
      end(body?: string) { this.writableEnded = true; expect(body).toContain('method_not_allowed') },
    }
    await route?.handler(req as never, res as never)
    expect(res.statusCode).toBe(405)
    expect(headers.get('allow')).toBe('GET, HEAD')
    expect(query).not.toHaveBeenCalled()
  })

  it('reports webhook credential status without ever disclosing the secret', async () => {
    const routes: WebRoute[] = []
    const resolve = vi.fn(async () => ({ value: 'portal-test-secret' }))
    const ctx: Record<string, unknown> = {
      effect: (setup: () => () => void) => { setup() },
      webServer: { register: (next: WebRoute) => { routes.push(next); return vi.fn() } },
      sessionQuery: {},
      aiopsIncidentRouter: { workspacePath: '/srv/prod', listControlAudit: () => [] },
      kubernetes: {},
      credentials: { resolve },
      logger: { warn: vi.fn() },
    }
    ctx.inject = (_services: string[], mount: (value: unknown) => void) => mount(ctx)
    apply(ctx as never, {
      webhookUrl: 'https://dsh.example.test:3081/alertmanager',
      webhookSecretRef: 'AIOPS_ALERTMANAGER_WEBHOOK_SECRET',
    })
    const route = routes.find(value => value.path === PORTAL_WEBHOOK_CONFIGURATION_API_PATH)
    const request = async () => {
      const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {} })
      let body = ''
      const res = {
        statusCode: 0,
        setHeader: vi.fn(),
        end(value?: string) { body = value ?? '' },
      }
      await route?.handler(req as never, res as never)
      return JSON.parse(body) as Record<string, unknown>
    }
    await expect(request()).resolves.toEqual({
      version: 2,
      url: 'https://dsh.example.test:3081/alertmanager',
      secretConfigured: true,
    })
    expect(JSON.stringify(await request())).not.toContain('portal-test-secret')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('validates and evaluates a routing-policy dry-run without mutation', async () => {
    const routes: WebRoute[] = []
    const dryRun = vi.fn(() => ({ version: 1, accepted: true, alertname: 'TargetDown', severity: 'warning', reason: 'accepted' }))
    const ctx: Record<string, unknown> = {
      effect: (setup: () => () => void) => { setup() },
      webServer: { register: (next: WebRoute) => { routes.push(next); return vi.fn() } },
      sessionQuery: {}, kubernetes: {}, credentials: { resolve: vi.fn(async () => undefined) },
      aiopsIncidentRouter: { dryRun }, logger: { warn: vi.fn() },
    }
    ctx.inject = (_services: string[], mount: (value: unknown) => void) => mount(ctx)
    apply(ctx as never, {})
    const route = routes.find(value => value.path === PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH)
    const req = Object.assign(Readable.from([JSON.stringify({ labels: { alertname: 'TargetDown' }, settings: routingSettings })]), {
      method: 'POST', headers: { 'content-type': 'application/json' },
    })
    let body = ''
    const res = { statusCode: 0, setHeader: vi.fn(), end: (value?: string) => { body = value ?? '' } }
    await route?.handler(req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ accepted: true, severity: 'warning' })
    expect(dryRun).toHaveBeenCalledWith({ alertname: 'TargetDown' }, routingSettings)
    const crossSite = Object.assign(Readable.from([JSON.stringify({ labels: {}, settings: routingSettings })]), {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: 'dsh.example' },
    })
    const rejected = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() }
    await route?.handler(crossSite as never, rejected as never)
    expect(rejected.statusCode).toBe(403)
    expect(dryRun).toHaveBeenCalledOnce()
  })

  it('tests the real Prometheus and Alertmanager API shapes without saving settings', async () => {
    const prometheusFetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [] },
    }), { status: 200 }))
    await expect(testEndpointConnection('prometheus', 'http://prometheus:9090', undefined, prometheusFetch))
      .resolves.toMatchObject({ ok: true })
    expect(String(prometheusFetch.mock.calls[0]?.[0])).toBe('http://prometheus:9090/api/v1/query?query=vector%281%29')

    const alertmanagerFetch = vi.fn(async () => new Response('[]', { status: 200 }))
    await expect(testEndpointConnection('alertmanager', 'http://alertmanager:9093', undefined, alertmanagerFetch))
      .resolves.toMatchObject({ ok: true })
    expect(String(alertmanagerFetch.mock.calls[0]?.[0])).toContain('http://alertmanager:9093/api/v2/alerts?')
  })

  it('tests Kubernetes connectivity and rejects missing diagnosis RBAC', async () => {
    const testConnection = vi.fn(async () => ({
      context: 'prod', cluster: 'prod-cluster', namespace: 'payments', server: 'https://cluster',
      capabilities: { pods: true, events: false, podLogs: false },
    }))
    await expect(testPortalConnection({ kubernetes: { testConnection } } as never, {
      target: 'kubernetes', kubeconfig: '/srv/dsh/.kube/config', context: 'prod',
    }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, code: 'rbac_denied', missingPermissions: ['events', 'podLogs'],
    })
    expect(testConnection).toHaveBeenCalledWith({ kubeconfig: '/srv/dsh/.kube/config', context: 'prod' }, expect.any(AbortSignal))
  })

  it('rejects invalid URLs, HTTP failures, and responses from the wrong service', async () => {
    await expect(testEndpointConnection('prometheus', 'file:///etc/passwd'))
      .resolves.toMatchObject({ ok: false, code: 'invalid_url' })
    await expect(testEndpointConnection('prometheus', 'http://prometheus:9090', undefined,
      async () => new Response('denied', { status: 403 })))
      .resolves.toMatchObject({ ok: false, code: 'http_error', status: 403 })
    await expect(testEndpointConnection('alertmanager', 'http://prometheus:9090', undefined,
      async () => new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 })))
      .resolves.toMatchObject({ ok: false, code: 'invalid_response' })
  })

  it('summarizes active, severity, review, and audit outcomes', () => {
    const reviewed = incident({
      feedback: {
        seq: 4,
        time: 1_100,
        feedback: {
          version: 1,
          feedbackId: 'feedback-1' as never,
          incidentId: 'incident-1' as never,
          reportSeq: 3,
          verdict: 'corrected',
          note: 'The pool was healthy.',
          correction: 'A downstream dependency was saturated.',
          origin: 'operator-via-agent',
        },
      },
    })
    expect(summarizePortal([reviewed], [{ outcome: 'deferred' }, { outcome: 'deferred' }, { outcome: 'completed' }] as never))
      .toMatchObject({ totalIncidents: 1, active: 1, critical: 1, reviewed: 1, corrected: 1, audit: { deferred: 2, completed: 1 } })
  })

  it('filters across structured diagnosis content and review state', () => {
    const reviewed = incident({ feedback: { seq: 4, time: 1_100, feedback: { version: 1, feedbackId: 'f' as never, incidentId: 'incident-1' as never, reportSeq: 3, verdict: 'confirmed', note: 'verified by operator', origin: 'operator-via-agent' } } })
    expect(filterPortalIncidents([reviewed], { query: 'database saturation', severity: 'critical', status: 'all', review: 'reviewed' })).toEqual([reviewed])
    expect(filterPortalIncidents([reviewed], { query: '', severity: 'warning', status: 'all', review: 'all' })).toEqual([])
  })

  it('reads only the configured workspace and keeps the latest report per session', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_999)
    const older = incident().incident
    const latest = { ...older, title: 'Latest diagnosis' }
    const reportHits = [
      { sessionId: 'aiops-session-1', seq: 2, time: 900, type: 'aiops/incident-state' },
      { sessionId: 'aiops-session-1', seq: 3, time: 1_000, type: 'aiops/incident-state' },
    ]
    const ctx = {
      aiopsIncidentRouter: {
        workspacePath: '/srv/prod',
        listControlAudit: () => [{ id: 8, source: 'am', deliveryId: 'd', fingerprint: 'fp', alertname: 'HighLatency', severity: 'critical', outcome: 'completed', reason: 'diagnosed', sessionId: 'aiops-session-1', round: 1, queueDepth: 0, reservedTokens: 0, recordedAt: 1_010, attempt: 1 }],
        routingSettings: () => routingSettings,
        listPolicyAudit: () => [],
      },
      sessionQuery: {
        filterSessions: vi.fn(async () => [{ header: { id: 'aiops-session-1' } }]),
        listEvents: vi.fn(async () => reportHits),
        readEvent: vi.fn(async ({ seq }: { seq: number }) => ({ target: { type: 'aiops/incident-state', data: seq === 3 ? latest : older } })),
      },
    }
    const snapshot = await readPortalSnapshot(ctx as never, { maxIncidents: 10, maxAuditRecords: 10, maxScanSessions: 10 })
    expect(ctx.sessionQuery.filterSessions).toHaveBeenCalledWith([{ kind: 'cwd', values: ['/srv/prod'] }], undefined)
    expect(snapshot).toMatchObject({ version: 2, workspace: '/srv/prod', generatedAt: 9_999, routingSettings, routingPolicyAudit: [] })
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.incidents[0]).toMatchObject({ reportSeq: 3, incident: { title: 'Latest diagnosis' }, lastRoute: { outcome: 'completed' } })
  })
})
