import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  aiopsFeedbackProjectionDefinition,
  aiopsFeedbackProjectionSchema,
  aiopsIncidentProjectionDefinition,
  aiopsIncidentProjectionSchema,
  decodeAiopsIncidentState,
  decodeAiopsOperatorFeedback,
  validateAiopsIncidentTransition,
} from '../src/index.ts'

const base = {
  version: 1 as const,
  incidentId: 'inc-payments-1',
  title: 'Payments latency',
  severity: 'critical' as const,
  status: 'investigating' as const,
  evidence: [{ id: 'metric-p99', kind: 'metric' as const, summary: 'p99 exceeded 2 seconds.' }],
  hypotheses: [{ summary: 'API saturation', confidence: 'possible' as const, evidenceIds: ['metric-p99'] }],
  recommendations: [{ action: 'Review pod saturation before scaling.', risk: 'low' as const }],
}

describe('AIOps incident domain', () => {
  it('canonicalizes text and validates hypothesis evidence references', () => {
    expect(decodeAiopsIncidentState({ ...base, title: '  Payments latency  ' }).title).toBe('Payments latency')
    expect(() => decodeAiopsIncidentState({
      ...base,
      hypotheses: [{ summary: 'Unknown', confidence: 'possible', evidenceIds: ['missing'] }],
    })).toThrow('unknown hypothesis evidence id missing')
    expect(decodeAiopsIncidentState({
      ...base,
      evidence: [{ id: 'alert-latency', kind: 'alert', summary: 'HighLatency is active.' }],
      hypotheses: [],
    }).evidence[0]?.kind).toBe('alert')
  })

  it('rejects empty, oversized, invalid, and duplicate incident fields', () => {
    expect(() => decodeAiopsIncidentState({ ...base, title: ' ' })).toThrow('incident title must be non-empty')
    expect(() => decodeAiopsIncidentState({ ...base, title: 'x'.repeat(2_001) })).toThrow('must not exceed 2000')
    expect(() => decodeAiopsIncidentState({ ...base, incidentId: '-invalid' })).toThrow('invalid characters')
    expect(() => decodeAiopsIncidentState({ ...base, incidentId: `i${'x'.repeat(128)}` })).toThrow('invalid characters')
    expect(() => decodeAiopsIncidentState({
      ...base,
      evidence: [base.evidence[0], base.evidence[0]],
    })).toThrow('duplicate evidence id metric-p99')
    expect(() => decodeAiopsIncidentState({
      ...base,
      hypotheses: [{ ...base.hypotheses[0], evidenceIds: ['metric-p99', 'metric-p99'] }],
    })).toThrow('duplicate hypothesis evidence id metric-p99')
  })

  it('keeps incident identity stable and resolved state terminal', () => {
    const first = decodeAiopsIncidentState(base)
    expect(() => { validateAiopsIncidentTransition(null, first) }).not.toThrow()
    expect(() => {
      validateAiopsIncidentTransition(null, decodeAiopsIncidentState({ ...base, status: 'resolved' }))
    }).toThrow('first incident report cannot already be resolved')
    expect(() => { validateAiopsIncidentTransition(first, first) }).not.toThrow()
    expect(() => {
      validateAiopsIncidentTransition(first, decodeAiopsIncidentState({ ...base, incidentId: 'inc-other' }))
    }).toThrow('cannot replace its incident identity')
    const resolved = decodeAiopsIncidentState({ ...base, status: 'resolved' })
    expect(() => { validateAiopsIncidentTransition(resolved, first) }).toThrow('cannot return')
    expect(() => { validateAiopsIncidentTransition(resolved, resolved) }).not.toThrow()
  })

  it('projects the latest complete incident state from the durable event', () => {
    const session = Session.create(SessionId('incident-projection'))
    const initial = aiopsIncidentProjectionDefinition.init()
    const first = decodeAiopsIncidentState(base)
    session.append('aiops/incident-state', first)
    const firstEvent = session.snapshotEvents()[0]
    if (firstEvent === undefined) throw new Error('missing incident event')
    const current = aiopsIncidentProjectionDefinition.apply(initial, firstEvent)
    expect(current).toEqual(first)
    expect(aiopsIncidentProjectionDefinition.apply(current, { type: 'unrelated' } as never)).toBe(current)
    expect(aiopsIncidentProjectionDefinition.wire.view(current)).toBe(current)
  })

  it('validates values read from a projection cache', () => {
    const first = decodeAiopsIncidentState(base)
    expect(aiopsIncidentProjectionSchema.parse(first)).toEqual(first)
    expect(aiopsIncidentProjectionSchema.parse(null)).toBeNull()
    expect(aiopsIncidentProjectionSchema.safeParse({ incidentId: 'incomplete' }).success).toBe(false)
  })

  it('validates corrected feedback and projects the latest append-only review', () => {
    const confirmed = decodeAiopsOperatorFeedback({
      version: 1,
      feedbackId: `feedback-${'a'.repeat(32)}`,
      incidentId: 'inc-payments-1',
      reportSeq: 3,
      verdict: 'confirmed',
      note: ' Operator confirmed the diagnosis. ',
      origin: 'operator-via-agent',
    })
    expect(confirmed.note).toBe('Operator confirmed the diagnosis.')
    expect(aiopsFeedbackProjectionSchema.parse(confirmed)).toEqual(confirmed)
    expect(() => decodeAiopsOperatorFeedback({ ...confirmed, verdict: 'corrected' })).toThrow(/requires a correction/)
    expect(() => decodeAiopsOperatorFeedback({ ...confirmed, correction: 'unexpected' })).toThrow(/only corrected/)
    const corrected = decodeAiopsOperatorFeedback({
      ...confirmed,
      feedbackId: `feedback-${'b'.repeat(32)}`,
      verdict: 'corrected',
      correction: 'The rollout, not saturation, caused the failure.',
    })
    const session = Session.create(SessionId('feedback-projection'))
    session.append('aiops/operator-feedback', confirmed)
    session.append('aiops/operator-feedback', corrected)
    let state = aiopsFeedbackProjectionDefinition.init()
    for (const event of session.snapshotEvents()) state = aiopsFeedbackProjectionDefinition.apply(state, event)
    expect(state).toEqual(corrected)
  })
})
