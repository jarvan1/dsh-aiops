/** Durable Alertmanager fingerprint routing and diagnostic Session orchestration. */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-aiops-observability'
import {
  LOCALE_PREFERENCE_FIELD,
  LOCALE_SETTINGS_NAMESPACE,
  type LocaleSettings,
} from '@deepseek-ai/dsh-client-locale'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  WebhookDeliveryId,
  WebhookRuleId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
} from '@deepseek-ai/dsh-webhook'
import type { AlertmanagerAlert, AlertmanagerWebhookEvent } from '@deepseek-ai/dsh-webhook-alertmanager'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import {
  IncidentRouteStore,
  type AcceptedRoute,
  type QueuedRoute,
  type RouteAuditOutcome,
  type RouteAuditRecord,
  type RouteControlReason,
} from './store.ts'
import { diagnosisTimeContext } from './diagnosis-window.ts'
import type { AiopsAlertRouteEvent, AlertmanagerGroupContext, DiagnosisWindowPolicy } from './types.ts'

export { diagnosisTimeContext } from './diagnosis-window.ts'
export * from './store.ts'
export type * from './types.ts'

type IncidentSeverity = 'info' | 'warning' | 'critical'
export const ROUTING_SETTINGS_NAMESPACE = 'aiops-routing'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiopsIncidentRouter: AiopsIncidentRouter
  }
}

function appendIgnorableRouteEvent(session: Agent['session'], event: AiopsAlertRouteEvent): void {
  const append = session.append as unknown as (
    type: 'aiops/alert-routed',
    data: AiopsAlertRouteEvent,
    options?: { ignorable: true },
  ) => unknown
  append.call(session, 'aiops/alert-routed', event, { ignorable: true })
}

async function hasPersistedSession(
  persistence: Context['sessionPersistence'],
  sessionId: AcceptedRoute['sessionId'],
  signal: AbortSignal,
): Promise<boolean> {
  const compatible = persistence as typeof persistence & {
    stat?: (id: AcceptedRoute['sessionId'], options?: { signal?: AbortSignal }) => Promise<unknown | undefined>
  }
  if (compatible.stat !== undefined) return await compatible.stat(sessionId, { signal }) !== undefined
  return (await persistence.listSnapshots(signal)).some(snapshot => snapshot.header.id === sessionId)
}

/** Router policy and Session composition. */
export interface Config {
  readonly source: string
  readonly ruleId: string
  readonly statePath: string
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
  /** Deprecated pre-F.2 field. Accepted only so old profiles can start and migrate to routingPolicy. */
  readonly alertnameAllowlist?: string[]
  readonly routingPolicy: {
    readonly ignoredAlertnames: string[]
    readonly defaultSeverity: IncidentSeverity
  }
  readonly severityMap: Record<string, IncidentSeverity>
  readonly modelBudgets: {
    readonly info: number
    readonly warning: number
    readonly critical: number
  }
  readonly stormControl: {
    readonly cooldownSeconds: number
    readonly maxQueueSize: number
    readonly maxQueueAgeSeconds: number
    readonly maxDispatchAttempts: number
    readonly retryBackoffSeconds: number
    readonly globalConcurrency: number
    readonly severityConcurrency: {
      readonly info: number
      readonly warning: number
      readonly critical: number
    }
    readonly globalReservedTokens: number
    readonly severityReservedTokens: {
      readonly info: number
      readonly warning: number
      readonly critical: number
    }
  }
  readonly diagnosisWindow: DiagnosisWindowPolicy
}

/** Versioned live policy persisted through the DSH Settings service. */
export interface RoutingSettings {
  readonly version: 1
  readonly routingPolicy: Config['routingPolicy']
  readonly severityMap: Config['severityMap']
  readonly modelBudgets: Config['modelBudgets']
  readonly stormControl: Config['stormControl']
}

export interface RoutingPolicyEvaluation {
  readonly version: 1
  readonly accepted: boolean
  readonly alertname: string
  readonly sourceSeverity?: string
  readonly severity?: IncidentSeverity
  readonly reason: 'accepted' | 'alertname-ignored'
}

const budget = z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
const nonNegativeInteger = z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
const defaultRoutingPolicy: Config['routingPolicy'] = {
  ignoredAlertnames: ['Watchdog', 'InfoInhibitor'],
  defaultSeverity: 'warning',
}
const routingPolicySchema = z.object({
  ignoredAlertnames: z.array(z.string()).required(),
  defaultSeverity: z.union(['info', 'warning', 'critical'] as const).required(),
})
const severityMapSchema = z.dict(z.union(['info', 'warning', 'critical'] as const))
const modelBudgetsSchema = z.object({
  info: budget.required(),
  warning: budget.required(),
  critical: budget.required(),
})
const stormControlSchema = z.object({
  cooldownSeconds: nonNegativeInteger.required(),
  maxQueueSize: budget.required(),
  maxQueueAgeSeconds: budget.required(),
  maxDispatchAttempts: budget.required(),
  retryBackoffSeconds: budget.required(),
  globalConcurrency: budget.required(),
  severityConcurrency: z.object({
    info: budget.required(),
    warning: budget.required(),
    critical: budget.required(),
  }).required(),
  globalReservedTokens: budget.required(),
  severityReservedTokens: z.object({
    info: budget.required(),
    warning: budget.required(),
    critical: budget.required(),
  }).required(),
})

export const RoutingSettingsConfig: z<RoutingSettings> = z.object({
  version: z.const(1).required(),
  routingPolicy: routingPolicySchema.required(),
  severityMap: severityMapSchema.required(),
  modelBudgets: modelBudgetsSchema.required(),
  stormControl: stormControlSchema.required(),
})

export const Config: z<Config> = z.object({
  source: z.string().required(),
  ruleId: z.string().default('aiops-alertmanager-router'),
  statePath: z.string().required(),
  workspacePath: z.string().required(),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('read-only'),
  // Schemastery resolves a missing array field to `[]`; accepting that value is
  // required for clean installs while still preserving old non-empty profiles.
  alertnameAllowlist: z.array(z.string()),
  routingPolicy: routingPolicySchema.default(defaultRoutingPolicy),
  severityMap: severityMapSchema.required(),
  modelBudgets: modelBudgetsSchema.required(),
  stormControl: stormControlSchema.required(),
  diagnosisWindow: z.object({
    beforeSeconds: budget.required(),
    afterSeconds: budget.required(),
    prometheusStepSeconds: budget.required(),
    logTailLines: budget.required(),
  }).required(),
})

/** Validate values whose relation is not expressed by Schemastery. */
export function assertRoutingSettings(config: RoutingSettings): void {
  if (config.version !== 1) throw new Error('incident-router routing settings version must be 1')
  const alertnames = new Set<string>()
  for (const alertname of config.routingPolicy.ignoredAlertnames) {
    if (alertname === '' || alertname.trim() !== alertname || alertnames.has(alertname)) {
      throw new Error('incident-router routingPolicy.ignoredAlertnames must contain unique non-empty trimmed strings')
    }
    alertnames.add(alertname)
  }
  const severityLabels = new Set<string>()
  for (const severity of Object.keys(config.severityMap)) {
    if (severity === '' || severity.trim() !== severity) {
      throw new Error('incident-router severityMap keys must be non-empty trimmed strings')
    }
    const normalized = severity.toLowerCase()
    if (severityLabels.has(normalized)) {
      throw new Error('incident-router severityMap keys must be unique when compared case-insensitively')
    }
    severityLabels.add(normalized)
  }
  for (const severity of ['info', 'warning', 'critical'] as const) {
    if (config.stormControl.severityConcurrency[severity] > config.stormControl.globalConcurrency) {
      throw new Error(`incident-router ${severity} concurrency must not exceed globalConcurrency`)
    }
    if (config.modelBudgets[severity] > config.stormControl.severityReservedTokens[severity]) {
      throw new Error(`incident-router ${severity} model budget exceeds its reserved-token budget`)
    }
    if (config.modelBudgets[severity] > config.stormControl.globalReservedTokens) {
      throw new Error(`incident-router ${severity} model budget exceeds the global reserved-token budget`)
    }
  }
}

function settingsFrom(config: Config): RoutingSettings {
  return structuredClone({
    version: 1 as const,
    routingPolicy: config.routingPolicy,
    severityMap: config.severityMap,
    modelBudgets: config.modelBudgets,
    stormControl: config.stormControl,
  })
}

export function evaluateRoutingPolicy(
  labels: Readonly<Record<string, string>>,
  settings: RoutingSettings,
): RoutingPolicyEvaluation {
  assertRoutingSettings(settings)
  const alertname = labels['alertname'] ?? ''
  const sourceSeverity = labels['severity']?.trim().toLowerCase()
  if (settings.routingPolicy.ignoredAlertnames.includes(alertname)) {
    return { version: 1, accepted: false, alertname, ...(sourceSeverity === undefined ? {} : { sourceSeverity }), reason: 'alertname-ignored' }
  }
  const severityByLabel = new Map(Object.entries(settings.severityMap).map(([label, severity]) => [label.toLowerCase(), severity]))
  return {
    version: 1,
    accepted: true,
    alertname,
    ...(sourceSeverity === undefined ? {} : { sourceSeverity }),
    severity: severityByLabel.get(sourceSeverity ?? '') ?? settings.routingPolicy.defaultSeverity,
    reason: 'accepted',
  }
}

/** Validate values whose relation is not expressed by Schemastery. */
function assertConfig(config: Config): void {
  for (const [field, value] of [
    ['source', config.source],
    ['ruleId', config.ruleId],
    ['agentPreset', config.agentPreset],
    ['permissionPreset', config.permissionPreset],
  ] as const) {
    if (value === '' || value.trim() !== value) {
      throw new Error(`incident-router ${field} must be a non-empty trimmed string`)
    }
  }
  if (config.statePath !== ':memory:' && !isAbsolute(config.statePath)) {
    throw new Error('incident-router statePath must be absolute or :memory:')
  }
  if (!isAbsolute(config.workspacePath)) {
    throw new Error('incident-router workspacePath must be absolute')
  }
  assertRoutingSettings(settingsFrom(config))
}

/** Convert a delivery to the group facts copied into each accepted Session event. */
function groupContext(event: AlertmanagerWebhookEvent): AlertmanagerGroupContext {
  return {
    status: event.status,
    receiver: event.receiver,
    groupKey: event.groupKey,
    truncatedAlerts: event.truncatedAlerts,
    groupLabels: event.groupLabels,
    commonLabels: event.commonLabels,
    commonAnnotations: event.commonAnnotations,
    ...(event.externalUrl === undefined ? {} : { externalUrl: event.externalUrl }),
  }
}

/** Exact delivery identity already recorded in one Session. */
function hasRouteEvent(agent: Agent, source: string, deliveryId: string, fingerprint: string): boolean {
  return agent.session.ownEvents().some(event => event.type === 'aiops/alert-routed'
    && event.data.source === source
    && event.data.deliveryId === deliveryId
    && event.data.fingerprint === fingerprint)
}

/** Read the durable DSH locale preference; English is DSH's Host-side fallback. */
function outputLocale(ctx: Context): string {
  const section = ctx.get('settings')?.get(LOCALE_SETTINGS_NAMESPACE) as LocaleSettings | undefined
  const preference = section?.[LOCALE_PREFERENCE_FIELD]
  return typeof preference === 'string' && preference !== '' ? preference : 'en'
}

/** Keep model narrative and persisted report text aligned with the DSH locale. */
function languageInstruction(locale: string): string {
  const language = locale === 'zh'
    ? 'Simplified Chinese (zh)'
    : locale === 'en'
      ? 'English (en)'
      : `the language identified by BCP 47 locale ${JSON.stringify(locale)}`
  return `Write all user-facing narrative and persisted incident-report text in ${language}, following the current DSH language preference. Preserve identifiers, labels, commands, field names, and observed evidence values verbatim.`
}

/** Build concise, machine-readable first-turn context. */
function promptFor(event: AiopsAlertRouteEvent, locale: string): string {
  const lifecycle = event.alert.status === 'resolved'
    ? 'Alertmanager reports expression recovery. Do not equate this automatically with incident closure.'
    : 'Investigate this firing alert with read-only evidence collection.'
  return [
    `AIOps Alertmanager route ${event.decision}, round ${String(event.round)}.`,
    lifecycle,
    languageInstruction(locale),
    'Load and follow the aiops-diag skill. Select Alertmanager, Prometheus, and Kubernetes evidence sources from the supplied labels and available context; Kubernetes is optional, not assumed. Use only read-only observation tools. Treat diagnosis as the authoritative alert-time anchor and tool parameter set; do not replace it with a relative "now" window.',
    'Separate facts from hypotheses and persist the complete current report with aiops_incident_report.',
    'Normalized routed alert:',
    JSON.stringify(event, null, 2),
  ].join('\n\n')
}

/** One grouped turn preserves every normalized event while avoiding repeated model work. */
function promptForGroup(events: readonly AiopsAlertRouteEvent[], locale: string): string {
  if (events.length === 1 && events[0] !== undefined) return promptFor(events[0], locale)
  const latest = events.at(-1)
  if (latest === undefined) throw new Error('incident router cannot prompt an empty route group')
  return [
    `AIOps grouped ${String(events.length)} Alertmanager deliveries for ${latest.fingerprint}, round ${String(latest.round)}.`,
    latest.alert.status === 'resolved'
      ? 'Alertmanager reports expression recovery. Do not equate this automatically with incident closure.'
      : 'Investigate the grouped firing alerts with one read-only evidence pass.',
    languageInstruction(locale),
    'Load and follow the aiops-diag skill. Select Alertmanager, Prometheus, and Kubernetes evidence sources from the supplied labels and available context; Kubernetes is optional, not assumed. Use the newest diagnosis window below and account for every grouped delivery id. Separate facts from hypotheses and persist one complete current report with aiops_incident_report.',
    'Normalized routed alerts, oldest first:',
    JSON.stringify(events, null, 2),
  ].join('\n\n')
}

const severityRank = { info: 1, warning: 2, critical: 3 } as const

function highestSeverity(work: readonly QueuedRoute[]): 'info' | 'warning' | 'critical' {
  let result: 'info' | 'warning' | 'critical' = 'info'
  for (const item of work) if (severityRank[item.severity] > severityRank[result]) result = item.severity
  return result
}

/** Router service registered as one trusted Alertmanager webhook rule. */
export class AiopsIncidentRouter extends Service {
  static inject = [
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'aiopsTelemetry',
    'permissionPresets',
    'sessionPersistence',
    'sessions',
    'sessionTitle',
    'settings',
    'webhookRuntime',
    'workspaceRegistry',
  ]
  static Config = Config

  private readonly store: IncidentRouteStore
  private policy: RoutingSettings
  private readonly policyScope: SettingsScope<RoutingSettings>
  private readonly opening = new Map<string, Promise<Agent>>()
  private readonly active = new Map<string, { severity: 'info' | 'warning' | 'critical'; tokens: number }>()
  private readonly lifecycle = new AbortController()
  private drainPromise: Promise<void> | undefined
  private drainRequested = false
  private wakeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'aiopsIncidentRouter')
    assertConfig(config)
    this.store = new IncidentRouteStore(config.statePath)
    if ((config.alertnameAllowlist?.length ?? 0) > 0) {
      ctx.logger.warn('incident-router: alertnameAllowlist is deprecated and no longer filters alerts; migrate to routingPolicy.ignoredAlertnames')
    }
    const basePolicy = settingsFrom(config)
    this.policyScope = ctx.settings.register(ROUTING_SETTINGS_NAMESPACE, RoutingSettingsConfig, {
      base: basePolicy,
      applies: 'live',
      validate: assertRoutingSettings,
    })
    this.policy = this.policyScope.get()
    this.applyPolicy(this.policy)
    ctx.effect(() => this.policyScope.watch((next, previous) => {
      this.store.recordPolicyChange(previous, next, Date.now())
      this.applyPolicy(next)
      void this.drainPending().catch(error => this.ctx.logger.warn(error))
    }), 'aiopsIncidentRouter.routingPolicy()')
    const disposeRule = ctx.webhookRuntime.register({
      id: WebhookRuleId(config.ruleId),
      kind: 'alertmanager',
      run: async (delivery, signal) => {
        if (delivery.source !== config.source) return null
        await this.handleDelivery(delivery, signal)
        return null
      },
    })
    ctx.effect(() => async () => {
      this.lifecycle.abort()
      this.ctx.aiopsTelemetry.markComponent('router', false)
      if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
      await disposeRule()
      await this.drainPromise?.catch(() => {})
      this.store.close()
    }, 'aiopsIncidentRouter.lifecycle()')
    this.ctx.aiopsTelemetry.markComponent('router', true)
    this.updateTelemetry()
    queueMicrotask(() => { void this.drainPending().catch(error => this.ctx.logger.warn(error)) })
  }

  /** The one workspace whose routing audit this configured service owns. */
  get workspacePath(): string {
    return this.config.workspacePath
  }

  /** Bounded persisted storm-control history for workspace history tools. */
  listControlAudit(input: { limit: number; outcome?: RouteAuditOutcome; query?: string }): RouteAuditRecord[] {
    return this.store.listAudit(input)
  }

  /** Current versioned live policy, detached for Portal display and dry-run editing. */
  routingSettings(): RoutingSettings {
    return structuredClone(this.policy)
  }

  /** Bounded durable history of committed live policy changes. */
  listPolicyAudit(input: { limit: number }): import('./store.ts').RoutingPolicyAuditRecord[] {
    return this.store.listPolicyAudit(input)
  }

  /** Evaluate normalized labels without enqueueing, dispatching, or changing state. */
  dryRun(labels: Readonly<Record<string, string>>, settings: RoutingSettings = this.policy): RoutingPolicyEvaluation {
    return evaluateRoutingPolicy(labels, settings)
  }

  /** Route every normalized alert in one authenticated delivery. */
  async handleDelivery(
    delivery: Readonly<VerifiedWebhookDelivery<'alertmanager'>>,
    signal: AbortSignal,
  ): Promise<void> {
    this.store.admitDelivery({
      source: delivery.source,
      deliveryId: delivery.deliveryId,
      payloadDigest: delivery.event.payloadDigest,
      receivedAt: delivery.receivedAt,
    })
    for (const alert of delivery.event.alerts) {
      signal.throwIfAborted()
      const prior = this.store.priorDelivery({
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        fingerprint: alert.fingerprint,
        payloadDigest: delivery.event.payloadDigest,
      })
      if (prior?.kind === 'filtered' || prior?.kind === 'queued' || prior?.kind === 'dropped') continue
      if (prior?.kind === 'accepted') {
        await this.deliverToSession(delivery, alert, prior.route, signal)
        continue
      }
      const evaluation = evaluateRoutingPolicy(alert.labels, this.policy)
      if (!evaluation.accepted) {
        this.store.recordFiltered({
          source: delivery.source,
          deliveryId: delivery.deliveryId,
          payloadDigest: delivery.event.payloadDigest,
          alert,
          reason: 'alertname-ignored',
          receivedAt: delivery.receivedAt,
        })
        continue
      }
      const severity = evaluation.severity!
      const now = Date.now()
      const key = this.fingerprintKey(delivery.source, alert.fingerprint)
      const lastDispatch = this.store.lastDispatchAt(delivery.source, alert.fingerprint)
      const cooldownUntil = lastDispatch === undefined
        ? now
        : lastDispatch + this.policy.stormControl.cooldownSeconds * 1_000
      const capacityReason = this.capacityReason(severity)
      const reason: RouteControlReason = this.active.has(key)
        || this.store.hasPendingFingerprint(delivery.source, alert.fingerprint)
        ? 'fingerprint-grouped'
        : cooldownUntil > now
          ? 'cooldown'
          : capacityReason ?? 'ready'
      const queued = this.store.enqueue({
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        payloadDigest: delivery.event.payloadDigest,
        receivedAt: delivery.receivedAt,
        event: delivery.event,
        alert,
        severity,
        reason,
        availableAt: Math.max(now, cooldownUntil),
        maxQueueSize: this.policy.stormControl.maxQueueSize,
        now,
      })
      if (queued === 'dropped') this.ctx.aiopsTelemetry.recordWork('dropped')
      else if (queued === 'queued' && reason === 'fingerprint-grouped') this.ctx.aiopsTelemetry.recordWork('grouped')
      else if (queued === 'queued' && reason !== 'ready') this.ctx.aiopsTelemetry.recordWork('deferred')
    }
    this.updateTelemetry()
    await this.drainPending(signal)
  }

  /** Drain every currently admissible group without waiting for model turns to finish. */
  async drainPending(signal: AbortSignal = this.lifecycle.signal): Promise<void> {
    if (this.drainPromise !== undefined) {
      this.drainRequested = true
      return await this.drainPromise
    }
    const running = (async () => {
      do {
        this.drainRequested = false
        await this.runDrain(signal)
      } while (this.drainRequested && !signal.aborted)
    })().finally(() => {
      if (this.drainPromise === running) this.drainPromise = undefined
    })
    this.drainPromise = running
    return await running
  }

  private async runDrain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const now = Date.now()
    const expired = this.store.dropExpired(now, this.policy.stormControl.maxQueueAgeSeconds * 1_000)
    if (expired > 0) this.ctx.aiopsTelemetry.recordWork('dropped', expired)
    const starts: Promise<void>[] = []
    for (const group of this.store.readyGroups(now)) {
      signal.throwIfAborted()
      const key = this.fingerprintKey(group.source, group.fingerprint)
      if (this.active.has(key)) continue
      const capacityReason = this.capacityReason(group.severity)
      if (capacityReason !== undefined) {
        const deferred = this.store.deferGroup(
          group.source,
          group.fingerprint,
          capacityReason,
          now,
          [...this.active.values()].reduce((total, item) => total + item.tokens, 0),
        )
        if (deferred > 0) this.ctx.aiopsTelemetry.recordWork('deferred', deferred)
        continue
      }
      const work = this.store.claimGroup(group.source, group.fingerprint, now)
      if (work.length === 0) continue
      const severity = highestSeverity(work)
      const reservation = { severity, tokens: this.policy.modelBudgets[severity] }
      this.active.set(key, reservation)
      this.updateTelemetry(now)
      starts.push(this.dispatchGroup(key, work, reservation, signal))
    }
    await Promise.all(starts)
    this.updateTelemetry()
    this.scheduleWake()
  }

  private async dispatchGroup(
    key: string,
    work: QueuedRoute[],
    reservation: { severity: 'info' | 'warning' | 'critical'; tokens: number },
    signal: AbortSignal,
  ): Promise<void> {
    let agent: Agent | undefined
    let diagnosisStartedAt: number | undefined
    try {
      const routed = work.map(item => ({
        item,
        route: this.store.route({
          source: item.source,
          deliveryId: item.deliveryId,
          payloadDigest: item.payloadDigest,
          alert: item.alert,
          severity: item.severity,
          receivedAt: item.receivedAt,
        }),
      }))
      const first = routed[0]
      if (first === undefined) throw new Error('incident router claimed an empty group')
      if (routed.some(item => item.route.sessionId !== first.route.sessionId)) {
        throw new Error('incident router grouped alerts across Session rounds')
      }
      agent = await this.ensureAgent(first.route, first.item.alert, signal)
      const events: AiopsAlertRouteEvent[] = []
      const startedAt = Date.now()
      diagnosisStartedAt = startedAt
      const cooldownUntil = startedAt + this.policy.stormControl.cooldownSeconds * 1_000
      for (const item of routed) {
        this.store.markStarted(item.item, item.route, startedAt, cooldownUntil, reservation.tokens)
        const event = this.routeEvent(item.item, item.route)
        if (!hasRouteEvent(agent, item.item.source, item.item.deliveryId, item.item.alert.fingerprint)) {
          appendIgnorableRouteEvent(agent.session, event)
        }
        events.push(event)
      }
      if (!await this.ctx.sessions.flush(agent.session)) {
        throw new Error(`incident router could not flush Session ${first.route.sessionId}`)
      }
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: promptForGroup(events, outputLocale(this.ctx)) }],
        source: {
          kind: 'webhook',
          provider: 'alertmanager',
          source: WebhookSourceId(first.item.source),
          deliveryId: WebhookDeliveryId(first.item.deliveryId),
          ruleId: WebhookRuleId(this.config.ruleId),
          form: 'notice',
          summary: events.length === 1
            ? `Alertmanager ${first.item.alert.status}: ${first.item.alert.labels['alertname'] ?? first.item.alert.fingerprint}`
            : `Alertmanager grouped ${String(events.length)} alerts: ${first.item.alert.labels['alertname'] ?? first.item.alert.fingerprint}`,
        },
      }))
      if (!await this.ctx.sessions.flush(agent.session)) {
        throw new Error(`incident router could not flush Session inbox ${first.route.sessionId}`)
      }
      const completedAt = Date.now()
      for (const item of routed) this.store.markCompleted(item.item, item.route, completedAt, reservation.tokens)
    } catch (error: unknown) {
      this.ctx.aiopsTelemetry.recordDispatchFailure()
      const now = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      for (const item of work) {
        this.store.retryOrDrop(
          item,
          now,
          now + this.policy.stormControl.retryBackoffSeconds * 1_000,
          this.policy.stormControl.maxDispatchAttempts,
          message,
        )
      }
      this.ctx.aiopsTelemetry.recordWork(
        work.every(item => item.attempt >= this.policy.stormControl.maxDispatchAttempts) ? 'dropped' : 'deferred',
        work.length,
      )
      this.release(key)
      this.scheduleWake()
      throw error
    }
    const settled = agent?.whenIdle() ?? Promise.resolve()
    void settled.finally(() => {
      if (diagnosisStartedAt !== undefined) {
        this.ctx.aiopsTelemetry.observeDiagnosticLatency((Date.now() - diagnosisStartedAt) / 1_000)
      }
      this.release(key)
      void this.drainPending().catch(error => this.ctx.logger.warn(error))
    })
  }

  private routeEvent(work: QueuedRoute, route: AcceptedRoute): AiopsAlertRouteEvent {
    return {
      version: 2,
      source: work.source,
      deliveryId: work.deliveryId,
      payloadDigest: work.payloadDigest,
      receivedAt: work.receivedAt,
      fingerprint: work.alert.fingerprint,
      round: route.round,
      sessionId: route.sessionId,
      decision: route.decision,
      severity: route.severity,
      diagnosis: diagnosisTimeContext(work.alert, work.receivedAt, this.config.diagnosisWindow),
      group: groupContext(work.event),
      alert: work.alert,
    }
  }

  private fingerprintKey(source: string, fingerprint: string): string {
    return JSON.stringify([source, fingerprint])
  }

  private capacityReason(severity: 'info' | 'warning' | 'critical'):
  | 'global-concurrency'
  | 'severity-concurrency'
  | 'global-token-budget'
  | 'severity-token-budget'
  | undefined {
    const reservations = [...this.active.values()]
    if (reservations.length >= this.policy.stormControl.globalConcurrency) return 'global-concurrency'
    const same = reservations.filter(item => item.severity === severity)
    if (same.length >= this.policy.stormControl.severityConcurrency[severity]) return 'severity-concurrency'
    const globalTokens = reservations.reduce((total, item) => total + item.tokens, 0)
    if (globalTokens + this.policy.modelBudgets[severity] > this.policy.stormControl.globalReservedTokens) {
      return 'global-token-budget'
    }
    const severityTokens = same.reduce((total, item) => total + item.tokens, 0)
    if (severityTokens + this.policy.modelBudgets[severity]
      > this.policy.stormControl.severityReservedTokens[severity]) return 'severity-token-budget'
    return undefined
  }

  private release(key: string): void {
    this.active.delete(key)
    this.updateTelemetry()
  }

  private applyPolicy(next: RoutingSettings): void {
    assertRoutingSettings(next)
    this.policy = structuredClone(next)
  }

  private updateTelemetry(now = Date.now()): void {
    const queue = this.store.queueStats(now)
    this.ctx.aiopsTelemetry.setRouterGauges({
      ...queue,
      activeDiagnoses: this.active.size,
      reservedTokens: [...this.active.values()].reduce((total, item) => total + item.tokens, 0),
    })
  }

  private scheduleWake(): void {
    if (this.lifecycle.signal.aborted) return
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    const next = this.store.nextAvailableAt()
    if (next === undefined) {
      this.wakeTimer = undefined
      return
    }
    if (next <= Date.now()) {
      this.wakeTimer = undefined
      return
    }
    const delay = Math.max(0, Math.min(next - Date.now(), 2_147_483_647))
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      void this.drainPending().catch(error => this.ctx.logger.warn(error))
    }, delay)
    this.wakeTimer.unref?.()
  }

  /** Ensure the deterministic Session exists, then append one idempotent decision and prompt. */
  private async deliverToSession(
    delivery: Readonly<VerifiedWebhookDelivery<'alertmanager'>>,
    alert: AlertmanagerAlert,
    route: AcceptedRoute,
    signal: AbortSignal,
  ): Promise<void> {
    const agent = await this.ensureAgent(route, alert, signal)
    signal.throwIfAborted()
    if (hasRouteEvent(agent, delivery.source, delivery.deliveryId, alert.fingerprint)) return
    const event: AiopsAlertRouteEvent = {
      version: 2,
      source: delivery.source,
      deliveryId: delivery.deliveryId,
      payloadDigest: delivery.event.payloadDigest,
      receivedAt: delivery.receivedAt,
      fingerprint: alert.fingerprint,
      round: route.round,
      sessionId: route.sessionId,
      decision: route.decision,
      severity: route.severity,
      diagnosis: diagnosisTimeContext(alert, delivery.receivedAt, this.config.diagnosisWindow),
      group: groupContext(delivery.event),
      alert,
    }
    appendIgnorableRouteEvent(agent.session, event)
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error(`incident router could not flush Session ${route.sessionId}`)
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: promptFor(event, outputLocale(this.ctx)) }],
      source: {
        kind: 'webhook',
        provider: 'alertmanager',
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        ruleId: WebhookRuleId(this.config.ruleId),
        form: 'notice',
        summary: `Alertmanager ${alert.status}: ${alert.labels['alertname'] ?? alert.fingerprint}`,
      },
    }))
    if (!await this.ctx.sessions.flush(agent.session)) {
      throw new Error(`incident router could not flush Session inbox ${route.sessionId}`)
    }
  }

  /** Coalesce concurrent opens for one deterministic Session identity. */
  private ensureAgent(route: AcceptedRoute, alert: AlertmanagerAlert, signal: AbortSignal): Promise<Agent> {
    const live = this.ctx.agents.get(route.sessionId)
    if (live !== undefined) return Promise.resolve(live)
    const existing = this.opening.get(route.sessionId)
    if (existing !== undefined) return existing
    const opening = this.openAgent(route, alert, signal).finally(() => {
      this.opening.delete(route.sessionId)
    })
    this.opening.set(route.sessionId, opening)
    return opening
  }

  /** Create a fresh diagnostic Agent or resume its persisted Session after restart. */
  private async openAgent(route: AcceptedRoute, alert: AlertmanagerAlert, signal: AbortSignal): Promise<Agent> {
    this.ctx.permissionPresets.resolve(this.config.permissionPreset)
    const preset = await this.ctx.agentPresets.resolve(this.config.agentPreset)
    await this.ctx.agentPresets.standingKeyFor(preset.id)
    const workspace = await this.ctx.workspaceRegistry.create(this.config.workspacePath)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = {
      ...selection,
      maxTokens: this.policy.modelBudgets[route.severity],
    }
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, preset.id)
    }
    signal.throwIfAborted()
    const persisted = await hasPersistedSession(this.ctx.sessionPersistence, route.sessionId, signal)
    let handle: AgentHandle | undefined
    let created = false
    let attached = false
    try {
      if (!persisted) {
        handle = await this.ctx.agents.create({
          sessionId: route.sessionId,
          signal,
          meta: { cwd: workspace.path, agentPreset: preset.id },
          agentOptions,
          setup,
        })
        created = true
        this.ctx.sessionTitle.rename(
          handle.agent.session,
          `AIOps: ${alert.labels['alertname'] ?? alert.fingerprint} #${String(route.round)}`,
        )
      } else {
        handle = await this.ctx.agents.resume({
          resumeSessionId: route.sessionId,
          signal,
          agentOptions,
          setup,
        })
        if (handle.agent.session.header.cwd !== workspace.path) {
          throw new Error(`incident router Session ${route.sessionId} belongs to another workspace`)
        }
      }
      await workspace.attachSession(route.sessionId)
      attached = true
      this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset)
      return handle.agent
    } catch (error: unknown) {
      if (created && attached) await workspace.detachSession(route.sessionId).catch(() => {})
      if (handle !== undefined) await handle.dispose().catch(() => {})
      throw error
    }
  }
}

export default AiopsIncidentRouter
