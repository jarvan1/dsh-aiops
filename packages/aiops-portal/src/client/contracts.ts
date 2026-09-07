import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionTarget, ConnectionTestResult, PortalSnapshot } from '../types.ts'

export interface EndpointSettings {
  readonly baseUrl: string
}

export interface PortalViewInjected {
  loadSnapshot: (signal: AbortSignal) => Promise<PortalSnapshot>
  testConnection: (target: ConnectionTarget, baseUrl: string, signal?: AbortSignal) => Promise<ConnectionTestResult>
  prometheusSettings: SettingsScope<EndpointSettings>
  alertmanagerSettings: SettingsScope<EndpointSettings>
}
