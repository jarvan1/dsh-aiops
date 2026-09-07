/**
 * Workspace-scoped model tools over durable AIOps incident events.
 * @module @deepseek-ai/dsh-tool-aiops-history
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import {
  decodeAiopsIncidentState,
  decodeAiopsOperatorFeedback,
  type AiopsIncidentState,
  type AiopsOperatorFeedback,
} from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome } from '@deepseek-ai/dsh-aiops-incident-router'
import type { SessionEventSearchHit, SessionResultFilter } from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-aiops-history'

/** Services required for model tools and workspace-scoped Session reads. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery']

/** Default maximum incident records returned by one call. */
export const DEFAULT_LIMIT = 20
/** Maximum accepted incident result count. */
export const DEFAULT_MAX_LIMIT = 100
/** Maximum sessions inspected by one list operation. */
export const DEFAULT_MAX_SCAN_SESSIONS = 500
/** Default cooperative deadline for each history operation. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Deployment-owned bounds for incident history tools. */
export interface Config {
  /** Result count when a call omits `limit`. Defaults to 20. */
  defaultLimit?: number
  /** Largest accepted result count. Defaults to 100. */
  maxLimit?: number
  /** Largest workspace session set inspected by a list call. Defaults to 500. */
  maxScanSessions?: number
  /** Cooperative operation deadline in milliseconds. Defaults to 30000. */
  timeoutMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  defaultLimit: z.number().step(1).min(1).default(DEFAULT_LIMIT),
  maxLimit: z.number().step(1).min(1).default(DEFAULT_MAX_LIMIT),
  maxScanSessions: z.number().step(1).min(1).default(DEFAULT_MAX_SCAN_SESSIONS),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly defaultLimit: number
  readonly maxLimit: number
  readonly maxScanSessions: number
  readonly timeoutMs: number
}

interface IncidentRecord {
  readonly sessionId: SessionId
  readonly seq: number
  readonly time: number
  readonly incident: AiopsIncidentState
}

interface FeedbackRecord {
  readonly sessionId: SessionId
  readonly seq: number
  readonly time: number
  readonly feedback: AiopsOperatorFeedback
}

interface Caller {
  readonly sessionId: SessionId
  readonly cwd?: string
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT = 'Use aiops_incident_list to review durable incident records in this workspace, '
  + 'aiops_incident_search to find records by literal text, and aiops_incident_get to read one exact cited record. '
  + 'Use aiops_feedback_list for append-only operator verdicts and aiops_routing_audit for filtered, grouped, deferred, '
  + 'dropped, started, and completed routing decisions. These tools never change infrastructure.'

const LIMIT_PARAMETER = {
  type: 'integer' as const,
  description: 'Maximum records to return; the deployment cap applies.',
}

/** Register workspace-scoped incident list, exact-read, and full-text-search tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:aiops-history',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'aiops_incident_list',
    description: 'List durable AIOps incident-state records from sessions in the caller workspace, newest first.',
    parameters: { limit: LIMIT_PARAMETER },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      await listIncidents(ctx, callerOf(exec), resolveLimit(args.limit, resolved), resolved.maxScanSessions, exec.signal),
      null,
      2,
    ),
    presentCall: () => ({ card: 'generic', title: 'List AIOps incidents', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_incident_get',
    description: 'Read one exact durable AIOps incident-state event by session id and event sequence.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id cited by an incident history result.' },
      seq: { type: 'integer', required: true, description: 'Event sequence cited by an incident history result.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      await getIncident(ctx, callerOf(exec), args.session_id, args.seq, exec.signal),
      null,
      2,
    ),
    presentCall: args => ({ card: 'generic', title: 'Read AIOps incident', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_incident_search',
    description: 'Search durable AIOps incident-state text across sessions in the caller workspace.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal incident text to find.' },
      limit: LIMIT_PARAMETER,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      await searchIncidents(ctx, callerOf(exec), args.query, resolveLimit(args.limit, resolved), exec.signal),
      null,
      2,
    ),
    presentCall: args => ({ card: 'generic', title: 'Search AIOps incidents', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_feedback_list',
    description: 'List or search append-only operator feedback about incident reports in the caller workspace, newest first.',
    parameters: {
      query: { type: 'string', description: 'Optional literal feedback text to find.' },
      verdict: { type: 'string', enum: ['confirmed', 'corrected', 'rejected'], description: 'Optional verdict filter.' },
      limit: LIMIT_PARAMETER,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(await listFeedback(
      ctx,
      callerOf(exec),
      resolveLimit(args.limit, resolved),
      resolved.maxScanSessions,
      args.query,
      args.verdict,
      exec.signal,
    ), null, 2),
    presentCall: args => ({ card: 'generic', title: 'List AIOps operator feedback', kind: 'search', rawInput: args }),
  }))

  ctx.inject(['aiopsIncidentRouter'], (routerCtx) => {
    routerCtx.tools.register(defineTool({
      name: 'aiops_routing_audit',
      description: 'Read persisted alert admission and storm-control decisions for this AIOps workspace, newest first.',
      parameters: {
        query: { type: 'string', description: 'Optional literal source, alert, delivery, fingerprint, reason, or Session text.' },
        outcome: {
          type: 'string',
          enum: ['filtered', 'deferred', 'grouped', 'dropped', 'started', 'completed', 'failed'],
          description: 'Optional routing outcome filter.',
        },
        limit: LIMIT_PARAMETER,
      },
      output: TEXT_OUTPUT,
      timeoutMs: resolved.timeoutMs,
      execute: async (args, exec) => {
        const caller = callerOf(exec)
        if (caller.cwd !== routerCtx.aiopsIncidentRouter.workspacePath) throw unauthorized()
        return JSON.stringify(routerCtx.aiopsIncidentRouter.listControlAudit({
          limit: resolveLimit(args.limit, resolved),
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.outcome === undefined ? {} : { outcome: args.outcome as RouteAuditOutcome }),
        }), null, 2)
      },
      presentCall: args => ({ card: 'generic', title: 'Read AIOps routing audit', kind: 'search', rawInput: args }),
    }))
  })
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved = {
    defaultLimit: config.defaultLimit ?? DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? DEFAULT_MAX_LIMIT,
    maxScanSessions: config.maxScanSessions ?? DEFAULT_MAX_SCAN_SESSIONS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`tool-aiops-history: ${key} must be a positive safe integer`)
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw new TypeError('tool-aiops-history: defaultLimit must not exceed maxLimit')
  }
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`tool-aiops-history: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return resolved
}

function resolveLimit(value: number | undefined, config: ResolvedConfig): number {
  const limit = value ?? config.defaultLimit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.maxLimit) {
    throw new HarnessError(
      `AIOps incident limit must be an integer between 1 and ${config.maxLimit}.`,
      'AIOPS_HISTORY_INVALID_LIMIT',
    )
  }
  return limit
}

function callerOf(exec: ToolRunContext): Caller {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new HarnessError('AIOps incident history requires an agent-bound caller.', 'AIOPS_HISTORY_MISSING_AGENT')
  }
  return { sessionId: session.id, ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd } }
}

function workspaceFilters(caller: Caller): SessionResultFilter[] {
  return caller.cwd === undefined
    ? [{ kind: 'id', values: [caller.sessionId] }]
    : [{ kind: 'cwd', values: [caller.cwd] }]
}

async function listIncidents(
  ctx: Context,
  caller: Caller,
  limit: number,
  maxScanSessions: number,
  signal: AbortSignal,
): Promise<IncidentRecord[]> {
  const sessions = await ctx.sessionQuery.filterSessions(workspaceFilters(caller), signal)
  const records: IncidentRecord[] = []
  for (const session of sessions.slice(0, maxScanSessions)) {
    signal.throwIfAborted()
    const events = await ctx.sessionQuery.filterEvents(session.header.id, [
      { kind: 'type', values: ['aiops/incident-state'] },
    ])
    for (const event of events) records.push(await readIncidentHit(ctx, event, signal))
  }
  return records.sort(compareNewest).slice(0, limit)
}

async function getIncident(
  ctx: Context,
  caller: Caller,
  sessionIdText: string,
  seqValue: number,
  signal: AbortSignal,
): Promise<IncidentRecord> {
  if (!Number.isSafeInteger(seqValue) || seqValue < 0) {
    throw new HarnessError('AIOps incident seq must be a non-negative safe integer.', 'AIOPS_HISTORY_INVALID_SEQ')
  }
  const sessionId = brandString<SessionId>(sessionIdText)
  if (sessionId !== caller.sessionId) {
    const authorized = await ctx.sessionQuery.filterSessions([
      { kind: 'id', values: [sessionId] },
      ...workspaceFilters(caller),
    ], signal)
    if (authorized.length !== 1) throw unauthorized()
  }
  const window = await ctx.sessionQuery.readEvent({ sessionId, seq: SessionSeq(seqValue) }, signal)
  if (window.session.id !== sessionId || !headerAuthorized(window.session.cwd, caller)) throw unauthorized()
  if (window.target.type !== 'aiops/incident-state') {
    throw new HarnessError('The cited Session event is not an AIOps incident record.', 'AIOPS_HISTORY_EVENT_NOT_INCIDENT')
  }
  return {
    sessionId,
    seq: window.target.seq,
    time: window.target.time,
    incident: decodeAiopsIncidentState(window.target.data),
  }
}

async function searchIncidents(
  ctx: Context,
  caller: Caller,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<IncidentRecord[]> {
  const page = await ctx.sessionQuery.searchSessions({
    query,
    sessionFilters: workspaceFilters(caller),
    eventFilters: [{ kind: 'type', values: ['aiops/incident-state'] }],
    limit,
  }, { signal })
  const records: IncidentRecord[] = []
  for (const hit of page.items) records.push(await readIncidentHit(ctx, hit.bestMatch, signal))
  return records.sort(compareNewest)
}

async function listFeedback(
  ctx: Context,
  caller: Caller,
  limit: number,
  maxScanSessions: number,
  query: string | undefined,
  verdict: 'confirmed' | 'corrected' | 'rejected' | undefined,
  signal: AbortSignal,
): Promise<FeedbackRecord[]> {
  const records: FeedbackRecord[] = []
  if (query !== undefined && query.trim() !== '') {
    const page = await ctx.sessionQuery.searchSessions({
      query,
      sessionFilters: workspaceFilters(caller),
      eventFilters: [{ kind: 'type', values: ['aiops/operator-feedback'] }],
      limit,
    }, { signal })
    for (const hit of page.items) records.push(await readFeedbackHit(ctx, hit.bestMatch, signal))
  } else {
    const sessions = await ctx.sessionQuery.filterSessions(workspaceFilters(caller), signal)
    for (const session of sessions.slice(0, maxScanSessions)) {
      signal.throwIfAborted()
      const events = await ctx.sessionQuery.filterEvents(session.header.id, [
        { kind: 'type', values: ['aiops/operator-feedback'] },
      ])
      for (const event of events) records.push(await readFeedbackHit(ctx, event, signal))
    }
  }
  return records.filter(record => verdict === undefined || record.feedback.verdict === verdict)
    .sort(compareNewest).slice(0, limit)
}

async function readFeedbackHit(
  ctx: Context,
  hit: Pick<SessionEventSearchHit, 'sessionId' | 'seq' | 'time' | 'type'>,
  signal: AbortSignal,
): Promise<FeedbackRecord> {
  const window = await ctx.sessionQuery.readEvent({ sessionId: hit.sessionId, seq: hit.seq }, signal)
  if (window.target.type !== 'aiops/operator-feedback') {
    throw new HarnessError('The feedback index cited a non-feedback event.', 'AIOPS_HISTORY_INDEX_MISMATCH')
  }
  return {
    sessionId: hit.sessionId,
    seq: hit.seq,
    time: hit.time,
    feedback: decodeAiopsOperatorFeedback(window.target.data),
  }
}

async function readIncidentHit(
  ctx: Context,
  hit: Pick<SessionEventSearchHit, 'sessionId' | 'seq' | 'time' | 'type'>,
  signal: AbortSignal,
): Promise<IncidentRecord> {
  const window = await ctx.sessionQuery.readEvent({ sessionId: hit.sessionId, seq: hit.seq }, signal)
  /* v8 ignore next 3 -- a filtered hit and its append-only seq have one immutable event type. */
  if (window.target.type !== 'aiops/incident-state') {
    throw new HarnessError('The incident index cited a non-incident event.', 'AIOPS_HISTORY_INDEX_MISMATCH')
  }
  return {
    sessionId: hit.sessionId,
    seq: hit.seq,
    time: hit.time,
    incident: decodeAiopsIncidentState(window.target.data),
  }
}

function headerAuthorized(cwd: string | undefined, caller: Caller): boolean {
  return caller.cwd === undefined ? cwd === undefined : cwd === caller.cwd
}

function unauthorized(): HarnessError {
  return new HarnessError('The requested incident is not available in the caller workspace.', 'AIOPS_HISTORY_UNAUTHORIZED')
}

function compareNewest(left: Pick<IncidentRecord, 'time' | 'sessionId' | 'seq'>, right: Pick<IncidentRecord, 'time' | 'sessionId' | 'seq'>): number {
  return right.time - left.time || right.sessionId.localeCompare(left.sessionId) || right.seq - left.seq
}
