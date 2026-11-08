import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { en, NS, zh } from './locales.ts'
import type { EndpointSettings, KubernetesSettings, PortalViewInjected, RouterPolicySettings } from './contracts.ts'
import { AIOpsSidebarAction } from './AIOpsSidebarAction.tsx'
import { fetchPortalSnapshot, fetchPortalConnectionTest, fetchRoutingPolicyDryRun, fetchWebhookConfiguration, PortalView } from './PortalView.tsx'

export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aiops-portal: dictionaries')
  const t = ctx.locale.bind(NS)
  // DSH 0.2.x settings namespaces are profile plugin entry ids, so each form
  // binds the entry whose Config carries these fields; `configForms.get` reads
  // through the shared describe mirror and writes with a revision fence.
  const prometheusSettings: ConfigForm<EndpointSettings> = ctx.configForms.get<EndpointSettings>('aiops-prometheus')
  const alertmanagerSettings: ConfigForm<EndpointSettings> = ctx.configForms.get<EndpointSettings>('aiops-alertmanager')
  const kubernetesSettingsScope: ConfigForm<KubernetesSettings> = ctx.configForms.get<KubernetesSettings>('aiops-kubernetes')
  const routingSettingsScope: ConfigForm<RouterPolicySettings> = ctx.configForms.get<RouterPolicySettings>('aiops-incident-router')
  const injectPortal = (): PortalViewInjected => ({
    loadSnapshot: fetchPortalSnapshot,
    loadWebhookConfiguration: fetchWebhookConfiguration,
    testConnection: fetchPortalConnectionTest,
    dryRunRoutingPolicy: fetchRoutingPolicyDryRun,
    prometheusSettings,
    alertmanagerSettings,
    kubernetesSettings: kubernetesSettingsScope,
    routingSettings: routingSettingsScope,
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
