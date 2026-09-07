/** Durable Alertmanager fingerprint routing and diagnostic Session orchestration. */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
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
  readonly alertnameAllowlist: string[]
  readonly severityMap: Record<string, 'info' | 'warning' | 'critical'>
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

const budget = z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
const nonNegativeInteger = z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)

export const Config: z<Config> = z.object({
  source: z.string().required(),
  ruleId: z.string().default('aiops-alertmanager-router'),
  statePath: z.string().required(),
  workspacePath: z.string().required(),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('read-only'),
  alertnameAllowlist: z.array(z.string()).min(1).required(),
  severityMap: z.dict(z.union(['info', 'warning', 'critical'] as const)).required(),
  modelBudgets: z.object({
    info: budget.required(),
    warning: budget.required(),
    critical: budget.required(),
  }).required(),
  stormControl: z.object({
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
  }).required(),
  diagnosisWindow: z.object({
    beforeSeconds: budget.required(),
    afterSeconds: budget.required(),
    prometheusStepSeconds: budget.required(),
    logTailLines: budget.required(),
  }).required(),
})

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
  const alertnames = new Set<string>()
  for (const alertname of config.alertnameAllowlist) {
    if (alertname === '' || alertname.trim() !== alertname || alertnames.has(alertname)) {
      throw new Error('incident-router alertnameAllowlist must contain unique non-empty trimmed strings')
    }
    alertnames.add(alertname)
  }
  for (const severity of Object.keys(config.severityMap)) {
    if (severity === '' || severity.trim() !== severity) {
      throw new Error('incident-router severityMap keys must be non-empty trimmed strings')
    }
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

/** Build concise, machine-readable first-turn context. */
function promptFor(event: AiopsAlertRouteEvent): string {
  const lifecycle = event.alert.status === 'resolved'
    ? 'Alertmanager reports expression recovery. Do not equate this automatically with incident closure.'
    : 'Investigate this firing alert with read-only evidence collection.'
  return [
    `AIOps Alertmanager route ${event.decision}, round ${String(event.round)}.`,
    lifecycle,
    'Load and follow the k8s-diag skill. Use only read-only observation tools. Treat diagnosis as the authoritative alert-time anchor and tool parameter set; do not replace it with a relative "now" window.',
    'Separate facts from hypotheses and persist the complete current report with aiops_incident_report.',
    'Normalized routed alert:',
    JSON.stringify(event, null, 2),
  ].join('\n\n')
}

/** One grouped turn preserves every normalized event while avoiding repeated model work. */
function promptForGroup(events: readonly AiopsAlertRouteEvent[]): string {
  if (events.length === 1 && events[0] !== undefined) return promptFor(events[0])
  const latest = events.at(-1)
  if (latest === undefined) throw new Error('incident router cannot prompt an empty route group')
  return [
    `AIOps grouped ${String(events.length)} Alertmanager deliveries for ${latest.fingerprint}, round ${String(latest.round)}.`,
    latest.alert.status === 'resolved'
      ? 'Alertmanager reports expression recovery. Do not equate this automatically with incident closure.'
      : 'Investigate the grouped firing alerts with one read-only evidence pass.',
    'Load and follow the k8s-diag skill. Use the newest diagnosis window below and account for every grouped delivery id. Separate facts from hypotheses and persist one complete current report with aiops_incident_report.',
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
    'permissionPresets',
    'sessionPersistence',
    'sessions',
    'sessionTitle',
    'webhookRuntime',
    'workspaceRegistry',
  ]
  static Config = Config

  private readonly store: IncidentRouteStore
  private readonly allowedAlertnames: ReadonlySet<string>
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
    this.allowedAlertnames = new Set(config.alertnameAllowlist)
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
      if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
      await disposeRule()
      await this.drainPromise?.catch(() => {})
      this.store.close()
    }, 'aiopsIncidentRouter.lifecycle()')
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
      const alertname = alert.labels['alertname'] ?? ''
      if (!this.allowedAlertnames.has(alertname)) {
        this.store.recordFiltered({
          source: delivery.source,
          deliveryId: delivery.deliveryId,
          payloadDigest: delivery.event.payloadDigest,
          alert,
          reason: 'alertname-not-allowed',
          receivedAt: delivery.receivedAt,
        })
        continue
      }
      const severityLabel = alert.labels['severity'] ?? ''
      const severity = this.config.severityMap[severityLabel]
      if (severity === undefined) {
        this.store.recordFiltered({
          source: delivery.source,
          deliveryId: delivery.deliveryId,
          payloadDigest: delivery.event.payloadDigest,
          alert,
          reason: 'severity-not-mapped',
          receivedAt: delivery.receivedAt,
        })
        continue
      }
      const now = Date.now()
      const key = this.fingerprintKey(delivery.source, alert.fingerprint)
      const lastDispatch = this.store.lastDispatchAt(delivery.source, alert.fingerprint)
      const cooldownUntil = lastDispatch === undefined
        ? now
        : lastDispatch + this.config.stormControl.cooldownSeconds * 1_000
      const capacityReason = this.capacityReason(severity)
      const reason: RouteControlReason = this.active.has(key)
        || this.store.hasPendingFingerprint(delivery.source, alert.fingerprint)
        ? 'fingerprint-grouped'
        : cooldownUntil > now
          ? 'cooldown'
          : capacityReason ?? 'ready'
      this.store.enqueue({
        source: delivery.source,
        deliveryId: delivery.deliveryId,
        payloadDigest: delivery.event.payloadDigest,
        receivedAt: delivery.receivedAt,
        event: delivery.event,
        alert,
        severity,
        reason,
        availableAt: Math.max(now, cooldownUntil),
        maxQueueSize: this.config.stormControl.maxQueueSize,
        now,
      })
    }
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
    this.store.dropExpired(now, this.config.stormControl.maxQueueAgeSeconds * 1_000)
    const starts: Promise<void>[] = []
    for (const group of this.store.readyGroups(now)) {
      signal.throwIfAborted()
      const key = this.fingerprintKey(group.source, group.fingerprint)
      if (this.active.has(key)) continue
      const capacityReason = this.capacityReason(group.severity)
      if (capacityReason !== undefined) {
        this.store.deferGroup(
          group.source,
          group.fingerprint,
          capacityReason,
          now,
          [...this.active.values()].reduce((total, item) => total + item.tokens, 0),
        )
        continue
      }
      const work = this.store.claimGroup(group.source, group.fingerprint, now)
      if (work.length === 0) continue
      const severity = highestSeverity(work)
      const reservation = { severity, tokens: this.config.modelBudgets[severity] }
      this.active.set(key, reservation)
      starts.push(this.dispatchGroup(key, work, reservation, signal))
    }
    await Promise.all(starts)
    this.scheduleWake()
  }

  private async dispatchGroup(
    key: string,
    work: QueuedRoute[],
    reservation: { severity: 'info' | 'warning' | 'critical'; tokens: number },
    signal: AbortSignal,
  ): Promise<void> {
    let agent: Agent | undefined
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
      const cooldownUntil = startedAt + this.config.stormControl.cooldownSeconds * 1_000
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
        content: [{ type: 'text', text: promptForGroup(events) }],
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
      const now = Date.now()
      const message = error instanceof Error ? error.message : String(error)
      for (const item of work) {
        this.store.retryOrDrop(
          item,
          now,
          now + this.config.stormControl.retryBackoffSeconds * 1_000,
          this.config.stormControl.maxDispatchAttempts,
          message,
        )
      }
      this.release(key)
      this.scheduleWake()
      throw error
    }
    const settled = agent?.whenIdle() ?? Promise.resolve()
    void settled.finally(() => {
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
    if (reservations.length >= this.config.stormControl.globalConcurrency) return 'global-concurrency'
    const same = reservations.filter(item => item.severity === severity)
    if (same.length >= this.config.stormControl.severityConcurrency[severity]) return 'severity-concurrency'
    const globalTokens = reservations.reduce((total, item) => total + item.tokens, 0)
    if (globalTokens + this.config.modelBudgets[severity] > this.config.stormControl.globalReservedTokens) {
      return 'global-token-budget'
    }
    const severityTokens = same.reduce((total, item) => total + item.tokens, 0)
    if (severityTokens + this.config.modelBudgets[severity]
      > this.config.stormControl.severityReservedTokens[severity]) return 'severity-token-budget'
    return undefined
  }

  private release(key: string): void {
    this.active.delete(key)
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
      content: [{ type: 'text', text: promptFor(event) }],
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
      maxTokens: this.config.modelBudgets[route.severity],
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
