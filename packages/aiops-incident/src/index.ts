/**
 * Durable structured AIOps incident state, store service, and reporting tool.
 * @module @deepseek-ai/dsh-aiops-incident
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  decodeAiopsIncidentState,
} from './domain.ts'
import { decodeAiopsOperatorFeedback } from './feedback.ts'
import { AiopsIncidentStore } from './store.ts'
import type { AiopsFeedbackId, AiopsIncidentState, AiopsOperatorFeedback } from './types.ts'

export type * from './types.ts'
export {
  MAX_COLLECTION_ITEMS,
  decodeAiopsIncidentState,
  incidentStateSchema,
  validateAiopsIncidentTransition,
} from './domain.ts'
export { decodeAiopsOperatorFeedback, operatorFeedbackValueSchema } from './feedback.ts'
export { AiopsIncidentStore, aiopsIncidentDomainSpec } from './store.ts'
export type { AiopsIncidentStoreApi } from './store.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'aiops-incident'

/** Services required before the reporting tools are registered. */
export const inject = ['tools']

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
    reportRevision: { type: 'integer', required: true },
    verdict: { type: 'string', required: true, enum: ['confirmed', 'corrected', 'rejected'] },
    note: { type: 'string', required: true },
    correction: { type: 'string' },
    origin: { type: 'string', required: true, const: 'operator-via-agent' },
  },
} as const

/** Register the incident store service and the reporting tools. */
export async function apply(ctx: Context): Promise<void> {
  // This package owns the store service: mount it first, then register the
  // tools on a scoped fiber that may touch `ctx.aiopsIncidents`.
  await ctx.plugin(AiopsIncidentStore)
  ctx.inject(['aiopsIncidents'], toolCtx => {
    registerTools(toolCtx)
  })
}

function registerTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'aiops_incident_report',
    description: 'Persist the COMPLETE current incident report after collecting evidence. Every call replaces the prior report and bumps its revision. Keep the incident id stable, cite evidence ids from this report in each hypothesis, distinguish facts from hypotheses, and propose actions for human review only. The first report cannot use status "resolved"; closure is appended after alert recovery. This tool records state and never changes infrastructure.',
    parameters: {
      incident: { ...INCIDENT_SCHEMA, required: true, description: 'Complete current incident state.' },
    },
    output: { schema: INCIDENT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('aiops_incident_report requires an owning agent session.')
      exec.signal.throwIfAborted()
      const next = decodeAiopsIncidentState(args.incident)
      const workspace = workspaceOfSession(agent.session)
      return (await ctx.aiopsIncidents.report(String(agent.session.id), workspace, next)).incident
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
      exec.signal.throwIfAborted()
      const sessionId = String(agent.session.id)
      const record = ctx.aiopsIncidents.get(sessionId)
      if (record === undefined) {
        throw new Error('aiops_incident_feedback requires a persisted incident report in this Session.')
      }
      const feedbackId = brandString<AiopsFeedbackId>(`feedback-${createHash('sha256')
        .update(`${sessionId}\0${exec.callId}`)
        .digest('hex').slice(0, 32)}`)
      const feedback = decodeAiopsOperatorFeedback({
        version: 1,
        feedbackId,
        incidentId: record.incident.incidentId,
        reportRevision: record.revision,
        verdict: args.verdict,
        note: args.note,
        ...(args.correction === undefined ? {} : { correction: args.correction }),
        origin: 'operator-via-agent',
      })
      return (await ctx.aiopsIncidents.appendFeedback(sessionId, feedback)).feedback
    },
    presentCall: args => ({ card: 'generic', title: 'Record AIOps operator feedback', kind: 'other', rawInput: args }),
  }))
}

/** The diagnostic Session's workspace (cwd), falling back to the process cwd. */
function workspaceOfSession(session: object): string {
  const header = (session as { header?: { cwd?: string } }).header
  return header?.cwd ?? process.cwd()
}

export function incidentSearchText(incident: AiopsIncidentState): string {
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

export function feedbackSearchText(feedback: AiopsOperatorFeedback): string {
  return [
    feedback.feedbackId,
    feedback.incidentId,
    feedback.verdict,
    feedback.note,
    feedback.correction ?? '',
  ].map(part => String(part).trim()).filter(Boolean).join('\n')
}
