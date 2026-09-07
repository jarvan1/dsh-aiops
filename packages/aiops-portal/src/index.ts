/** Read-only Web portal over durable AIOps Session events and routing audit. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-aiops-incident-router'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import z from '@deepseek-ai/schemastery'
import { testEndpointConnection } from './connectivity.ts'
import {
  PORTAL_API_PATH,
  PORTAL_CONNECTION_TEST_API_PATH,
  type ConnectionTarget,
} from './types.ts'
import { readPortalSnapshot, type PortalLimits } from './snapshot.ts'

export * from './connectivity.ts'
export * from './snapshot.ts'
export * from './types.ts'

export const name = 'aiops-portal'
export const inject = ['sessionQuery', 'aiopsIncidentRouter']

export interface Config {
  readonly maxIncidents?: number
  readonly maxAuditRecords?: number
  readonly maxScanSessions?: number
}

export const Config: z<Config> = z.object({
  maxIncidents: z.number().step(1).min(1).max(500).default(100),
  maxAuditRecords: z.number().step(1).min(1).max(1000).default(250),
  maxScanSessions: z.number().step(1).min(1).max(5000).default(500),
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

async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('unsupported_media_type')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 4096)) {
    throw new Error('request_too_large')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
    bytes += chunk.byteLength
    if (bytes > 4096) {
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

function connectionRequest(value: unknown): { target: ConnectionTarget; baseUrl: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const target = Reflect.get(value, 'target')
  const baseUrl = Reflect.get(value, 'baseUrl')
  if ((target !== 'prometheus' && target !== 'alertmanager') || typeof baseUrl !== 'string') return undefined
  return { target, baseUrl }
}

/** Register the same-origin snapshot endpoint consumed by the browser client module. */
export function apply(ctx: Context, config: Config): void {
  const limits = limitsOf(config)
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
        const controller = new AbortController()
        const abort = () => controller.abort()
        req.once('aborted', abort)
        try {
          const value = connectionRequest(await readJsonBody(req))
          if (value === undefined) {
            json(res, 400, { error: 'invalid_request' }, false)
            return
          }
          json(res, 200, await testEndpointConnection(
            value.target,
            value.baseUrl,
            controller.signal,
          ), false)
        } catch (error: unknown) {
          const code = error instanceof Error ? error.message : 'invalid_request'
          const status = code === 'unsupported_media_type' ? 415 : code === 'request_too_large' ? 413 : 400
          json(res, status, { error: code }, false)
        } finally {
          req.off('aborted', abort)
        }
      },
    }), `aiops-portal: ${PORTAL_CONNECTION_TEST_API_PATH}`)
  })
}
