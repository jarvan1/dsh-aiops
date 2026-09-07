/** Normalized Alertmanager webhook values delivered to AIOps routing rules. */

/** String labels or annotations detached from the provider payload. */
export type AlertmanagerStringMap = Readonly<Record<string, string>>

/** One normalized Alertmanager alert with a stable fingerprint. */
export interface AlertmanagerAlert {
  /** Alert lifecycle reported by Alertmanager. */
  readonly status: 'firing' | 'resolved'
  /** Provider labels, including `alertname`. */
  readonly labels: AlertmanagerStringMap
  /** Provider annotations safe for model context. */
  readonly annotations: AlertmanagerStringMap
  /** RFC3339 firing start time. */
  readonly startsAt: string
  /** RFC3339 resolution time, or Alertmanager's zero time while firing. */
  readonly endsAt: string
  /** Optional provider generator link. */
  readonly generatorUrl?: string
  /** Stable lowercase hexadecimal alert identity. */
  readonly fingerprint: string
  /** Whether Alertmanager supplied the fingerprint or the adapter derived it from sorted labels. */
  readonly fingerprintSource: 'provider' | 'labels-sha256'
}

/** Versioned, bounded Alertmanager delivery consumed by the incident router. */
export interface AlertmanagerWebhookEvent {
  /** Adapter event format. */
  readonly version: 1
  /** SHA-256 of the exact authenticated request body. */
  readonly payloadDigest: string
  /** Alertmanager group lifecycle. */
  readonly status: 'firing' | 'resolved'
  /** Target receiver name. */
  readonly receiver: string
  /** Alertmanager group identity. */
  readonly groupKey: string
  /** Count omitted by Alertmanager before this adapter received the batch. */
  readonly truncatedAlerts: number
  /** Group labels. */
  readonly groupLabels: AlertmanagerStringMap
  /** Labels common to the group. */
  readonly commonLabels: AlertmanagerStringMap
  /** Annotations common to the group. */
  readonly commonAnnotations: AlertmanagerStringMap
  /** Optional Alertmanager public link. */
  readonly externalUrl?: string
  /** Non-empty normalized alert batch. */
  readonly alerts: readonly AlertmanagerAlert[]
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    alertmanager: AlertmanagerWebhookEvent
  }
}
