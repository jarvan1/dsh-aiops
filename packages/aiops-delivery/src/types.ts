/** Durable delivery-audit types for the AIOps diagnosis push. */

import type { AiopsIncidentId } from '@deepseek-ai/dsh-aiops-incident'

/** Supported IM incoming-webhook provider. */
export type AiopsDeliveryProvider = 'feishu' | 'dingtalk' | 'slack'

/**
 * Durable audit record of one delivery decision. Written after the bounded
 * retry burst finishes so restarts and replays never double-push. Stored in
 * the plugin-owned `aiops_delivery` storage domain, keyed by Session id.
 */
export interface AiopsDeliveryRecord {
  /** Durable state schema version. */
  readonly version: 1
  /** Owning diagnostic Session; doubles as the storage-domain key. */
  readonly sessionId: string
  /** Incident identity copied from the delivered report. */
  readonly incidentId: AiopsIncidentId
  /** Revision of the incident report that was pushed. */
  readonly reportRevision: number
  /** Provider the payload was rendered for. */
  readonly provider: AiopsDeliveryProvider
  /** Terminal decision of the delivery burst. */
  readonly outcome: 'delivered' | 'failed'
  /** Bounded `code: message` of the last failure; absent when delivered. */
  readonly reason?: string
  /** Completion time of the burst in epoch milliseconds. */
  readonly deliveredAt: number
}
