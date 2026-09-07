import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionTarget, ConnectionTestFailureCode } from '../types.ts'
import type { PortalViewInjected } from './contracts.ts'
import css from './portal.module.css'

type Props = Pick<PortalViewInjected, 'testConnection' | 'prometheusSettings' | 'alertmanagerSettings'>
  & PropsLocale<'aiops-portal'>

type TestState =
  | { readonly status: 'idle' }
  | { readonly status: 'testing'; readonly testedUrl: string }
  | { readonly status: 'passed'; readonly testedUrl: string; readonly latencyMs: number }
  | { readonly status: 'failed'; readonly testedUrl: string; readonly code: ConnectionTestFailureCode; readonly httpStatus?: number }

const IDLE_TEST: TestState = { status: 'idle' }

function validEndpoint(value: string): boolean {
  if (value === '') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === ''
      && url.search === '' && url.hash === ''
  } catch {
    return false
  }
}

function failureMessage(state: Extract<TestState, { status: 'failed' }>, t: Props['t']): string {
  if (state.code === 'http_error' && state.httpStatus !== undefined) {
    return t('connectionHttpError', { status: state.httpStatus })
  }
  const key = {
    invalid_url: 'connectionInvalidUrl',
    http_error: 'connectionFailed',
    invalid_response: 'connectionInvalidResponse',
    response_too_large: 'connectionResponseTooLarge',
    timeout: 'connectionTimeout',
    unreachable: 'connectionUnreachable',
  }[state.code] as 'connectionInvalidUrl' | 'connectionFailed' | 'connectionInvalidResponse'
    | 'connectionResponseTooLarge' | 'connectionTimeout' | 'connectionUnreachable'
  return t(key)
}

function ConnectionStatus({ state, currentUrl, t }: { state: TestState; currentUrl: string; t: Props['t'] }) {
  if (state.status === 'idle' || state.testedUrl !== currentUrl) return <span>{t('connectionUntested')}</span>
  if (state.status === 'testing') return <span>{t('connectionTesting')}</span>
  if (state.status === 'passed') return <span className={css.testPassed}>{t('connectionPassed', { latency: state.latencyMs })}</span>
  return <span className={css.testFailed}>{failureMessage(state, t)}</span>
}

export function ConnectionSettings({ testConnection, prometheusSettings, alertmanagerSettings, t }: Props) {
  const prometheus = useSyncExternalStore(
    listener => prometheusSettings.subscribe(listener),
    () => prometheusSettings.getSnapshot(),
  )
  const alertmanager = useSyncExternalStore(
    listener => alertmanagerSettings.subscribe(listener),
    () => alertmanagerSettings.getSnapshot(),
  )
  const [prometheusUrl, setPrometheusUrl] = useState('')
  const [alertmanagerUrl, setAlertmanagerUrl] = useState('')
  const [dirty, setDirty] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [prometheusTest, setPrometheusTest] = useState<TestState>(IDLE_TEST)
  const [alertmanagerTest, setAlertmanagerTest] = useState<TestState>(IDLE_TEST)

  useEffect(() => {
    if (dirty || prometheus.status !== 'ready' || alertmanager.status !== 'ready') return
    setPrometheusUrl(prometheus.value?.baseUrl ?? '')
    setAlertmanagerUrl(alertmanager.value?.baseUrl ?? '')
    setInitialized(true)
  }, [alertmanager.status, alertmanager.value, dirty, prometheus.status, prometheus.value])

  const writable = initialized && prometheus.writable && alertmanager.writable
  const nextPrometheus = prometheusUrl.trim()
  const nextAlertmanager = alertmanagerUrl.trim()
  const valid = validEndpoint(nextPrometheus) && validEndpoint(nextAlertmanager)
  const tested = prometheusTest.status === 'passed' && prometheusTest.testedUrl === nextPrometheus
    && alertmanagerTest.status === 'passed' && alertmanagerTest.testedUrl === nextAlertmanager
  const unavailable = prometheus.status === 'unavailable' || alertmanager.status === 'unavailable'

  const runTest = async (target: ConnectionTarget): Promise<void> => {
    const baseUrl = target === 'prometheus' ? nextPrometheus : nextAlertmanager
    if (!validEndpoint(baseUrl)) return
    const setState = target === 'prometheus' ? setPrometheusTest : setAlertmanagerTest
    setSaveState('idle')
    setState({ status: 'testing', testedUrl: baseUrl })
    try {
      const result = await testConnection(target, baseUrl)
      setState(result.ok
        ? { status: 'passed', testedUrl: baseUrl, latencyMs: result.latencyMs }
        : { status: 'failed', testedUrl: baseUrl, code: result.code, ...(result.status === undefined ? {} : { httpStatus: result.status }) })
    } catch {
      setState({ status: 'failed', testedUrl: baseUrl, code: 'unreachable' })
    }
  }

  const save = async (): Promise<void> => {
    if (!writable || !dirty || !valid || !tested) return
    setSaveState('saving')
    try {
      await Promise.all([
        prometheusSettings.set('baseUrl', nextPrometheus),
        alertmanagerSettings.set('baseUrl', nextAlertmanager),
      ])
      const storedPrometheus = prometheusSettings.getSnapshot().value?.baseUrl
      const storedAlertmanager = alertmanagerSettings.getSnapshot().value?.baseUrl
      if (storedPrometheus !== nextPrometheus || storedAlertmanager !== nextAlertmanager) {
        throw new Error('settings write was rejected')
      }
      setDirty(false)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }

  return <section className={css.settingsPanel}>
    <div className={css.settingsIntro}>
      <div>
        <div className={css.eyebrow}>{t('settings')}</div>
        <h2>{t('settingsTitle')}</h2>
        <p>{t('settingsDescription')}</p>
      </div>
      <div className={css.liveBadge}><span />LIVE</div>
    </div>
    <div className={css.endpointGrid}>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-prometheus-url"><span className={css.serviceDot}/>{t('prometheusUrl')}</label>
        <input
          id="aiops-prometheus-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          value={prometheusUrl}
          placeholder={t('prometheusHint')}
          aria-invalid={!validEndpoint(prometheusUrl.trim())}
          onChange={(event) => {
            setPrometheusUrl(event.target.value)
            setDirty(true)
            setSaveState('idle')
            setPrometheusTest(IDLE_TEST)
          }}
        />
        <div className={css.testRow}>
          <ConnectionStatus state={prometheusTest} currentUrl={nextPrometheus} t={t}/>
          <button type="button" disabled={!validEndpoint(nextPrometheus) || prometheusTest.status === 'testing'} onClick={() => { void runTest('prometheus') }}>
            {prometheusTest.status === 'testing' ? t('connectionTesting') : t('testConnection')}
          </button>
        </div>
      </div>
      <div className={css.endpointCard}>
        <label className={css.endpointTitle} htmlFor="aiops-alertmanager-url"><span className={`${css.serviceDot} ${css.alertDot}`}/>{t('alertmanagerUrl')}</label>
        <input
          id="aiops-alertmanager-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          value={alertmanagerUrl}
          placeholder={t('alertmanagerHint')}
          aria-invalid={!validEndpoint(alertmanagerUrl.trim())}
          onChange={(event) => {
            setAlertmanagerUrl(event.target.value)
            setDirty(true)
            setSaveState('idle')
            setAlertmanagerTest(IDLE_TEST)
          }}
        />
        <div className={css.testRow}>
          <ConnectionStatus state={alertmanagerTest} currentUrl={nextAlertmanager} t={t}/>
          <button type="button" disabled={!validEndpoint(nextAlertmanager) || alertmanagerTest.status === 'testing'} onClick={() => { void runTest('alertmanager') }}>
            {alertmanagerTest.status === 'testing' ? t('connectionTesting') : t('testConnection')}
          </button>
        </div>
      </div>
    </div>
    <div className={css.settingsFooter}>
      <div>
        <p>{t('urlRule')}</p>
        <div className={css.saveMessage} aria-live="polite">
          {unavailable ? t('settingsUnavailable') : saveState === 'saved' ? t('saved') : saveState === 'error' ? t('saveError') : !tested && dirty ? t('testRequired') : ''}
        </div>
      </div>
      <button type="button" disabled={!writable || !dirty || !valid || !tested || saveState === 'saving'} onClick={() => { void save() }}>
        {saveState === 'saving' ? t('saving') : t('save')}
      </button>
    </div>
  </section>
}
