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

/** One exact label identity copied from an alert or target. */
export interface PrometheusLabelMatcher {
  /** Prometheus label name. */
  readonly name: string
  /** Exact label value. */
  readonly value: string
}

/** Bounded alert-rule lookup request. */
export interface PrometheusRulesRequest {
  /** Exact alerting-rule name, normally the alert's `alertname` label. */
  readonly alertName: string
  /** Optional exact alert labels used to compare candidate rule identities. */
  readonly labelMatchers?: readonly PrometheusLabelMatcher[]
  /** Optional Alertmanager-supplied generator URL; it is parsed locally and never fetched. */
  readonly generatorUrl?: string
  /** Maximum returned rules, capped by Provider configuration. */
  readonly limit?: number
}

/** Canonical alerting-rule evidence without active-alert payload expansion. */
export interface PrometheusRuleSummary {
  readonly name: string
  readonly query: string
  readonly duration?: number
  readonly keepFiringFor?: number
  readonly labels: Readonly<Record<string, string>>
  readonly annotations: Readonly<Record<string, string>>
  readonly health?: string
  readonly lastError?: string
  readonly evaluationTime?: number
  readonly lastEvaluation?: string
  readonly group: {
    readonly name: string
    readonly file: string
    readonly interval?: number
    readonly evaluationTime?: number
    readonly lastEvaluation?: string
  }
  /** Supplied alert labels that exactly match static labels on this rule. */
  readonly matchingLabels: readonly string[]
  /** Supplied alert labels that conflict with static, non-template rule labels. */
  readonly conflictingLabels: readonly string[]
}

/** Result of one alert-rule lookup. */
export interface PrometheusRulesResult {
  readonly alertName: string
  /** PromQL recovered locally from a trusted Prometheus generator URL, when present. */
  readonly generatorExpression?: string
  readonly rules: readonly PrometheusRuleSummary[]
  readonly truncated: boolean
}

/** Bounded target-health lookup request. */
export interface PrometheusTargetsRequest {
  /** Exact target-label filters. At least one filter or `scrapePool` is required. */
  readonly labelMatchers?: readonly PrometheusLabelMatcher[]
  /** Optional exact scrape-pool name. */
  readonly scrapePool?: string
  /** Target state to inspect. */
  readonly state?: 'active' | 'dropped' | 'any'
  /** Maximum returned targets, capped by Provider configuration. */
  readonly limit?: number
}

/** Canonical target-health evidence. */
export interface PrometheusTargetSummary {
  readonly state: 'active' | 'dropped'
  readonly labels: Readonly<Record<string, string>>
  readonly discoveredLabels: Readonly<Record<string, string>>
  readonly scrapePool?: string
  /** Scrape URL with credentials, query, and fragment removed. */
  readonly scrapeUrl?: string
  readonly globalUrl?: string
  readonly health?: string
  readonly lastError?: string
  readonly lastScrape?: string
  readonly lastScrapeDuration?: number
  readonly scrapeInterval?: string
  readonly scrapeTimeout?: string
}

/** Result of one target-health lookup. */
export interface PrometheusTargetsResult {
  readonly targets: readonly PrometheusTargetSummary[]
  readonly truncated: boolean
}

/** Supported bounded metadata discovery operation. */
export type PrometheusDiscoveryKind = 'series' | 'label_names' | 'label_values'

/** Bounded label or series discovery request. */
export interface PrometheusDiscoveryRequest {
  readonly kind: PrometheusDiscoveryKind
  /** One or more concrete Prometheus series selectors. */
  readonly matchers: readonly string[]
  /** Required only for `label_values`; standard Prometheus label names only. */
  readonly labelName?: string
  /** Inclusive absolute discovery-window start. */
  readonly start: string
  /** Inclusive absolute discovery-window end. */
  readonly end: string
  /** Maximum returned items, capped by Provider configuration. */
  readonly limit?: number
}

/** Canonical bounded metadata discovery result. */
export interface PrometheusDiscoveryResult {
  readonly kind: PrometheusDiscoveryKind
  readonly labelName?: string
  readonly items: readonly (string | Readonly<Record<string, string>>)[]
  readonly truncated: boolean
}
