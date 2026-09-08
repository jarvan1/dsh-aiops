import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RoutingSettings } from '@deepseek-ai/dsh-aiops-incident-router'
import type { ConnectionTestRequest, ConnectionTestResult, PortalSnapshot, RoutingPolicyDryRunRequest, RoutingPolicyDryRunResult, WebhookConfiguration } from '../types.ts'

export interface EndpointSettings {
  readonly baseUrl: string
}

export interface KubernetesSettings {
  readonly kubeconfig: string
  readonly context: string
}

export interface PortalViewInjected {
  loadSnapshot: (signal: AbortSignal) => Promise<PortalSnapshot>
  loadWebhookConfiguration: (signal?: AbortSignal) => Promise<WebhookConfiguration>
  testConnection: (request: ConnectionTestRequest, signal?: AbortSignal) => Promise<ConnectionTestResult>
  dryRunRoutingPolicy: (request: RoutingPolicyDryRunRequest, signal?: AbortSignal) => Promise<RoutingPolicyDryRunResult>
  prometheusSettings: SettingsScope<EndpointSettings>
  alertmanagerSettings: SettingsScope<EndpointSettings>
  kubernetesSettings: SettingsScope<KubernetesSettings>
  routingSettings: SettingsScope<RoutingSettings>
}
