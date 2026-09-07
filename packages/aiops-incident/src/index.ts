/**
 * Durable structured AIOps incident state, projection, and reporting tool.
 * @module @deepseek-ai/dsh-aiops-incident
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  aiopsIncidentProjectionSchema,
  decodeAiopsIncidentState,
  validateAiopsIncidentTransition,
} from './domain.ts'
import type { AiopsIncidentState } from './types.ts'
import { aiopsFeedbackProjectionSchema, decodeAiopsOperatorFeedback } from './feedback.ts'
import type { AiopsFeedbackId, AiopsOperatorFeedback } from './types.ts'

export type * from './types.ts'
export {
  aiopsIncidentProjectionSchema,
  decodeAiopsIncidentState,
  validateAiopsIncidentTransition,
} from './domain.ts'
export { aiopsFeedbackProjectionSchema, decodeAiopsOperatorFeedback } from './feedback.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'aiops-incident'

/** Registries and durability services required by the incident workflow. */
export const inject = ['tools', 'sessions', 'sessionPersistence', 'sessionProjections']

/** Latest-whole-value incident projection. */
export const aiopsIncidentProjectionDefinition = {
  key: 'aiopsIncident',
  stateSchema: aiopsIncidentProjectionSchema,
  init: () => null,
  apply: (state, event) => event.type === 'aiops/incident-state'
    ? decodeAiopsIncidentState(event.data)
    : state,
  wire: { viewSchema: aiopsIncidentProjectionSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'aiopsIncident', AiopsIncidentState | null>

/** Latest append-only operator review in the current incident Session. */
export const aiopsFeedbackProjectionDefinition = {
  key: 'aiopsIncidentFeedback',
  stateSchema: aiopsFeedbackProjectionSchema,
  init: () => null,
  apply: (state, event) => event.type === 'aiops/operator-feedback'
    ? decodeAiopsOperatorFeedback(event.data)
    : state,
  wire: { viewSchema: aiopsFeedbackProjectionSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'aiopsIncidentFeedback', AiopsOperatorFeedback | null>

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Stable evidence id, for example metric-latency-1.' },
    kind: { type: 'string', required: true, enum: ['alert', 'metric', 'kubernetes', 'log', 'change', 'other'] },
    summary: { type: 'string', required: true, description: 'Observed fact without an unsupported causal claim.' },
  },
} as const

const HYPOTHESIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', required: true },
    confidence: { type: 'string', required: true, enum: ['confirmed', 'strong', 'possible', 'insufficient'] },
    evidenceIds: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true, description: 'Human-reviewable proposed action; this tool does not execute it.' },
    risk: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
  },
} as const

const INCIDENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', required: true, const: 1 },
    incidentId: { type: 'string', required: true },
    title: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['info', 'warning', 'critical'] },
    status: { type: 'string', required: true, enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
    evidence: { type: 'array', required: true, items: EVIDENCE_SCHEMA },
    hypotheses: { type: 'array', required: true, items: HYPOTHESIS_SCHEMA },
    recommendations: { type: 'array', required: true, items: RECOMMENDATION_SCHEMA },
  },
} as const

const FEEDBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', required: true, const: 1 },
    feedbackId: { type: 'string', required: true },
    incidentId: { type: 'string', required: true },
    reportSeq: { type: 'integer', required: true },
    verdict: { type: 'string', required: true, enum: ['confirmed', 'corrected', 'rejected'] },
    note: { type: 'string', required: true },
    correction: { type: 'string' },
    origin: { type: 'string', required: true, const: 'operator-via-agent' },
  },
} as const

async function requireFlush(ctx: Context, session: Parameters<Context['sessions']['flush']>[0]): Promise<void> {
  if (!await ctx.sessions.flush(session)) throw new Error('AIOps incident persistence is uncertain; inspect the session before retrying.')
}

/** Register the incident projection and complete-state reporting tool. */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(aiopsIncidentProjectionDefinition)
  ctx.sessionProjections.register(aiopsFeedbackProjectionDefinition)
  ctx.inject(['sessionQuery'], (queryCtx) => {
    queryCtx.effect(() => {
      const disposeIncident = queryCtx.sessionQuery.registerEventTextExtractor({
        eventType: 'aiops/incident-state',
        revision: '1',
        extract: event => incidentSearchText(event.data),
      })
      const disposeFeedback = queryCtx.sessionQuery.registerEventTextExtractor({
        eventType: 'aiops/operator-feedback',
        revision: '1',
        extract: event => feedbackSearchText(event.data),
      })
      return () => { disposeFeedback(); disposeIncident() }
    }, 'aiopsIncident.sessionQueryText')
  })
  ctx.tools.register(defineTool({
    name: 'aiops_incident_report',
    description: 'Persist the COMPLETE current incident report after collecting evidence. Every call replaces the prior report. Keep the incident id stable, cite evidence ids from this report in each hypothesis, distinguish facts from hypotheses, and propose actions for human review only. This tool records state and never changes infrastructure.',
    parameters: {
      incident: { ...INCIDENT_SCHEMA, required: true, description: 'Complete current incident state.' },
    },
    output: { schema: INCIDENT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('aiops_incident_report requires an owning agent session.')
      await requireFlush(ctx, agent.session)
      exec.signal.throwIfAborted()
      const next = decodeAiopsIncidentState(args.incident)
      const previous = ctx.sessionProjections.stateOf(agent.session, 'aiopsIncident') ?? null
      validateAiopsIncidentTransition(previous, next)
      agent.session.append('aiops/incident-state', next, { ignorable: true })
      await requireFlush(ctx, agent.session)
      return next
    },
    presentCall: args => ({ card: 'generic', title: 'Record AIOps incident', kind: 'other', rawInput: args.incident }),
  }))

  ctx.tools.register(defineTool({
    name: 'aiops_incident_feedback',
    description: 'Append operator feedback about the latest persisted incident report. Call this only after the current user explicitly confirms, corrects, or rejects that diagnosis. This preserves the reviewed report unchanged and never changes infrastructure.',
    parameters: {
      verdict: { type: 'string', required: true, enum: ['confirmed', 'corrected', 'rejected'] },
      note: { type: 'string', required: true, description: 'The operator\'s concise reason or review note.' },
      correction: { type: 'string', description: 'Required replacement explanation when verdict is corrected; omit otherwise.' },
    },
    output: { schema: FEEDBACK_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('aiops_incident_feedback requires an owning agent session.')
      await requireFlush(ctx, agent.session)
      exec.signal.throwIfAborted()
      const reportEvent = agent.session.ownEvents().findLast(event => event.type === 'aiops/incident-state')
      if (reportEvent?.type !== 'aiops/incident-state') {
        throw new Error('aiops_incident_feedback requires a persisted incident report in this Session.')
      }
      const feedbackId = brandString<AiopsFeedbackId>(`feedback-${createHash('sha256')
        .update(`${agent.session.id}\0${exec.callId}`)
        .digest('hex').slice(0, 32)}`)
      const replay = agent.session.ownEvents().find(event => event.type === 'aiops/operator-feedback'
        && event.data.feedbackId === feedbackId)
      if (replay?.type === 'aiops/operator-feedback') return decodeAiopsOperatorFeedback(replay.data)
      const feedback = decodeAiopsOperatorFeedback({
        version: 1,
        feedbackId,
        incidentId: reportEvent.data.incidentId,
        reportSeq: reportEvent.seq,
        verdict: args.verdict,
        note: args.note,
        ...(args.correction === undefined ? {} : { correction: args.correction }),
        origin: 'operator-via-agent',
      })
      agent.session.append('aiops/operator-feedback', feedback, { ignorable: true })
      await requireFlush(ctx, agent.session)
      return feedback
    },
    presentCall: args => ({ card: 'generic', title: 'Record AIOps operator feedback', kind: 'other', rawInput: args }),
  }))
}

function incidentSearchText(incident: AiopsIncidentState): string {
  return [
    incident.incidentId,
    incident.title,
    incident.severity,
    incident.status,
    ...incident.evidence.flatMap(item => [item.id, item.kind, item.summary]),
    ...incident.hypotheses.flatMap(item => [item.summary, item.confidence, ...item.evidenceIds]),
    ...incident.recommendations.flatMap(item => [item.action, item.risk]),
  ].map(part => part.trim()).filter(Boolean).join('\n')
}

function feedbackSearchText(feedback: AiopsOperatorFeedback): string {
  return [
    feedback.feedbackId,
    feedback.incidentId,
    feedback.verdict,
    feedback.note,
    feedback.correction ?? '',
  ].map(part => String(part).trim()).filter(Boolean).join('\n')
}
