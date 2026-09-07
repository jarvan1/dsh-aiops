/** Pure public types for the read-only Alertmanager query capability. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Optional filters for one current-alert query. */
export interface AlertmanagerAlertsRequest {
  /** Include active, non-suppressed alerts. */
  readonly active?: boolean
  /** Include alerts suppressed by silences. */
  readonly silenced?: boolean
  /** Include alerts suppressed by inhibition rules. */
  readonly inhibited?: boolean
  /** Include alerts that Alertmanager has not processed. */
  readonly unprocessed?: boolean
  /** Repeated Alertmanager label matcher expressions. */
  readonly filters?: readonly string[]
  /** Receiver-name regular expression. */
  readonly receiver?: string
  /** Repeated matcher expressions over receiver labels. */
  readonly receiverMatchers?: readonly string[]
}

/** Fully resolved query accepted by an Alertmanager Provider. */
export interface AlertmanagerAlertsSpec {
  /** Whether active alerts are included. */
  readonly active: boolean
  /** Whether silenced alerts are included. */
  readonly silenced: boolean
  /** Whether inhibited alerts are included. */
  readonly inhibited: boolean
  /** Whether unprocessed alerts are included. */
  readonly unprocessed: boolean
  /** Validated alert label matchers. */
  readonly filters: readonly string[]
  /** Validated receiver-name regular expression when supplied. */
  readonly receiver?: string
  /** Validated receiver-label matchers. */
  readonly receiverMatchers: readonly string[]
}

/** One detached Alertmanager API v2 alert object. */
export type AlertmanagerAlert = { readonly [key: string]: JsonValue }

/** Current Alertmanager alerts returned by the Provider. */
export type AlertmanagerAlertsResult = AlertmanagerAlert[]
