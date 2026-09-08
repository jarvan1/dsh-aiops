/** Authenticated Alertmanager HTTP adapter for the DSH webhook runtime. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-aiops-observability'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { createAlertmanagerWebhookHandler } from './handler.ts'

export type * from './types.ts'
export { normalizeAlertmanagerWebhook } from './normalize.ts'

/** Cordis plugin name. */
export const name = 'webhook-alertmanager'
/** Services required to register and operate the exact route. */
export const inject = ['webServer', 'webhookRuntime', 'credentials', 'aiopsTelemetry']

/** Alertmanager ingress configuration. */
export interface Config {
  readonly source: string
  readonly path: string
  readonly secretEnv: string
  readonly maxBodyBytes: number
  readonly maxAlerts: number
  readonly maxMapEntries: number
  readonly maxTextChars: number
}

export const Config: z<Config> = z.object({
  source: z.string().required(),
  path: z.string().required(),
  secretEnv: z.string().role('credential-ref').required(),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_048_576),
  maxAlerts: z.number().step(1).min(1).max(1000).default(100),
  maxMapEntries: z.number().step(1).min(1).max(1000).default(100),
  maxTextChars: z.number().step(1).min(1).max(100_000).default(10_000),
})

/** Validate route and instance values beyond Schemastery field types. */
function assertConfig(config: Config): void {
  if (config.source.trim() !== config.source || config.source === '') {
    throw new Error('webhook-alertmanager source must be a non-empty trimmed string')
  }
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')
    || config.path.includes('?') || config.path.includes('#')) {
    throw new Error('webhook-alertmanager path must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
}

/** Register one exact Alertmanager endpoint. */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const route = {
    kind: 'exact' as const,
    path: config.path,
    handler: createAlertmanagerWebhookHandler(ctx, {
      source: config.source,
      secretEnv: credentialRef(config.secretEnv),
      maxBodyBytes: config.maxBodyBytes,
      maxAlerts: config.maxAlerts,
      maxMapEntries: config.maxMapEntries,
      maxTextChars: config.maxTextChars,
    }),
  }
  ctx.effect(() => ctx.webServer.register(route), `webhook-alertmanager: ${config.path}`)
  ctx.aiopsTelemetry.markComponent('webhook', true)
  ctx.effect(() => () => { ctx.aiopsTelemetry.markComponent('webhook', false) })
}
