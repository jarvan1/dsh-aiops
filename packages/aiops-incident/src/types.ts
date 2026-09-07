/** Pure durable and projection types for the AIOps incident domain. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable incident identity within one session. */
export type AiopsIncidentId = Branded<'AiopsIncidentId'>

/** Stable evidence identity within one incident. */
export type AiopsEvidenceId = Branded<'AiopsEvidenceId'>

/** Stable identity of one idempotent operator-feedback tool call. */
export type AiopsFeedbackId = Branded<'AiopsFeedbackId'>

/** One concise observation supporting or weakening a hypothesis. */
export interface AiopsEvidence {
  /** Stable identity referenced by hypotheses. */
  readonly id: AiopsEvidenceId
  /** Origin class of the observation. */
  readonly kind: 'alert' | 'metric' | 'kubernetes' | 'log' | 'change' | 'other'
  /** Factual observation without an unsupported causal claim. */
  readonly summary: string
}

/** One candidate explanation tied to explicit evidence IDs. */
export interface AiopsHypothesis {
  /** Candidate cause. */
  readonly summary: string
  /** Evidence-calibrated confidence. */
  readonly confidence: 'confirmed' | 'strong' | 'possible' | 'insufficient'
  /** Evidence records supporting the confidence assignment. */
  readonly evidenceIds: AiopsEvidenceId[]
}

/** One proposed operator action; this package never executes it. */
export interface AiopsRecommendation {
  /** Human-reviewable action. */
  readonly action: string
  /** Operational risk if a human chooses to execute the action. */
  readonly risk: 'low' | 'medium' | 'high'
}

/** Complete current incident state persisted by every write. */
export interface AiopsIncidentState {
  /** Durable state schema version. */
  readonly version: 1
  /** Stable incident identity. */
  readonly incidentId: AiopsIncidentId
  /** Concise incident title. */
  readonly title: string
  /** Current assessed impact. */
  readonly severity: 'info' | 'warning' | 'critical'
  /** Investigation lifecycle state. */
  readonly status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  /** Complete current evidence set. */
  readonly evidence: AiopsEvidence[]
  /** Complete current hypothesis set. */
  readonly hypotheses: AiopsHypothesis[]
  /** Complete current recommendation set. */
  readonly recommendations: AiopsRecommendation[]
}

/** Append-only human feedback about one exact persisted incident report. */
export interface AiopsOperatorFeedback {
  readonly version: 1
  /** Deterministic from the owning Session and tool call, so retries are idempotent. */
  readonly feedbackId: AiopsFeedbackId
  /** Incident identity copied from the current projection. */
  readonly incidentId: AiopsIncidentId
  /** Sequence of the incident-state event the operator reviewed. */
  readonly reportSeq: number
  /** Operator assessment; this never mutates the report being reviewed. */
  readonly verdict: 'confirmed' | 'corrected' | 'rejected'
  /** Concise reason or review note supplied by the operator. */
  readonly note: string
  /** Replacement explanation required for a corrected verdict. */
  readonly correction?: string
  readonly origin: 'operator-via-agent'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-write AIOps incident state; latest valid event wins on replay. */
    'aiops/incident-state': AiopsIncidentState
    /** Append-only operator review of one exact incident-state event. */
    'aiops/operator-feedback': AiopsOperatorFeedback
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    aiopsIncident: AiopsIncidentState | null
    aiopsIncidentFeedback: AiopsOperatorFeedback | null
  }
  interface SessionProjectionMap {
    /** Current incident, or null before the first structured report. */
    aiopsIncident: AiopsIncidentState | null
    /** Latest operator review in this incident Session, or null. */
    aiopsIncidentFeedback: AiopsOperatorFeedback | null
  }
}
