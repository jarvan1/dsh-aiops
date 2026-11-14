/** Read-only Web portal over durable AIOps Session events and routing audit. */
import type { Context } from '@deepseek-ai/cordis'
import { AgentQueryError, AgentRegistryError } from '@deepseek-ai/dsh-aiops-agents'
import type {} from '@deepseek-ai/dsh-aiops-incident-router'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import z from '@deepseek-ai/schemastery'
import { testEndpointConnection } from './connectivity.ts'
import {
  PORTAL_API_PATH,
  PORTAL_CLUSTER_PROBE_API_PATH,
  PORTAL_CLUSTER_RESUME_API_PATH,
  PORTAL_CLUSTER_REVOKE_API_PATH,
  PORTAL_CLUSTER_UPGRADE_API_PATH,
  PORTAL_CLUSTER_TOKEN_API_PATH,
  PORTAL_CLUSTERS_API_PATH,
  PORTAL_CONNECTION_TEST_API_PATH,
  PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH,
  PORTAL_WEBHOOK_CONFIGURATION_API_PATH,
  type ClusterProbeResult,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type RoutingPolicyDryRunRequest,
} from './types.ts'
import { readPortalSnapshot, type PortalLimits } from './snapshot.ts'

export * from './connectivity.ts'
export * from './snapshot.ts'
export * from './types.ts'

export const name = 'aiops-portal'
export const inject = ['aiopsAgents', 'aiopsIncidents', 'aiopsIncidentRouter', 'credentials']

export interface Config {
  readonly maxIncidents?: number
  readonly maxAuditRecords?: number
  readonly maxScanIncidents?: number
  readonly webhookUrl?: string
  readonly webhookSecretRef?: string
}

export const Config: z<Config> = z.object({
  maxIncidents: z.number().step(1).min(1).max(500).default(100),
  maxAuditRecords: z.number().step(1).min(1).max(1000).default(250),
  maxScanIncidents: z.number().step(1).min(1).max(5000).default(500),
  webhookUrl: z.string().default('http://127.0.0.1:3081/alertmanager'),
  webhookSecretRef: z.string().role('credential-ref').default('AIOPS_ALERTMANAGER_WEBHOOK_SECRET'),
})

function limitsOf(config: Config): PortalLimits {
  return {
    maxIncidents: config.maxIncidents ?? 100,
    maxAuditRecords: config.maxAuditRecords ?? 250,
    maxScanIncidents: config.maxScanIncidents ?? 500,
  }
}

function json(res: import('node:http').ServerResponse, status: number, value: unknown, head: boolean): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(head ? undefined : body)
}

/** Reject cross-site browser POSTs before any connection probe or policy evaluation. */
function trustedPost(req: import('node:http').IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers['x-forwarded-host'] ?? req.headers.host
  if (typeof host !== 'string') return false
  try { return new URL(origin).host === host.split(',', 1)[0]?.trim() } catch { return false }
}

async function readJsonBody(req: import('node:http').IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('unsupported_media_type')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error('request_too_large')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      req.resume()
      throw new Error('request_too_large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown
  } catch {
    throw new Error('invalid_json')
  }
}

function connectionRequest(value: unknown): ConnectionTestRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const target = Reflect.get(value, 'target')
  if (target !== 'prometheus' && target !== 'alertmanager') return undefined
  const baseUrl = Reflect.get(value, 'baseUrl')
  return typeof baseUrl === 'string' ? { target, baseUrl } : undefined
}

function routingPolicyDryRunRequest(value: unknown): RoutingPolicyDryRunRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const labels = Reflect.get(value, 'labels')
  const settings = Reflect.get(value, 'settings')
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)
    || typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined
  const entries = Object.entries(labels)
  if (entries.length > 100 || entries.some(([key, item]) => key === '' || key.length > 256 || typeof item !== 'string' || item.length > 4096)) return undefined
  return { labels: Object.fromEntries(entries) as Record<string, string>, settings: settings as RoutingPolicyDryRunRequest['settings'] }
}

export async function testPortalConnection(
  _ctx: Context,
  request: ConnectionTestRequest,
  signal: AbortSignal,
): Promise<ConnectionTestResult> {
  // Cluster connectivity is no longer a data-source credential test: the
  // Clusters view probes a registered agent and reports its own result.
  return testEndpointConnection(request.target, request.baseUrl, signal)
}


/** Read a `{ name, targetVersion }` upgrade body. */
function upgradeRequest(value: unknown): { name: string; targetVersion: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const name = Reflect.get(value, 'name')
  const targetVersion = Reflect.get(value, 'targetVersion')
  return typeof name === 'string' && typeof targetVersion === 'string' ? { name, targetVersion } : undefined
}

/** Read a `{ name }` request body; shape validation stays in the registry. */
function clusterNameFrom(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const name = Reflect.get(value, 'name')
  return typeof name === 'string' ? name : undefined
}

function registryStatus(error: AgentRegistryError): number {
  switch (error.code) {
    case 'invalid_name': return 400
    case 'invalid_version': return 400
    case 'cluster_not_found': return 404
    case 'cluster_exists': return 409
    case 'cluster_limit_reached': return 409
    case 'token_not_reissuable': return 409
  }
}

/** Map a body-read or registry failure onto the portal's error envelope. */
function writeRequestFailure(res: import('node:http').ServerResponse, error: unknown): void {
  if (error instanceof AgentRegistryError) {
    json(res, registryStatus(error), { error: error.code }, false)
    return
  }
  const code = error instanceof Error ? error.message : 'invalid_request'
  const status = code === 'unsupported_media_type' ? 415 : code === 'request_too_large' ? 413 : 400
  json(res, status, { error: code }, false)
}

/** JSON body shared by the cluster mutation routes. */
async function clusterNameBody(req: import('node:http').IncomingMessage): Promise<string | undefined> {
  return clusterNameFrom(await readJsonBody(req))
}


/** Probe one connected agent; HTTP 200 carries the ok/code verdict. */
async function probeCluster(ctx: Context, name: string, signal: AbortSignal): Promise<ClusterProbeResult> {
  const started = performance.now()
  try {
    const agent = await ctx.aiopsAgents.probe(name, signal)
    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)), agent }
  } catch (error: unknown) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (error instanceof AgentQueryError) return { ok: false, code: error.code, latencyMs }
    if (error instanceof AgentRegistryError) return { ok: false, code: 'not_found', latencyMs }
    return { ok: false, code: 'unreachable', latencyMs }
  }
}

/** Register the same-origin snapshot endpoint consumed by the browser client module. */
export function apply(ctx: Context, config: Config): void {
  const limits = limitsOf(config)
  const webhookUrl = config.webhookUrl ?? 'http://127.0.0.1:3081/alertmanager'
  const webhookSecretRef = credentialRef(config.webhookSecretRef ?? 'AIOPS_ALERTMANAGER_WEBHOOK_SECRET')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: PORTAL_API_PATH,
    async handler(req, res) {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD')
        json(res, 405, { error: 'method_not_allowed' }, false)
        return
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      const abortIfUnfinished = () => { if (!res.writableEnded) controller.abort() }
      req.once('aborted', abort)
      res.once('close', abortIfUnfinished)
      try {
        json(res, 200, readPortalSnapshot(webCtx, limits), method === 'HEAD')
      } catch (error) {
        if (!controller.signal.aborted) {
          webCtx.logger.warn(error)
          json(res, 500, { error: 'portal_snapshot_failed' }, method === 'HEAD')
        }
      } finally {
        req.off('aborted', abort)
        res.off('close', abortIfUnfinished)
      }
    },
    }), `aiops-portal: ${PORTAL_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CONNECTION_TEST_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        req.once('aborted', abort)
        try {
          const value = connectionRequest(await readJsonBody(req))
          if (value === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, await testPortalConnection(webCtx, value, controller.signal), false)
        } catch (error: unknown) {
          const code = error instanceof Error ? error.message : 'invalid_request'
          const status = code === 'unsupported_media_type' ? 415 : code === 'request_too_large' ? 413 : 400
          json(res, status, { error: code }, false)
        } finally {
          req.off('aborted', abort)
        }
      },
    }), `aiops-portal: ${PORTAL_CONNECTION_TEST_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_WEBHOOK_CONFIGURATION_API_PATH,
      async handler(req, res) {
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        try {
          const credential = await webCtx.credentials.resolve(webhookSecretRef)
          const secret = credential?.value
          json(res, 200, {
            version: 2,
            url: webhookUrl,
            secretConfigured: secret !== undefined && secret !== '',
          }, method === 'HEAD')
        } catch (error: unknown) {
          webCtx.logger.warn(error)
          json(res, 503, { error: 'credential_status_unavailable' }, method === 'HEAD')
        }
      },
    }), `aiops-portal: ${PORTAL_WEBHOOK_CONFIGURATION_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const value = routingPolicyDryRunRequest(await readJsonBody(req, 65_536))
          if (value === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, webCtx.aiopsIncidentRouter.dryRun(value.labels, value.settings), false)
        } catch (error: unknown) {
          const code = error instanceof Error ? error.message : 'invalid_request'
          const status = code === 'unsupported_media_type' ? 415 : code === 'request_too_large' ? 413 : 400
          json(res, status, { error: code }, false)
        }
      },
    }), `aiops-portal: ${PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTERS_API_PATH,
      async handler(req, res) {
        const method = req.method ?? 'GET'
        if (method === 'GET' || method === 'HEAD') {
          json(res, 200, {
            version: 1,
            clusters: webCtx.aiopsAgents.listClusters(),
            needsCluster: !webCtx.aiopsAgents.configured(),
          }, method === 'HEAD')
          return
        }
        if (method !== 'POST') {
          res.setHeader('allow', 'GET, HEAD, POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const name = await clusterNameBody(req)
          if (name === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          // The plaintext token is returned exactly once, in this response.
          json(res, 201, await webCtx.aiopsAgents.createCluster(name), false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTERS_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTER_TOKEN_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const name = await clusterNameBody(req)
          if (name === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, await webCtx.aiopsAgents.reissueToken(name), false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTER_TOKEN_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTER_REVOKE_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const name = await clusterNameBody(req)
          if (name === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, { cluster: await webCtx.aiopsAgents.revokeCluster(name) }, false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTER_REVOKE_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTER_PROBE_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        const abortIfUnfinished = (): void => { if (!res.writableEnded) controller.abort() }
        req.once('aborted', abort)
        res.once('close', abortIfUnfinished)
        try {
          const name = await clusterNameBody(req)
          if (name === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, await probeCluster(webCtx, name, controller.signal), false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        } finally {
          req.off('aborted', abort)
          res.off('close', abortIfUnfinished)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTER_PROBE_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTER_UPGRADE_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const value = upgradeRequest(await readJsonBody(req))
          if (value === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, { cluster: await webCtx.aiopsAgents.upgradeCluster(value.name, value.targetVersion) }, false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTER_UPGRADE_API_PATH}`)
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: PORTAL_CLUSTER_RESUME_API_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: 'method_not_allowed' }, false)
          return
        }
        if (!trustedPost(req)) {
          json(res, 403, { error: 'cross_site_request_rejected' }, false)
          return
        }
        try {
          const name = await clusterNameBody(req)
          if (name === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, { cluster: await webCtx.aiopsAgents.resumeCluster(name) }, false)
        } catch (error: unknown) {
          writeRequestFailure(res, error)
        }
      },
    }), `aiops-portal: ${PORTAL_CLUSTER_RESUME_API_PATH}`)
  })
}
