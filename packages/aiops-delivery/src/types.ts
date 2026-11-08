/** Durable delivery-audit types for the AIOps diagnosis push. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AiopsIncidentId } from '@deepseek-ai/dsh-aiops-incident'

/** Supported IM incoming-webhook provider. */
export type AiopsDeliveryProvider = 'feishu' | 'dingtalk' | 'slack'

/** Stable identity of one idempotent delivery attempt outcome. */
export type AiopsDeliveryId = Branded<'AiopsDeliveryId'>

/**
 * Append-only audit record of one delivery decision. Written after the
 * bounded retry burst finishes so restarts and replays never double-push.
 */
export interface AiopsDeliveryRecord {
  /** Durable state schema version. */
  readonly version: 1
  /** Deterministic from the owning Session, report sequence, and provider. */
  readonly deliveryId: AiopsDeliveryId
  /** Incident identity copied from the delivered report. */
  readonly incidentId: AiopsIncidentId
  /** Sequence of the incident-state event that was pushed. */
  readonly reportSeq: number
  /** Provider the payload was rendered for. */
  readonly provider: AiopsDeliveryProvider
  /** Terminal decision of the delivery burst. */
  readonly outcome: 'delivered' | 'failed'
  /** Bounded `code: message` of the last failure; absent when delivered. */
  readonly reason?: string
  /** Completion time of the burst in epoch milliseconds. */
  readonly deliveredAt: number
}

/**
 * AIOps delivery markers ride the same DSH 0.2.x ignorable plugin-record
 * contract as every other AIOps record, so unknown readers retain and skip
 * them instead of refusing the whole Session log.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One terminal IM delivery decision for one incident report. */
    'plugin:aiops/delivery': AiopsDeliveryRecord
  }
}
