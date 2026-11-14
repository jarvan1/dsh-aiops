/**
 * Workspace-scoped model tools over durable AIOps incident storage.
 * @module @deepseek-ai/dsh-tool-aiops-history
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  feedbackSearchText,
  incidentSearchText,
  type AiopsIncidentState,
  type AiopsOperatorFeedback,
} from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome } from '@deepseek-ai/dsh-aiops-incident-router'
import { compileSessionTextFilter } from '@deepseek-ai/dsh-session-query'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-aiops-history'

/** Services required for model tools and workspace-scoped incident reads. */
export const inject = ['tools', 'systemPrompt', 'aiopsIncidents']

/** Default maximum incident records returned by one call. */
export const DEFAULT_LIMIT = 20

/** Maximum accepted incident result count. */
export const DEFAULT_MAX_LIMIT = 100
/** Maximum stored records inspected by one list operation. */
export const DEFAULT_MAX_SCAN_RECORDS = 500
/** Default cooperative deadline for each history operation. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Deployment-owned bounds for incident history tools. */
export interface Config {
  /** Result count when a call omits `limit`. Defaults to 20. */
  defaultLimit?: number
  /** Largest accepted result count. Defaults to 100. */
  maxLimit?: number
  /** Largest stored record set inspected by a list call. Defaults to 500. */
  maxScanRecords?: number
  /** Cooperative operation deadline in milliseconds. Defaults to 30000. */
  timeoutMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  defaultLimit: z.number().step(1).min(1).default(DEFAULT_LIMIT),
  maxLimit: z.number().step(1).min(1).default(DEFAULT_MAX_LIMIT),
  maxScanRecords: z.number().step(1).min(1).default(DEFAULT_MAX_SCAN_RECORDS),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly defaultLimit: number
  readonly maxLimit: number
  readonly maxScanRecords: number
  readonly timeoutMs: number
}

interface IncidentRecord {
  readonly sessionId: string
  readonly revision: number
  readonly updatedAt: number
  readonly incident: AiopsIncidentState
}

interface FeedbackRecord {
  readonly sessionId: string
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
    description: 'List durable AIOps incident records from the caller workspace, newest first.',
    parameters: { limit: LIMIT_PARAMETER },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      listIncidents(ctx, callerOf(exec), resolveLimit(args.limit, resolved), resolved.maxScanRecords, exec.signal),
      null,
      2,
    ),
    presentCall: () => ({ card: 'generic', title: 'List AIOps incidents', kind: 'search' }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_incident_get',
    description: 'Read one exact durable AIOps incident record by session id and report revision.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Session id cited by an incident history result.' },
      revision: { type: 'integer', required: true, description: 'Report revision cited by an incident history result.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      getIncident(ctx, callerOf(exec), args.session_id, args.revision),
      null,
      2,
    ),
    presentCall: args => ({ card: 'generic', title: 'Read AIOps incident', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_incident_search',
    description: 'Search durable AIOps incident text across the caller workspace.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal incident text to find.' },
      limit: LIMIT_PARAMETER,
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: async (args, exec) => JSON.stringify(
      searchIncidents(
        ctx,
        callerOf(exec),
        args.query,
        resolveLimit(args.limit, resolved),
        resolved.maxScanRecords,
        exec.signal,
      ),
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
    execute: async (args, exec) => JSON.stringify(listFeedback(
      ctx,
      callerOf(exec),
      resolveLimit(args.limit, resolved),
      resolved.maxScanRecords,
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
    maxScanRecords: config.maxScanRecords ?? DEFAULT_MAX_SCAN_RECORDS,
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
  const cwd = session.header?.cwd
  return { sessionId: session.id, ...(cwd === undefined ? {} : { cwd }) }
}

function listIncidents(
  ctx: Context,
  caller: Caller,
  limit: number,
  maxScanRecords: number,
  signal: AbortSignal,
): IncidentRecord[] {
  const records: IncidentRecord[] = []
  for (const record of candidateIncidents(ctx, caller, maxScanRecords)) {
    signal.throwIfAborted()
    records.push(record)
  }
  return records.sort(compareIncidents).slice(0, limit)
}

/** Candidates visible to one caller: its workspace's records, or its own Session's only. */
function candidateIncidents(ctx: Context, caller: Caller, maxScanRecords: number): IncidentRecord[] {
  if (caller.cwd === undefined) {
    const own = ctx.aiopsIncidents.get(caller.sessionId)
    return own === undefined ? [] : [own]
  }
  return ctx.aiopsIncidents.listIncidents(caller.cwd, maxScanRecords)
}

function getIncident(ctx: Context, caller: Caller, sessionIdText: string, revision: number): IncidentRecord {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new HarnessError('AIOps incident revision must be a positive safe integer.', 'AIOPS_HISTORY_INVALID_REVISION')
  }
  const record = ctx.aiopsIncidents.get(sessionIdText)
  if (record === undefined || record.revision !== revision) {
    throw new HarnessError('The cited incident report revision does not exist.', 'AIOPS_HISTORY_REVISION_NOT_FOUND')
  }
  // Workspace-scoped callers read their workspace's records only; cwd-less
  // callers (no diagnostic workspace) see their own Session's record only.
  if (caller.cwd !== undefined && record.workspace !== caller.cwd) throw unauthorized()
  if (caller.cwd === undefined && record.sessionId !== caller.sessionId) throw unauthorized()
  return record
}

function searchIncidents(
  ctx: Context,
  caller: Caller,
  query: string,
  limit: number,
  maxScanRecords: number,
  signal: AbortSignal,
): IncidentRecord[] {
  const matcher = compileSessionTextFilter(query)
  const records: IncidentRecord[] = []
  for (const record of candidateIncidents(ctx, caller, maxScanRecords)) {
    signal.throwIfAborted()
    if (matcher.test(incidentSearchText(record.incident))) records.push(record)
  }
  return records.sort(compareIncidents).slice(0, limit)
}

function listFeedback(
  ctx: Context,
  caller: Caller,
  limit: number,
  maxScanRecords: number,
  query: string | undefined,
  verdict: 'confirmed' | 'corrected' | 'rejected' | undefined,
  signal: AbortSignal,
): FeedbackRecord[] {
  const matcher = query === undefined || query.trim() === '' ? undefined : compileSessionTextFilter(query)
  const candidates = caller.cwd === undefined
    ? ctx.aiopsIncidents.listFeedback(undefined, maxScanRecords).filter(record => record.sessionId === caller.sessionId)
    : ctx.aiopsIncidents.listFeedback(caller.cwd, maxScanRecords)
  const records: FeedbackRecord[] = []
  for (const record of candidates) {
    signal.throwIfAborted()
    if (matcher === undefined || matcher.test(feedbackSearchText(record.feedback))) records.push(record)
  }
  return records.filter(record => verdict === undefined || record.feedback.verdict === verdict)
    .sort(compareFeedback).slice(0, limit)
}

function unauthorized(): HarnessError {
  return new HarnessError('The requested incident is not available in the caller workspace.', 'AIOPS_HISTORY_UNAUTHORIZED')
}

function compareIncidents(left: IncidentRecord, right: IncidentRecord): number {
  return right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId) || right.revision - left.revision
}

function compareFeedback(left: FeedbackRecord, right: FeedbackRecord): number {
  return right.time - left.time || right.sessionId.localeCompare(left.sessionId)
}
