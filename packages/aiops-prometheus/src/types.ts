/** Pure public types for the read-only Prometheus query seam. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One Prometheus instant-query request. */
export interface PrometheusInstantQuery {
  /** PromQL expression. */
  readonly query: string
  /** Optional evaluation time accepted by the Prometheus HTTP API. */
  readonly time?: string
}

/** One Prometheus range-query request. */
export interface PrometheusRangeQuery {
  /** PromQL expression. */
  readonly query: string
  /** Inclusive range start accepted by the Prometheus HTTP API. */
  readonly start: string
  /** Inclusive range end accepted by the Prometheus HTTP API. */
  readonly end: string
  /** Query resolution accepted by the Prometheus HTTP API. */
  readonly step: string
}

/** Normalized successful Prometheus query data. */
export interface PrometheusQueryResult {
  /** Prometheus result discriminator. */
  readonly resultType: 'matrix' | 'vector' | 'scalar' | 'string'
  /** Provider-returned samples or scalar/string pair as lossless JSON. */
  readonly result: JsonValue
}
