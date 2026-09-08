/** Read-only Web portal over durable AIOps Session events and routing audit. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-aiops-incident-router'
import { KubernetesQueryError } from '@deepseek-ai/dsh-aiops-kubernetes'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import z from '@deepseek-ai/schemastery'
import { testEndpointConnection } from './connectivity.ts'
import {
  PORTAL_API_PATH,
  PORTAL_CONNECTION_TEST_API_PATH,
  PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH,
  PORTAL_WEBHOOK_CONFIGURATION_API_PATH,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type RoutingPolicyDryRunRequest,
} from './types.ts'
import { readPortalSnapshot, type PortalLimits } from './snapshot.ts'

export * from './connectivity.ts'
export * from './snapshot.ts'
export * from './types.ts'

export const name = 'aiops-portal'
export const inject = ['sessionQuery', 'aiopsIncidentRouter', 'kubernetes', 'credentials']

export interface Config {
  readonly maxIncidents?: number
  readonly maxAuditRecords?: number
  readonly maxScanSessions?: number
  readonly webhookUrl?: string
  readonly webhookSecretRef?: string
}

export const Config: z<Config> = z.object({
  maxIncidents: z.number().step(1).min(1).max(500).default(100),
  maxAuditRecords: z.number().step(1).min(1).max(1000).default(250),
  maxScanSessions: z.number().step(1).min(1).max(5000).default(500),
  webhookUrl: z.string().default('http://127.0.0.1:3081/alertmanager'),
  webhookSecretRef: z.string().role('credential-ref').default('AIOPS_ALERTMANAGER_WEBHOOK_SECRET'),
})

function limitsOf(config: Config): PortalLimits {
  return {
    maxIncidents: config.maxIncidents ?? 100,
    maxAuditRecords: config.maxAuditRecords ?? 250,
    maxScanSessions: config.maxScanSessions ?? 500,
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
  if (target === 'prometheus' || target === 'alertmanager') {
    const baseUrl = Reflect.get(value, 'baseUrl')
    return typeof baseUrl === 'string' ? { target, baseUrl } : undefined
  }
  if (target !== 'kubernetes') return undefined
  const kubeconfig = Reflect.get(value, 'kubeconfig')
  const context = Reflect.get(value, 'context')
  if ((kubeconfig !== undefined && typeof kubeconfig !== 'string') || (context !== undefined && typeof context !== 'string')) return undefined
  return { target, ...(kubeconfig === undefined ? {} : { kubeconfig }), ...(context === undefined ? {} : { context }) }
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

export async function testPortalConnection(ctx: Context, request: ConnectionTestRequest, signal: AbortSignal): Promise<ConnectionTestResult> {
  if (request.target !== 'kubernetes') return testEndpointConnection(request.target, request.baseUrl, signal)
  const started = performance.now()
  try {
    const result = await ctx.kubernetes.testConnection({
      ...(request.kubeconfig === undefined ? {} : { kubeconfig: request.kubeconfig }),
      ...(request.context === undefined ? {} : { context: request.context }),
    }, signal)
    const missingPermissions = Object.entries(result.capabilities).filter(([, allowed]) => !allowed).map(([name]) => name)
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (missingPermissions.length > 0) return { ok: false, code: 'rbac_denied', latencyMs, missingPermissions }
    return { ok: true, latencyMs, kubernetes: { context: result.context, cluster: result.cluster, namespace: result.namespace, server: result.server } }
  } catch (error: unknown) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (!(error instanceof KubernetesQueryError)) return { ok: false, code: 'unreachable', latencyMs }
    const code: import('./types.ts').ConnectionTestFailureCode = error.code === 'invalid_request' ? 'invalid_kubeconfig'
      : error.code === 'authentication_failed' ? 'authentication_failed'
        : error.code === 'forbidden' ? 'forbidden'
          : error.code === 'timeout' ? 'timeout'
            : error.code === 'credential_exec_missing' ? 'credential_exec_missing' : 'unreachable'
    return { ok: false, code, latencyMs }
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
        json(res, 200, await readPortalSnapshot(webCtx, limits, controller.signal), method === 'HEAD')
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
  })
}
