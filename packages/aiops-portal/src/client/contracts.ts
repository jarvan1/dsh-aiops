import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RoutingSettings } from '@deepseek-ai/dsh-aiops-incident-router'
import type { ConnectionTestRequest, ConnectionTestResult, PortalSnapshot, RoutingPolicyDryRunRequest, RoutingPolicyDryRunResult, WebhookConfiguration } from '../types.ts'

export interface EndpointSettings {
  readonly baseUrl: string
}

export interface KubernetesSettings {
  readonly kubeconfig: string
  readonly context: string
}

/** DSH 0.2.x serves policy fields through the router plugin entry's Config. */
export type RouterPolicySettings = Omit<RoutingSettings, 'version'>

export interface PortalViewInjected {
  loadSnapshot: (signal: AbortSignal) => Promise<PortalSnapshot>
  loadWebhookConfiguration: (signal?: AbortSignal) => Promise<WebhookConfiguration>
  testConnection: (request: ConnectionTestRequest, signal?: AbortSignal) => Promise<ConnectionTestResult>
  dryRunRoutingPolicy: (request: RoutingPolicyDryRunRequest, signal?: AbortSignal) => Promise<RoutingPolicyDryRunResult>
  prometheusSettings: ConfigForm<EndpointSettings>
  alertmanagerSettings: ConfigForm<EndpointSettings>
  kubernetesSettings: ConfigForm<KubernetesSettings>
  routingSettings: ConfigForm<RouterPolicySettings>
}
