/** Strict decoding and lifecycle validation for durable AIOps incident state. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type {
  AiopsEvidence,
  AiopsEvidenceId,
  AiopsHypothesis,
  AiopsIncidentId,
  AiopsIncidentState,
  AiopsRecommendation,
} from './types.ts'

const MAX_COLLECTION_ITEMS = 100
const MAX_TEXT_CHARS = 2_000

function boundedText(label: string): ZodType<string> {
  return z.string().transform((value, context) => {
    const normalized = value.trim()
    if (normalized === '') context.addIssue({ code: 'custom', message: `${label} must be non-empty` })
    if (normalized.length > MAX_TEXT_CHARS) {
      context.addIssue({ code: 'custom', message: `${label} must not exceed ${MAX_TEXT_CHARS} characters` })
    }
    return normalized
  })
}

function brandedId<T extends Branded<string>>(label: string): ZodType<T> {
  return boundedText(label).transform((value, context): T => {
    if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
      context.addIssue({ code: 'custom', message: `${label} has invalid characters or length` })
      return z.NEVER
    }
    return brandString<T>(value)
  })
}

const evidenceSchema: ZodType<AiopsEvidence> = z.object({
  id: brandedId<AiopsEvidenceId>('evidence id'),
  kind: z.enum(['alert', 'metric', 'kubernetes', 'log', 'change', 'other']),
  summary: boundedText('evidence summary'),
}).strict()

const hypothesisSchema: ZodType<AiopsHypothesis> = z.object({
  summary: boundedText('hypothesis summary'),
  confidence: z.enum(['confirmed', 'strong', 'possible', 'insufficient']),
  evidenceIds: z.array(brandedId<AiopsEvidenceId>('hypothesis evidence id')).max(MAX_COLLECTION_ITEMS),
}).strict()

const recommendationSchema: ZodType<AiopsRecommendation> = z.object({
  action: boundedText('recommendation action'),
  risk: z.enum(['low', 'medium', 'high']),
}).strict()

const incidentSchema: ZodType<AiopsIncidentState> = z.object({
  version: z.literal(1),
  incidentId: brandedId<AiopsIncidentId>('incident id'),
  title: boundedText('incident title'),
  severity: z.enum(['info', 'warning', 'critical']),
  status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
  evidence: z.array(evidenceSchema).max(MAX_COLLECTION_ITEMS),
  hypotheses: z.array(hypothesisSchema).max(MAX_COLLECTION_ITEMS),
  recommendations: z.array(recommendationSchema).max(MAX_COLLECTION_ITEMS),
}).strict().superRefine((state, context) => {
  const evidenceIds = new Set<string>()
  for (const item of state.evidence) {
    if (evidenceIds.has(item.id)) context.addIssue({ code: 'custom', message: `duplicate evidence id ${item.id}` })
    evidenceIds.add(item.id)
  }
  for (const hypothesis of state.hypotheses) {
    const hypothesisIds = new Set<string>()
    for (const id of hypothesis.evidenceIds) {
      if (!evidenceIds.has(id)) context.addIssue({ code: 'custom', message: `unknown hypothesis evidence id ${id}` })
      if (hypothesisIds.has(id)) context.addIssue({ code: 'custom', message: `duplicate hypothesis evidence id ${id}` })
      hypothesisIds.add(id)
    }
  }
})

/**
 * Decode one model, durable-log, or projection-cache value into canonical incident state.
 * @param value - untrusted incident-shaped value.
 * @returns trimmed, branded, cross-reference-validated state.
 */
export function decodeAiopsIncidentState(value: unknown): AiopsIncidentState {
  return incidentSchema.parse(value)
}

/**
 * Validate identity and lifecycle continuity against the prior session state.
 * @param previous - current projected state, or null for the first report.
 * @param next - candidate complete replacement state.
 */
export function validateAiopsIncidentTransition(
  previous: AiopsIncidentState | null,
  next: AiopsIncidentState,
): void {
  if (previous === null) {
    if (next.status === 'resolved') throw new Error('The first incident report cannot already be resolved.')
    return
  }
  if (previous.incidentId !== next.incidentId) {
    throw new Error('A session cannot replace its incident identity; start a new session for another incident.')
  }
  if (previous.status === 'resolved' && next.status !== 'resolved') {
    throw new Error('A resolved incident cannot return to an active state.')
  }
}

/** Zod validator used by the session-projection cache boundary. */
export const aiopsIncidentProjectionSchema: ZodType<AiopsIncidentState | null> = z.union([
  z.unknown().transform((value, context): AiopsIncidentState => {
    try {
      return decodeAiopsIncidentState(value)
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid AIOps incident state' })
      return z.NEVER
    }
  }),
  z.null(),
])
