import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RoutingSettings } from '@deepseek-ai/dsh-aiops-incident-router'
import type {
  ClusterProbeResult,
  ConnectionTestRequest,
  ConnectionTestResult,
  PortalCluster,
  PortalClusterToken,
  PortalSnapshot,
  RoutingPolicyDryRunRequest,
  RoutingPolicyDryRunResult,
  WebhookConfiguration,
} from '../types.ts'

export interface EndpointSettings {
  readonly baseUrl: string
}

/** DSH 0.2.x serves policy fields through the router plugin entry's Config. */
export type RouterPolicySettings = Omit<RoutingSettings, 'version'>

/** Cluster-agent operations. Only `create`/`reissue` ever return a plaintext token. */
export interface ClusterActions {
  createCluster: (name: string, signal?: AbortSignal) => Promise<PortalClusterToken>
  reissueClusterToken: (name: string, signal?: AbortSignal) => Promise<PortalClusterToken>
  revokeCluster: (name: string, signal?: AbortSignal) => Promise<PortalCluster>
  probeCluster: (name: string, signal?: AbortSignal) => Promise<ClusterProbeResult>
}

export interface PortalViewInjected {
  loadSnapshot: (signal: AbortSignal) => Promise<PortalSnapshot>
  loadWebhookConfiguration: (signal?: AbortSignal) => Promise<WebhookConfiguration>
  testConnection: (request: ConnectionTestRequest, signal?: AbortSignal) => Promise<ConnectionTestResult>
  dryRunRoutingPolicy: (request: RoutingPolicyDryRunRequest, signal?: AbortSignal) => Promise<RoutingPolicyDryRunResult>
  clusterActions: ClusterActions
  prometheusSettings: ConfigForm<EndpointSettings>
  alertmanagerSettings: ConfigForm<EndpointSettings>
  routingSettings: ConfigForm<RouterPolicySettings>
}
