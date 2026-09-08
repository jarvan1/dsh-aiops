import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionTarget, ConnectionTestFailureCode, ConnectionTestRequest } from '../types.ts'
import type { PortalViewInjected } from './contracts.ts'
import css from './portal.module.css'

type Props = Pick<PortalViewInjected, 'loadWebhookConfiguration' | 'testConnection' | 'prometheusSettings' | 'alertmanagerSettings' | 'kubernetesSettings'> & PropsLocale<'aiops-portal'>
type TestState =
  | { readonly status: 'idle' }
  | { readonly status: 'testing'; readonly testedValue: string }
  | { readonly status: 'passed'; readonly testedValue: string; readonly latencyMs: number; readonly detail?: string }
  | { readonly status: 'failed'; readonly testedValue: string; readonly code: ConnectionTestFailureCode; readonly httpStatus?: number; readonly missingPermissions?: readonly string[] }
const IDLE_TEST: TestState = { status: 'idle' }

function validEndpoint(value: string): boolean {
  if (value === '') return false
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '' } catch { return false }
}
function validKubernetes(kubeconfig: string, context: string): boolean { return kubeconfig.length <= 2048 && context.length <= 512 && !kubeconfig.includes('\n') && !context.includes('\n') }
function kubernetesKey(kubeconfig: string, context: string): string { return `${kubeconfig}\u0000${context}` }

function failureMessage(state: Extract<TestState, { status: 'failed' }>, t: Props['t']): string {
  if (state.code === 'http_error' && state.httpStatus !== undefined) return t('connectionHttpError', { status: state.httpStatus })
  if (state.code === 'rbac_denied') return t('connectionRbacDenied', { permissions: state.missingPermissions?.join(', ') ?? '' })
  const key = {
    invalid_url: 'connectionInvalidUrl', http_error: 'connectionFailed', invalid_response: 'connectionInvalidResponse', response_too_large: 'connectionResponseTooLarge',
    timeout: 'connectionTimeout', unreachable: 'connectionUnreachable', authentication_failed: 'connectionAuthenticationFailed', forbidden: 'connectionForbidden',
    credential_exec_missing: 'connectionCredentialExecMissing', rbac_denied: 'connectionRbacDenied', invalid_kubeconfig: 'connectionInvalidKubeconfig',
  }[state.code] as 'connectionInvalidUrl'
  return t(key)
}
function ConnectionStatus({ state, currentValue, t }: { state: TestState; currentValue: string; t: Props['t'] }) {
  if (state.status === 'idle' || state.testedValue !== currentValue) return <span>{t('connectionUntested')}</span>
  if (state.status === 'testing') return <span>{t('connectionTesting')}</span>
  if (state.status === 'passed') return <span className={css.testPassed}>{state.detail ?? t('connectionPassed', { latency: state.latencyMs })}</span>
  return <span className={css.testFailed}>{failureMessage(state, t)}</span>
}

export function ConnectionSettings({ loadWebhookConfiguration, testConnection, prometheusSettings, alertmanagerSettings, kubernetesSettings, t }: Props) {
  const prometheus = useSyncExternalStore(listener => prometheusSettings.subscribe(listener), () => prometheusSettings.getSnapshot())
  const alertmanager = useSyncExternalStore(listener => alertmanagerSettings.subscribe(listener), () => alertmanagerSettings.getSnapshot())
  const kubernetes = useSyncExternalStore(listener => kubernetesSettings.subscribe(listener), () => kubernetesSettings.getSnapshot())
  const [prometheusUrl, setPrometheusUrl] = useState(''); const [alertmanagerUrl, setAlertmanagerUrl] = useState('')
  const [kubeconfig, setKubeconfig] = useState(''); const [context, setContext] = useState('')
  const [dirty, setDirty] = useState(false); const [initialized, setInitialized] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [prometheusTest, setPrometheusTest] = useState<TestState>(IDLE_TEST); const [alertmanagerTest, setAlertmanagerTest] = useState<TestState>(IDLE_TEST); const [kubernetesTest, setKubernetesTest] = useState<TestState>(IDLE_TEST)
  const [webhook, setWebhook] = useState<{ readonly url: string; readonly secretConfigured: boolean }>()
  const [webhookState, setWebhookState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    void loadWebhookConfiguration(controller.signal).then(value => {
      setWebhook(value); setWebhookState('ready')
    }).catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setWebhookState('error')
    })
    return () => controller.abort()
  }, [loadWebhookConfiguration])

  useEffect(() => {
    if (dirty || prometheus.status !== 'ready' || alertmanager.status !== 'ready' || kubernetes.status !== 'ready') return
    setPrometheusUrl(prometheus.value?.baseUrl ?? ''); setAlertmanagerUrl(alertmanager.value?.baseUrl ?? '')
    setKubeconfig(kubernetes.value?.kubeconfig ?? ''); setContext(kubernetes.value?.context ?? ''); setInitialized(true)
  }, [alertmanager.status, alertmanager.value, dirty, kubernetes.status, kubernetes.value, prometheus.status, prometheus.value])

  const writable = initialized && prometheus.writable && alertmanager.writable && kubernetes.writable
  const nextPrometheus = prometheusUrl.trim(); const nextAlertmanager = alertmanagerUrl.trim(); const nextKubeconfig = kubeconfig.trim(); const nextContext = context.trim(); const nextKubernetes = kubernetesKey(nextKubeconfig, nextContext)
  const valid = validEndpoint(nextPrometheus) && validEndpoint(nextAlertmanager) && validKubernetes(nextKubeconfig, nextContext)
  const tested = prometheusTest.status === 'passed' && prometheusTest.testedValue === nextPrometheus && alertmanagerTest.status === 'passed' && alertmanagerTest.testedValue === nextAlertmanager && kubernetesTest.status === 'passed' && kubernetesTest.testedValue === nextKubernetes
  const unavailable = prometheus.status === 'unavailable' || alertmanager.status === 'unavailable' || kubernetes.status === 'unavailable'

  const runTest = async (target: ConnectionTarget): Promise<void> => {
    const isKubernetes = target === 'kubernetes'; const testedValue = isKubernetes ? nextKubernetes : target === 'prometheus' ? nextPrometheus : nextAlertmanager
    if (isKubernetes ? !validKubernetes(nextKubeconfig, nextContext) : !validEndpoint(testedValue)) return
    const setState = target === 'prometheus' ? setPrometheusTest : target === 'alertmanager' ? setAlertmanagerTest : setKubernetesTest
    const request: ConnectionTestRequest = isKubernetes ? { target, kubeconfig: nextKubeconfig, context: nextContext } : { target, baseUrl: testedValue }
    setSaveState('idle'); setState({ status: 'testing', testedValue })
    try {
      const result = await testConnection(request)
      setState(result.ok ? { status: 'passed', testedValue, latencyMs: result.latencyMs, ...(result.kubernetes === undefined ? {} : { detail: t('connectionKubernetesPassed', { context: result.kubernetes.context, namespace: result.kubernetes.namespace, latency: result.latencyMs }) }) } : { status: 'failed', testedValue, code: result.code, ...(result.status === undefined ? {} : { httpStatus: result.status }), ...(result.missingPermissions === undefined ? {} : { missingPermissions: result.missingPermissions }) })
    } catch { setState({ status: 'failed', testedValue, code: 'unreachable' }) }
  }

  const save = async (): Promise<void> => {
    if (!writable || !dirty || !valid || !tested) return
    setSaveState('saving')
    try {
      await Promise.all([prometheusSettings.set('baseUrl', nextPrometheus), alertmanagerSettings.set('baseUrl', nextAlertmanager), kubernetesSettings.set('kubeconfig', nextKubeconfig), kubernetesSettings.set('context', nextContext)])
      if (prometheusSettings.getSnapshot().value?.baseUrl !== nextPrometheus || alertmanagerSettings.getSnapshot().value?.baseUrl !== nextAlertmanager || kubernetesSettings.getSnapshot().value?.kubeconfig !== nextKubeconfig || kubernetesSettings.getSnapshot().value?.context !== nextContext) throw new Error('settings write was rejected')
      setDirty(false); setSaveState('saved')
    } catch { setSaveState('error') }
  }
  const edit = (reset: (state: TestState) => void) => { setDirty(true); setSaveState('idle'); reset(IDLE_TEST) }
  return <section className={css.settingsPanel}>
    <div className={css.settingsIntro}><div><div className={css.eyebrow}>{t('settings')}</div><h2>{t('settingsTitle')}</h2><p>{t('settingsDescription')}</p></div><div className={css.liveBadge}><span/>LIVE</div></div>
    <div className={css.endpointGrid}>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-prometheus-url"><span className={css.serviceDot}/>{t('prometheusUrl')}</label>
        <input id="aiops-prometheus-url" type="url" inputMode="url" autoComplete="url" value={prometheusUrl} placeholder={t('prometheusHint')} aria-invalid={!validEndpoint(prometheusUrl.trim())} onChange={event => { setPrometheusUrl(event.target.value); edit(setPrometheusTest) }}/>
        <div className={css.testRow}><ConnectionStatus state={prometheusTest} currentValue={nextPrometheus} t={t}/><button type="button" disabled={!validEndpoint(nextPrometheus) || prometheusTest.status === 'testing'} onClick={() => { void runTest('prometheus') }}>{prometheusTest.status === 'testing' ? t('connectionTesting') : t('testConnection')}</button></div>
      </div>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-alertmanager-url"><span className={`${css.serviceDot} ${css.alertDot}`}/>{t('alertmanagerUrl')}</label>
        <input id="aiops-alertmanager-url" type="url" inputMode="url" autoComplete="url" value={alertmanagerUrl} placeholder={t('alertmanagerHint')} aria-invalid={!validEndpoint(alertmanagerUrl.trim())} onChange={event => { setAlertmanagerUrl(event.target.value); edit(setAlertmanagerTest) }}/>
        <div className={css.testRow}><ConnectionStatus state={alertmanagerTest} currentValue={nextAlertmanager} t={t}/><button type="button" disabled={!validEndpoint(nextAlertmanager) || alertmanagerTest.status === 'testing'} onClick={() => { void runTest('alertmanager') }}>{alertmanagerTest.status === 'testing' ? t('connectionTesting') : t('testConnection')}</button></div>
      </div>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-kubeconfig"><span className={css.serviceDot}/>{t('kubeconfigPath')}</label>
        <input id="aiops-kubeconfig" type="text" autoComplete="off" value={kubeconfig} placeholder={t('kubeconfigHint')} aria-invalid={!validKubernetes(nextKubeconfig, nextContext)} onChange={event => { setKubeconfig(event.target.value); edit(setKubernetesTest) }}/>
        <label className={css.endpointTitle} htmlFor="aiops-kubernetes-context">{t('kubernetesContext')}</label>
        <input id="aiops-kubernetes-context" type="text" autoComplete="off" value={context} placeholder={t('kubernetesContextHint')} onChange={event => { setContext(event.target.value); edit(setKubernetesTest) }}/>
        <div className={css.testRow}><ConnectionStatus state={kubernetesTest} currentValue={nextKubernetes} t={t}/><button type="button" disabled={!validKubernetes(nextKubeconfig, nextContext) || kubernetesTest.status === 'testing'} onClick={() => { void runTest('kubernetes') }}>{kubernetesTest.status === 'testing' ? t('connectionTesting') : t('testConnection')}</button></div>
      </div>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-webhook-url"><span className={`${css.serviceDot} ${css.alertDot}`}/>{t('webhookUrl')}</label>
        <input id="aiops-webhook-url" type="url" readOnly value={webhook?.url ?? ''} placeholder={webhookState === 'loading' ? t('webhookLoading') : ''}/>
        <label className={css.endpointTitle} htmlFor="aiops-webhook-secret">{t('webhookSecret')}</label>
        <input id="aiops-webhook-secret" type="text" readOnly autoComplete="off" value="" placeholder={webhook?.secretConfigured === true ? t('secretConfigured') : t('secretUnavailable')}/>
        <div className={webhookState === 'error' ? css.testFailed : css.webhookHint}>{webhookState === 'error' ? t('webhookLoadError') : t('webhookReadOnly')}</div>
      </div>
    </div>
    <div className={css.settingsFooter}><div><p>{t('settingsRule')}</p><div className={css.saveMessage} aria-live="polite">{unavailable ? t('settingsUnavailable') : saveState === 'saved' ? t('saved') : saveState === 'error' ? t('saveError') : !tested && dirty ? t('testRequired') : ''}</div></div><button type="button" disabled={!writable || !dirty || !valid || !tested || saveState === 'saving'} onClick={() => { void save() }}>{saveState === 'saving' ? t('saving') : t('save')}</button></div>
  </section>
}
