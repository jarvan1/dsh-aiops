import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionTestRequest, ConnectionTestResult, PortalSnapshot, WebhookConfiguration } from '../types.ts'

export interface EndpointSettings {
  readonly baseUrl: string
}

export interface KubernetesSettings {
  readonly kubeconfig: string
  readonly context: string
}

export interface PortalViewInjected {
  loadSnapshot: (signal: AbortSignal) => Promise<PortalSnapshot>
  loadWebhookConfiguration: (revealSecret: boolean, signal?: AbortSignal) => Promise<WebhookConfiguration>
  testConnection: (request: ConnectionTestRequest, signal?: AbortSignal) => Promise<ConnectionTestResult>
  prometheusSettings: SettingsScope<EndpointSettings>
  alertmanagerSettings: SettingsScope<EndpointSettings>
  kubernetesSettings: SettingsScope<KubernetesSettings>
}
