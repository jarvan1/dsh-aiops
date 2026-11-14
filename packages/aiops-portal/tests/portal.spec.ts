import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { filterPortalIncidents } from '../src/client/model.ts'
import { testEndpointConnection } from '../src/connectivity.ts'
import { apply } from '../src/index.ts'
import { readPortalSnapshot, summarizePortal } from '../src/snapshot.ts'
import {
  PORTAL_API_PATH,
  PORTAL_CLUSTER_PROBE_API_PATH,
  PORTAL_CLUSTER_REVOKE_API_PATH,
  PORTAL_CLUSTER_TOKEN_API_PATH,
  PORTAL_CLUSTERS_API_PATH,
  PORTAL_CONNECTION_TEST_API_PATH,
  PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH,
  PORTAL_WEBHOOK_CONFIGURATION_API_PATH,
  type PortalIncident,
} from '../src/types.ts'
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
    revision: 3,
    updatedAt: 1_000,
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
      aiopsAgents: { listClusters: () => [], configured: () => false },
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
      sessionQuery: {}, credentials: { resolve: vi.fn(async () => undefined) },
      aiopsAgents: { listClusters: () => [], configured: () => false },
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

  it('issues a token once, lists clusters, reveals no secret, and rejects cross-site writes', async () => {
    const routes: WebRoute[] = []
    const issued = { cluster: { name: 'prod', status: 'pending', createdAt: 1_000 }, token: 'dsha_0123456789012345678901234567890123456789012' }
    const createCluster = vi.fn(async () => issued)
    const reissueToken = vi.fn(async () => issued)
    const revokeCluster = vi.fn(async () => ({ name: 'prod', status: 'revoked', createdAt: 1_000, revokedAt: 1_500 }))
    const probe = vi.fn(async () => ({ name: 'prod', version: '1.2.3', protocol: 1, capabilities: { resources: ['pods'], events: true, logs: true, maxResponseBytes: 2_000_000, maxTailLines: 2_000 } }))
    const ctx: Record<string, unknown> = {
      effect: (setup: () => () => void) => { setup() },
      webServer: { register: (next: WebRoute) => { routes.push(next); return vi.fn() } },
      sessionQuery: {}, credentials: { resolve: vi.fn(async () => undefined) },
      aiopsIncidentRouter: { workspacePath: '/srv/prod', listControlAudit: () => [] },
      aiopsAgents: { listClusters: () => [issued.cluster], configured: () => true, createCluster, reissueToken, revokeCluster, probe },
      logger: { warn: vi.fn() },
    }
    ctx.inject = (_services: string[], mount: (value: unknown) => void) => mount(ctx)
    apply(ctx as never, {})
    const call = async (path: string, request: unknown, headers: Record<string, string> = {}) => {
      const route = routes.find(value => value.path === path)
      const req = Object.assign(Readable.from([JSON.stringify(request)]), {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'dsh.example', ...headers },
      }) as never
      let body = ''
      const res = Object.assign(new EventEmitter(), {
        statusCode: 0,
        setHeader: vi.fn(),
        writableEnded: false,
        end(value?: string) { body = value ?? ''; this.writableEnded = true },
      })
      await route?.handler(req, res as never)
      return { status: res.statusCode, body: body === '' ? undefined : JSON.parse(body) as Record<string, unknown>, raw: body }
    }

    const created = await call(PORTAL_CLUSTERS_API_PATH, { name: 'prod' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ token: issued.token, cluster: { name: 'prod', status: 'pending' } })
    expect(createCluster).toHaveBeenCalledWith('prod')

    // The read-only list never carries a token or digest, and HEAD/GET share it.
    const listRoute = routes.find(value => value.path === PORTAL_CLUSTERS_API_PATH)
    const listReq = Object.assign(new EventEmitter(), { method: 'GET' })
    let listBody = ''
    const listRes = { statusCode: 0, setHeader: vi.fn(), end: (value?: string) => { listBody = value ?? '' } }
    await listRoute?.handler(listReq as never, listRes as never)
    expect(JSON.parse(listBody)).toMatchObject({ version: 1, needsCluster: false, clusters: [{ name: 'prod', status: 'pending' }] })
    expect(listBody).not.toContain('dsha_')
    expect(listBody).not.toContain('tokenHash')

    const rejected = await call(PORTAL_CLUSTERS_API_PATH, { name: 'prod' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
    expect(rejected.status).toBe(403)
    expect(rejected.raw).not.toContain(issued.token)
    expect(createCluster).toHaveBeenCalledTimes(1)

    await expect(call(PORTAL_CLUSTER_TOKEN_API_PATH, { name: 'prod' })).resolves.toMatchObject({ status: 200, body: { token: issued.token } })
    await expect(call(PORTAL_CLUSTER_REVOKE_API_PATH, { name: 'prod' })).resolves.toMatchObject({ status: 200, body: { cluster: { status: 'revoked' } } })

    const probeRoute = routes.find(value => value.path === PORTAL_CLUSTER_PROBE_API_PATH)
    expect(probeRoute).toBeDefined()
    const probed = await call(PORTAL_CLUSTER_PROBE_API_PATH, { name: 'prod' })
    expect(probed.status).toBe(200)
    expect(probed.body).toMatchObject({ ok: true, agent: { name: 'prod', version: '1.2.3' } })
    expect(probe).toHaveBeenCalledWith('prod', expect.any(AbortSignal))
  })

  it('summarizes active, severity, review, and audit outcomes', () => {
    const reviewed = incident({
      feedback: {
        time: 1_100,
        feedback: {
          version: 1,
          feedbackId: 'feedback-1' as never,
          incidentId: 'incident-1' as never,
          reportRevision: 3,
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
    const reviewed = incident({ feedback: { time: 1_100, feedback: { version: 1, feedbackId: 'f' as never, incidentId: 'incident-1' as never, reportRevision: 3, verdict: 'confirmed', note: 'verified by operator', origin: 'operator-via-agent' } } })
    expect(filterPortalIncidents([reviewed], { query: 'database saturation', severity: 'critical', status: 'all', review: 'reviewed' })).toEqual([reviewed])
    expect(filterPortalIncidents([reviewed], { query: '', severity: 'warning', status: 'all', review: 'all' })).toEqual([])
  })

  it('reads only the configured workspace and joins the latest review per session', () => {
    vi.spyOn(Date, 'now').mockReturnValue(9_999)
    const older = incident().incident
    const latest = { ...older, title: 'Latest diagnosis' }
    const listIncidents = vi.fn((workspace?: string) => workspace === '/srv/prod'
      ? [
        { sessionId: 'aiops-session-1', workspace: '/srv/prod', revision: 3, updatedAt: 1_000, incident: latest },
        { sessionId: 'aiops-session-2', workspace: '/srv/prod', revision: 1, updatedAt: 2_000, incident: older },
      ]
      : [])
    const staleFeedback = { sessionId: 'aiops-session-2', time: 1_500, feedback: { version: 1, feedbackId: 'f' as never, incidentId: 'incident-1' as never, reportRevision: 4, verdict: 'confirmed', note: 'stale', origin: 'operator-via-agent' } }
    const ctx = {
      aiopsIncidentRouter: {
        workspacePath: '/srv/prod',
        listControlAudit: () => [{ id: 8, source: 'am', deliveryId: 'd', fingerprint: 'fp', alertname: 'HighLatency', severity: 'critical', outcome: 'completed', reason: 'diagnosed', sessionId: 'aiops-session-1', round: 1, cluster: 'prod-sh', queueDepth: 0, reservedTokens: 0, recordedAt: 1_010, attempt: 1 }],
        routingSettings: () => routingSettings,
        listPolicyAudit: () => [],
      },
      aiopsIncidents: {
        listIncidents,
        latestFeedback: vi.fn((sessionId: string) => sessionId === 'aiops-session-2' ? staleFeedback : undefined),
      },
      aiopsAgents: {
        listClusters: () => [{ name: 'prod', status: 'connected', createdAt: 900, lastSeenAt: 980 }],
        configured: () => true,
      },
    }
    const snapshot = readPortalSnapshot(ctx as never, { maxIncidents: 10, maxAuditRecords: 10, maxScanIncidents: 10 })
    expect(listIncidents).toHaveBeenCalledWith('/srv/prod', 10)
    expect(snapshot).toMatchObject({
      version: 4,
      workspace: '/srv/prod',
      generatedAt: 9_999,
      routingSettings,
      routingPolicyAudit: [],
      clusters: [{ name: 'prod', status: 'connected' }],
      needsCluster: false,
    })
    expect(snapshot.incidents).toHaveLength(2)
    expect(snapshot.incidents[0]).toMatchObject({
      sessionId: 'aiops-session-1',
      revision: 3,
      updatedAt: 1_000,
      incident: { title: 'Latest diagnosis' },
      lastRoute: { outcome: 'completed', cluster: 'prod-sh' },
    })
    // Feedback pinned to a superseded revision is dropped rather than shown.
    expect(snapshot.incidents[1]).toMatchObject({ sessionId: 'aiops-session-2' })
    expect(snapshot.incidents[1]?.feedback).toBeUndefined()
    expect(snapshot.summary).toMatchObject({ totalIncidents: 2, active: 2, reviewed: 0 })
  })
})
