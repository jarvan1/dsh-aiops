/** Bearer-authenticated Alertmanager HTTP ingress and webhook dispatch. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
} from '@deepseek-ai/dsh-webhook'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { AlertmanagerWebhookHttpError, readBoundedUtf8Body } from './body.ts'
import { normalizeAlertmanagerWebhook } from './normalize.ts'

/** Values validated once at plugin load. */
export interface AlertmanagerWebhookHandlerConfig {
  readonly source: string
  readonly secretEnv: CredentialRef
  readonly maxBodyBytes: number
  readonly maxAlerts: number
  readonly maxMapEntries: number
  readonly maxTextChars: number
}

/** Require one unambiguous request header. */
function requiredHeader(request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new AlertmanagerWebhookHttpError(400, `missing ${name} header`)
  }
  return value
}

/** Read an optional delivery id with a conservative log-safe grammar. */
function deliveryHeader(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct['x-dsh-delivery-id']
  if (values === undefined) return undefined
  const value = values[0]
  if (values.length !== 1 || value === undefined || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new AlertmanagerWebhookHttpError(400, 'invalid x-dsh-delivery-id header')
  }
  return value
}

/** Whether Content-Type names JSON with at most one UTF-8 charset parameter. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/** Compare the complete Authorization value without content-dependent timing. */
function validBearer(actual: string, secret: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(`Bearer ${secret}`)
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes)
}

/** Send one empty or plain-text response. */
function respond(response: ServerResponse, status: number, message?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Create one authenticated Alertmanager HTTP route handler. */
export function createAlertmanagerWebhookHandler(
  ctx: Context,
  config: AlertmanagerWebhookHandlerConfig,
): WebRoute['handler'] {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new AlertmanagerWebhookHttpError(405, 'method not allowed')
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new AlertmanagerWebhookHttpError(415, 'content type must be application/json')
      }
      const authorization = requiredHeader(request, 'authorization')
      const credential = await ctx.credentials.resolve(config.secretEnv)
      if (credential === undefined || credential.value === '') {
        throw new AlertmanagerWebhookHttpError(503, 'Alertmanager webhook secret is unavailable')
      }
      if (!validBearer(authorization, credential.value)) {
        throw new AlertmanagerWebhookHttpError(401, 'invalid bearer credential')
      }
      const body = await readBoundedUtf8Body(request, config.maxBodyBytes)
      const event = normalizeAlertmanagerWebhook(body, config)
      const suppliedDeliveryId = deliveryHeader(request)
      const deliveryId = suppliedDeliveryId
        ?? `sha256:${createHash('sha256').update(body).digest('hex')}`
      const delivery: VerifiedWebhookDelivery<'alertmanager'> = {
        kind: 'alertmanager',
        source: WebhookSourceId(config.source),
        deliveryId: WebhookDeliveryId(deliveryId),
        event,
        receivedAt: Date.now(),
      }
      try {
        ctx.webhookRuntime.dispatch(delivery)
      } catch {
        ctx.logger.warn('webhook-alertmanager: dispatch unavailable')
        throw new AlertmanagerWebhookHttpError(503, 'webhook runtime is unavailable')
      }
      respond(response, 202)
    } catch (error: unknown) {
      if (error instanceof AlertmanagerWebhookHttpError) {
        respond(response, error.status, error.message)
        return
      }
      ctx.logger.warn('webhook-alertmanager: request failed')
      respond(response, 503, 'webhook ingress is unavailable')
    }
  }
}
