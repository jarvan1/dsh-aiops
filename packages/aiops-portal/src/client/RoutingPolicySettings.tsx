import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RoutingPolicyAuditRecord, RoutingSettings } from '@deepseek-ai/dsh-aiops-incident-router'
import type { PortalViewInjected } from './contracts.ts'
import css from './portal.module.css'

type Props = Pick<PortalViewInjected, 'routingSettings' | 'dryRunRoutingPolicy'> & PropsLocale<'aiops-portal'> & {
  readonly audit: readonly RoutingPolicyAuditRecord[]
}

function jsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

const SEVERITY_MAP_HINT = `{
  "info": "info",
  "warning": "warning",
  "page": "critical"
}`
const MODEL_BUDGETS_HINT = `{
  "info": 2048,
  "warning": 4096,
  "critical": 8192
}`
const STORM_CONTROL_HINT = `{
  "cooldownSeconds": 60,
  "maxQueueSize": 100,
  "maxQueueAgeSeconds": 900,
  "maxDispatchAttempts": 3,
  "retryBackoffSeconds": 10,
  "globalConcurrency": 4,
  "severityConcurrency": {
    "info": 1,
    "warning": 2,
    "critical": 4
  },
  "globalReservedTokens": 24576,
  "severityReservedTokens": {
    "info": 2048,
    "warning": 8192,
    "critical": 24576
  }
}`
const DRY_RUN_LABELS_HINT = `{
  "alertname": "TargetDown",
  "severity": "warning",
  "job": "api"
}`

export function RoutingPolicySettings({ routingSettings, dryRunRoutingPolicy, audit, t }: Props) {
  const snapshot = useSyncExternalStore(listener => routingSettings.subscribe(listener), () => routingSettings.getSnapshot())
  const [ignored, setIgnored] = useState('')
  const [defaultSeverity, setDefaultSeverity] = useState<'info' | 'warning' | 'critical'>('warning')
  const [severityMap, setSeverityMap] = useState('')
  const [modelBudgets, setModelBudgets] = useState('')
  const [stormControl, setStormControl] = useState('')
  const [labels, setLabels] = useState('')
  const [dirty, setDirty] = useState(false)
  const [testedKey, setTestedKey] = useState<string>()
  const [testResult, setTestResult] = useState<string>()
  const [status, setStatus] = useState<'idle' | 'testing' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (dirty || snapshot.status !== 'ready' || snapshot.value === undefined) return
    setIgnored(snapshot.value.routingPolicy.ignoredAlertnames.join('\n'))
    setDefaultSeverity(snapshot.value.routingPolicy.defaultSeverity)
    setSeverityMap(JSON.stringify(snapshot.value.severityMap, null, 2))
    setModelBudgets(JSON.stringify(snapshot.value.modelBudgets, null, 2))
    setStormControl(JSON.stringify(snapshot.value.stormControl, null, 2))
  }, [dirty, snapshot.status, snapshot.value])

  const candidate = useMemo((): RoutingSettings | undefined => {
    const severity = jsonObject(severityMap)
    const budgets = jsonObject(modelBudgets)
    const storm = jsonObject(stormControl)
    if (severity === undefined || budgets === undefined || storm === undefined) return undefined
    return {
      version: 1,
      routingPolicy: {
        ignoredAlertnames: ignored.split('\n').map(value => value.trim()).filter(value => value !== ''),
        defaultSeverity,
      },
      severityMap: severity as RoutingSettings['severityMap'],
      modelBudgets: budgets as unknown as RoutingSettings['modelBudgets'],
      stormControl: storm as unknown as RoutingSettings['stormControl'],
    }
  }, [defaultSeverity, ignored, modelBudgets, severityMap, stormControl])
  const parsedLabels = useMemo(() => jsonObject(labels) as Record<string, string> | undefined, [labels])
  const candidateKey = candidate === undefined ? undefined : JSON.stringify(candidate)
  const tested = candidateKey !== undefined && testedKey === `${candidateKey}\u0000${labels}`
  const writable = snapshot.status === 'ready' && snapshot.writable

  const edit = (setter: (value: string) => void, value: string) => {
    setter(value); setDirty(true); setTestedKey(undefined); setTestResult(undefined); setStatus('idle')
  }
  const dryRun = async () => {
    if (candidate === undefined || parsedLabels === undefined) return
    setStatus('testing')
    try {
      const result = await dryRunRoutingPolicy({ labels: parsedLabels, settings: candidate })
      setTestedKey(`${JSON.stringify(candidate)}\u0000${labels}`)
      setTestResult(result.accepted ? t('policyAccepted', { severity: result.severity ?? '' }) : t('policyIgnored'))
      setStatus('idle')
    } catch { setStatus('error'); setTestResult(t('policyInvalid')) }
  }
  const save = async () => {
    if (!writable || !tested || candidate === undefined) return
    setStatus('saving')
    try {
      await routingSettings.mutate([
        { op: 'set', path: ['version'], value: 1 },
        { op: 'set', path: ['routingPolicy'], value: candidate.routingPolicy },
        { op: 'set', path: ['severityMap'], value: candidate.severityMap },
        { op: 'set', path: ['modelBudgets'], value: candidate.modelBudgets },
        { op: 'set', path: ['stormControl'], value: candidate.stormControl },
      ], snapshot.revision)
      setDirty(false); setStatus('saved')
    } catch { setStatus('error') }
  }

  return <section className={css.settingsPanel}>
    <div className={css.settingsIntro}><div><div className={css.eyebrow}>{t('routingPolicy')}</div><h2>{t('routingPolicyTitle')}</h2><p>{t('routingPolicyDescription')}</p></div><div className={css.liveBadge}><span/>LIVE · v1</div></div>
    <div className={css.policyGrid}>
      <label className={css.policyCard}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('ignoredAlertnames')}</span><textarea className={css.policyEditor} value={ignored} placeholder={'Watchdog\nInfoInhibitor'} spellCheck={false} onChange={event => edit(setIgnored, event.target.value)}/></label>
      <label className={css.policyCard}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('defaultSeverity')}</span><select className={css.policySelect} value={defaultSeverity} onChange={event => { setDefaultSeverity(event.target.value as typeof defaultSeverity); setDirty(true); setTestedKey(undefined); setTestResult(undefined); setStatus('idle') }}><option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option></select></label>
      <label className={css.policyCard}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('severityMap')}</span><textarea className={css.policyEditor} data-json-editor value={severityMap} placeholder={SEVERITY_MAP_HINT} spellCheck={false} onChange={event => edit(setSeverityMap, event.target.value)}/></label>
      <label className={css.policyCard}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('modelBudgets')}</span><textarea className={css.policyEditor} data-json-editor value={modelBudgets} placeholder={MODEL_BUDGETS_HINT} spellCheck={false} onChange={event => edit(setModelBudgets, event.target.value)}/></label>
      <label className={`${css.policyCard} ${css.policyWide}`}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('stormControl')}</span><textarea className={`${css.policyEditor} ${css.policyEditorLarge}`} data-json-editor value={stormControl} placeholder={STORM_CONTROL_HINT} spellCheck={false} onChange={event => edit(setStormControl, event.target.value)}/></label>
      <label className={`${css.policyCard} ${css.policyWide}`}><span className={css.endpointTitle}><span className={css.serviceDot}/>{t('dryRunLabels')}</span><textarea className={css.policyEditor} data-json-editor value={labels} placeholder={DRY_RUN_LABELS_HINT} spellCheck={false} onChange={event => { setLabels(event.target.value); setTestedKey(undefined); setTestResult(undefined); setStatus('idle') }}/></label>
    </div>
    <div className={css.settingsFooter}><div><p>{t('policyDryRunRule')}</p><div className={status === 'error' ? css.testFailed : css.saveMessage}>{testResult ?? (candidate === undefined || parsedLabels === undefined ? t('policyInvalid') : '')}</div></div><div className={css.policyActions}><button type="button" disabled={candidate === undefined || parsedLabels === undefined || status === 'testing'} onClick={() => { void dryRun() }}>{status === 'testing' ? t('policyTesting') : t('policyDryRun')}</button><button type="button" disabled={!writable || !dirty || !tested || status === 'saving'} onClick={() => { void save() }}>{status === 'saving' ? t('saving') : t('save')}</button></div></div>
    <div className={css.policyAudit}><h3>{t('policyAudit')}</h3>{audit.length === 0 ? <p>{t('policyAuditEmpty')}</p> : <ul>{audit.slice(0, 10).map(item => <li key={item.id}><time>{new Date(item.recordedAt).toLocaleString()}</time><span>{item.changedFields.join(', ')}</span><code>{item.nextHash.slice(0, 20)}</code></li>)}</ul>}</div>
  </section>
}
