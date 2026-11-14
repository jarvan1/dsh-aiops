import type { AgentCapabilities, AgentClusterView, AgentQueryErrorCode } from '@deepseek-ai/dsh-aiops-agents'
import type { AiopsIncidentState, AiopsOperatorFeedback } from '@deepseek-ai/dsh-aiops-incident'
import type {
  RouteAuditOutcome,
  RouteAuditRecord,
  RoutingPolicyAuditRecord,
  RoutingPolicyEvaluation,
  RoutingSettings,
} from '@deepseek-ai/dsh-aiops-incident-router'

export const PORTAL_API_PATH = '/api/aiops/portal'
export const PORTAL_CONNECTION_TEST_API_PATH = '/api/aiops/portal/connections/test'
export const PORTAL_WEBHOOK_CONFIGURATION_API_PATH = '/api/aiops/portal/webhook-configuration'
export const PORTAL_ROUTING_POLICY_DRY_RUN_API_PATH = '/api/aiops/portal/routing-policy/dry-run'
export const PORTAL_CLUSTERS_API_PATH = '/api/aiops/portal/clusters'
export const PORTAL_CLUSTER_TOKEN_API_PATH = '/api/aiops/portal/clusters/token'
export const PORTAL_CLUSTER_REVOKE_API_PATH = '/api/aiops/portal/clusters/revoke'
export const PORTAL_CLUSTER_PROBE_API_PATH = '/api/aiops/portal/clusters/probe'

/** One registered cluster, as the Portal may display it (never the token). */
export type PortalCluster = AgentClusterView

/** Response to issuing or re-issuing a token; the plaintext is shown once. */
export interface PortalClusterToken {
  readonly cluster: PortalCluster
  readonly token: string
}

/** Result of probing one connected agent. */
export type ClusterProbeResult =
  | {
    readonly ok: true
    readonly latencyMs: number
    readonly agent: {
      readonly name: string
      readonly version: string
      readonly protocol: number
      readonly capabilities: AgentCapabilities
    }
  }
  | {
    readonly ok: false
    readonly code: AgentQueryErrorCode | 'not_found'
    readonly latencyMs: number
  }

/** GET /clusters response; `needsCluster` drives the first-run prompt. */
export interface PortalClusters {
  readonly version: 1
  readonly clusters: PortalCluster[]
  readonly needsCluster: boolean
}

export interface WebhookConfiguration {
  readonly version: 2
  readonly url: string
  readonly secretConfigured: boolean
}

export interface RoutingPolicyDryRunRequest {
  readonly labels: Readonly<Record<string, string>>
  readonly settings: RoutingSettings
}

export type RoutingPolicyDryRunResult = RoutingPolicyEvaluation

export type ConnectionTarget = 'prometheus' | 'alertmanager'

export type ConnectionTestRequest = { readonly target: ConnectionTarget; readonly baseUrl: string }

export type ConnectionTestFailureCode =
  | 'invalid_url'
  | 'http_error'
  | 'invalid_response'
  | 'response_too_large'
  | 'timeout'
  | 'unreachable'
  | 'authentication_failed'
  | 'forbidden'

export type ConnectionTestResult =
  | { readonly ok: true; readonly latencyMs: number }
  | {
    readonly ok: false
    readonly code: ConnectionTestFailureCode
    readonly latencyMs: number
    readonly status?: number
  }

export interface PortalIncident {
  readonly sessionId: string
  readonly revision: number
  readonly updatedAt: number
  readonly incident: AiopsIncidentState
  readonly feedback?: {
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
  readonly version: 4
  readonly workspace: string
  readonly generatedAt: number
  readonly summary: PortalSummary
  readonly incidents: PortalIncident[]
  readonly audit: RouteAuditRecord[]
  readonly routingSettings: RoutingSettings
  readonly routingPolicyAudit: RoutingPolicyAuditRecord[]
  /** Registered cluster agents; empty before the first token is issued. */
  readonly clusters: PortalCluster[]
  /** True while no non-revoked cluster exists; the home view prompts onboarding. */
  readonly needsCluster: boolean
}
