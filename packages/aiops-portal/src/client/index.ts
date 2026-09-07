import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { en, NS, zh } from './locales.ts'
import type { EndpointSettings, PortalViewInjected } from './contracts.ts'
import { AIOpsSidebarAction } from './AIOpsSidebarAction.tsx'
import { fetchPortalSnapshot, fetchPortalConnectionTest, PortalView } from './PortalView.tsx'

export const inject = ['slots', 'locale', 'settingsScope']

function endpointSettings(value: unknown): EndpointSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const baseUrl = Reflect.get(value, 'baseUrl')
  return typeof baseUrl === 'string' ? { baseUrl } : undefined
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aiops-portal: dictionaries')
  const t = ctx.locale.bind(NS)
  const prometheusSettings: SettingsScope<EndpointSettings> = ctx.settingsScope.bind({
    namespace: 'aiops-prometheus',
    decode: endpointSettings,
  })
  const alertmanagerSettings: SettingsScope<EndpointSettings> = ctx.settingsScope.bind({
    namespace: 'aiops-alertmanager',
    decode: endpointSettings,
  })
  const injectPortal = (): PortalViewInjected => ({
    loadSnapshot: fetchPortalSnapshot,
    testConnection: fetchPortalConnectionTest,
    prometheusSettings,
    alertmanagerSettings,
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'aiops',
    order: 20,
    locale: NS,
    label: () => t('view.portal'),
    inject: injectPortal,
  }, PortalView))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'aiops',
    order: 10,
    locale: NS,
    label: () => t('entry'),
    inject: injectPortal,
  }, AIOpsSidebarAction))
}
