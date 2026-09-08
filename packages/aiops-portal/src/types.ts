import type { AiopsIncidentState, AiopsOperatorFeedback } from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome, RouteAuditRecord } from '@deepseek-ai/dsh-aiops-incident-router'

export const PORTAL_API_PATH = '/api/aiops/portal'
export const PORTAL_CONNECTION_TEST_API_PATH = '/api/aiops/portal/connections/test'
export const PORTAL_WEBHOOK_CONFIGURATION_API_PATH = '/api/aiops/portal/webhook-configuration'

export interface WebhookConfiguration {
  readonly version: 1
  readonly url: string
  readonly secretConfigured: boolean
  readonly secret?: string
}

export type ConnectionTarget = 'prometheus' | 'alertmanager' | 'kubernetes'

export type ConnectionTestRequest =
  | { readonly target: 'prometheus' | 'alertmanager'; readonly baseUrl: string }
  | { readonly target: 'kubernetes'; readonly kubeconfig?: string; readonly context?: string }

export type ConnectionTestFailureCode =
  | 'invalid_url'
  | 'http_error'
  | 'invalid_response'
  | 'response_too_large'
  | 'timeout'
  | 'unreachable'
  | 'authentication_failed'
  | 'forbidden'
  | 'credential_exec_missing'
  | 'rbac_denied'
  | 'invalid_kubeconfig'

export type ConnectionTestResult =
  | {
    readonly ok: true
    readonly latencyMs: number
    readonly kubernetes?: {
      readonly context: string
      readonly cluster: string
      readonly namespace: string
      readonly server: string
    }
  }
  | {
    readonly ok: false
    readonly code: ConnectionTestFailureCode
    readonly latencyMs: number
    readonly status?: number
    readonly missingPermissions?: readonly string[]
  }

export interface PortalIncident {
  readonly sessionId: string
  readonly reportSeq: number
  readonly reportTime: number
  readonly incident: AiopsIncidentState
  readonly feedback?: {
    readonly seq: number
    readonly time: number
    readonly feedback: AiopsOperatorFeedback
  }
  readonly lastRoute?: RouteAuditRecord
}

export interface PortalSummary {
  readonly totalIncidents: number
  readonly active: number
  readonly critical: number
  readonly reviewed: number
  readonly confirmed: number
  readonly corrected: number
  readonly rejected: number
  readonly audit: Readonly<Partial<Record<RouteAuditOutcome, number>>>
}

export interface PortalSnapshot {
  readonly version: 1
  readonly workspace: string
  readonly generatedAt: number
  readonly summary: PortalSummary
  readonly incidents: PortalIncident[]
  readonly audit: RouteAuditRecord[]
}
