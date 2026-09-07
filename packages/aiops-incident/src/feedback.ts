/** Validation for append-only operator feedback over incident reports. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { AiopsFeedbackId, AiopsIncidentId, AiopsOperatorFeedback } from './types.ts'

const MAX_TEXT_CHARS = 2_000

const feedbackIdSchema = z.string().regex(/^feedback-[a-f0-9]{32}$/)
  .transform(value => brandString<AiopsFeedbackId>(value))
const incidentIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .transform(value => brandString<AiopsIncidentId>(value))

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

const rawFeedbackSchema = z.object({
  version: z.literal(1),
  feedbackId: feedbackIdSchema,
  incidentId: incidentIdSchema,
  reportSeq: z.number().int().nonnegative().safe(),
  verdict: z.enum(['confirmed', 'corrected', 'rejected']),
  note: boundedText('feedback note'),
  correction: boundedText('feedback correction').optional(),
  origin: z.literal('operator-via-agent'),
}).strict().superRefine((feedback, context) => {
  if (feedback.verdict === 'corrected' && feedback.correction === undefined) {
    context.addIssue({ code: 'custom', message: 'corrected feedback requires a correction' })
  }
  if (feedback.verdict !== 'corrected' && feedback.correction !== undefined) {
    context.addIssue({ code: 'custom', message: 'only corrected feedback may include a correction' })
  }
})

const feedbackSchema: ZodType<AiopsOperatorFeedback> = rawFeedbackSchema.transform(feedback => ({
  version: feedback.version,
  feedbackId: feedback.feedbackId,
  incidentId: feedback.incidentId,
  reportSeq: feedback.reportSeq,
  verdict: feedback.verdict,
  note: feedback.note,
  ...(feedback.correction === undefined ? {} : { correction: feedback.correction }),
  origin: feedback.origin,
}))

/** Decode untrusted model input, durable events, and projection cache values. */
export function decodeAiopsOperatorFeedback(value: unknown): AiopsOperatorFeedback {
  return feedbackSchema.parse(value)
}

/** Projection-cache validator for the latest feedback value. */
export const aiopsFeedbackProjectionSchema: ZodType<AiopsOperatorFeedback | null> = z.union([
  z.unknown().transform((value, context): AiopsOperatorFeedback => {
    try {
      return decodeAiopsOperatorFeedback(value)
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid AIOps operator feedback' })
      return z.NEVER
    }
  }),
  z.null(),
])
