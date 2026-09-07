/** Durable AIOps alert routing events written to diagnostic Sessions. */

import type { AlertmanagerAlert, AlertmanagerStringMap } from '@deepseek-ai/dsh-webhook-alertmanager'
import type { AcceptedRouteDecision } from './store.ts'

/** Deployment policy used to derive a replay-stable observation window. */
export interface DiagnosisWindowPolicy {
  readonly beforeSeconds: number
  readonly afterSeconds: number
  readonly prometheusStepSeconds: number
  readonly logTailLines: number
}

/** Model/tool-ready absolute time parameters derived from one alert occurrence. */
export interface AiopsDiagnosisTimeContext {
  readonly version: 1
  readonly anchor: {
    readonly source: 'alert.startsAt'
    readonly time: string
    readonly epochMs: number
  }
  readonly window: {
    readonly start: string
    readonly end: string
    readonly beforeSeconds: number
    readonly afterSeconds: number
  }
  readonly prometheusQueryRange: {
    readonly start: string
    readonly end: string
    readonly step: string
  }
  readonly kubernetesEvents: {
    readonly since_time: string
    readonly until_time: string
  }
  readonly kubernetesLogs: {
    readonly since_time: string
    readonly until_time: string
    readonly tail_lines: number
    readonly timestamps: true
  }
}

/** Group facts needed to interpret a routed Alertmanager alert. */
export interface AlertmanagerGroupContext {
  readonly status: 'firing' | 'resolved'
  readonly receiver: string
  readonly groupKey: string
  readonly truncatedAlerts: number
  readonly groupLabels: AlertmanagerStringMap
  readonly commonLabels: AlertmanagerStringMap
  readonly commonAnnotations: AlertmanagerStringMap
  readonly externalUrl?: string
}

/** One accepted route decision and the normalized alert that caused it. */
export interface AiopsAlertRouteEvent {
  readonly version: 2
  readonly source: string
  readonly deliveryId: string
  readonly payloadDigest: string
  readonly receivedAt: number
  readonly fingerprint: string
  readonly round: number
  readonly sessionId: string
  readonly decision: AcceptedRouteDecision
  readonly severity: 'info' | 'warning' | 'critical'
  readonly diagnosis: AiopsDiagnosisTimeContext
  readonly group: AlertmanagerGroupContext
  readonly alert: AlertmanagerAlert
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Accepted Alertmanager route decision and exact normalized alert facts. */
    'aiops/alert-routed': AiopsAlertRouteEvent
  }
}
