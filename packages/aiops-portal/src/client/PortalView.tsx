import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PORTAL_API_PATH,
  PORTAL_CONNECTION_TEST_API_PATH,
  type ConnectionTestRequest,
  type ConnectionTestResult,
  type PortalIncident,
  type PortalSnapshot,
} from '../types.ts'
import { ConnectionSettings } from './ConnectionSettings.tsx'
import type { PortalViewInjected } from './contracts.ts'
import { filterPortalIncidents, type ReviewFilter, type SeverityFilter, type StatusFilter } from './model.ts'
import css from './portal.module.css'

const REFRESH_MS = 30_000

type DashboardProps = PortalViewInjected & PropsLocale<'aiops-portal'> & { onClose?: () => void }
type Props = ConvViewProps & InjectFace<PortalViewInjected> & PropsLocale<'aiops-portal'>

function fmtTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(value)
}

function incidentKey(item: PortalIncident): string {
  return `${item.sessionId}:${item.reportSeq}`
}

function Badge({ value, tone = value }: { value: string; tone?: string }) {
  return <span className={`${css.badge} ${css[`tone_${tone}`] ?? ''}`}>{value}</span>
}

function IncidentDetail({ item, t }: { item: PortalIncident; t: Props['t'] }) {
  const { incident } = item
  return <article className={css.detail}>
    <div className={css.detailHeader}>
      <div>
        <div className={css.eyebrow}>{incident.incidentId}</div>
        <h2>{incident.title}</h2>
      </div>
      <div className={css.badges}><Badge value={incident.severity}/><Badge value={incident.status}/></div>
    </div>
    <dl className={css.metadata}>
      <div><dt>{t('session')}</dt><dd>{item.sessionId}</dd></div>
      <div><dt>{t('reported')}</dt><dd>{fmtTime(item.reportTime)}</dd></div>
      {item.lastRoute === undefined ? null : <div><dt>{t('route')}</dt><dd>{item.lastRoute.outcome} · {item.lastRoute.reason}</dd></div>}
    </dl>
    <section><h3>{t('evidence')}</h3><ul>{incident.evidence.map(value => <li key={value.id}><Badge value={value.kind}/><span>{value.summary}</span></li>)}</ul></section>
    <section><h3>{t('hypotheses')}</h3><ul>{incident.hypotheses.map((value, index) => <li key={`${value.summary}-${index}`}><div><strong>{value.summary}</strong><small>{t('confidence', { value: value.confidence })}</small></div></li>)}</ul></section>
    <section><h3>{t('recommendations')}</h3><ul>{incident.recommendations.map((value, index) => <li key={`${value.action}-${index}`}><div><strong>{value.action}</strong><small>{t('risk', { value: value.risk })}</small></div></li>)}</ul></section>
    <section className={css.feedback}>
      <h3>{t('feedback')}</h3>
      {item.feedback === undefined
        ? <p>{t('notReviewed')}</p>
        : <div><Badge value={item.feedback.feedback.verdict}/><p>{item.feedback.feedback.note}</p>{item.feedback.feedback.correction === undefined ? null : <p>{item.feedback.feedback.correction}</p>}</div>}
    </section>
  </article>
}

export function PortalDashboard({ loadSnapshot, testConnection, prometheusSettings, alertmanagerSettings, kubernetesSettings, onClose, t }: DashboardProps) {
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [review, setReview] = useState<ReviewFilter>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [section, setSection] = useState<'incidents' | 'audit' | 'settings'>('incidents')

  const refresh = useCallback(async (silent = false, signal?: AbortSignal) => {
    const requestSignal = signal ?? new AbortController().signal
    if (!silent) setLoading(true)
    setError(false)
    try {
      const next = await loadSnapshot(requestSignal)
      setSnapshot(next)
      setSelectedKey(current => current !== null && next.incidents.some(item => incidentKey(item) === current)
        ? current : next.incidents[0] === undefined ? null : incidentKey(next.incidents[0]))
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(true)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [loadSnapshot])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(false, controller.signal)
    const timer = window.setInterval(() => { void refresh(true, controller.signal) }, REFRESH_MS)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])

  const filtered = useMemo(() => filterPortalIncidents(snapshot?.incidents ?? [], { query, severity, status, review }), [snapshot, query, severity, status, review])
  const selected = filtered.find(item => incidentKey(item) === selectedKey) ?? filtered[0]
  const reviewedPercent = snapshot === null || snapshot.summary.totalIncidents === 0
    ? 0 : Math.round(snapshot.summary.reviewed / snapshot.summary.totalIncidents * 100)

  return <main className={css.portal}>
    <header className={css.header}>
      <div><div className={css.eyebrow}>{t('subtitle')}</div><h1>{t('title')}</h1><div className={css.workspace}>{snapshot?.workspace ?? '—'}</div></div>
      <div className={css.headerActions}>
        <div className={css.refresh}>{snapshot === null ? null : <span>{t('updated', { time: fmtTime(snapshot.generatedAt) })}</span>}<button disabled={loading} onClick={() => { void refresh() }}>{t('refresh')}</button></div>
        <button type="button" className={section === 'settings' ? css.headerSettingsActive : ''} onClick={() => setSection('settings')}>{t('settings')}</button>
        {onClose === undefined ? null : <button type="button" className={css.closeButton} aria-label={t('close')} onClick={onClose}>×</button>}
      </div>
    </header>
    <nav className={css.tabs}>
      <button className={section === 'incidents' ? css.activeTab : ''} onClick={() => setSection('incidents')}>{t('incidents')} <span>{snapshot?.incidents.length ?? 0}</span></button>
      <button className={section === 'audit' ? css.activeTab : ''} onClick={() => setSection('audit')}>{t('audit')} <span>{snapshot?.audit.length ?? 0}</span></button>
    </nav>
    {section === 'settings'
      ? <ConnectionSettings testConnection={testConnection} prometheusSettings={prometheusSettings} alertmanagerSettings={alertmanagerSettings} kubernetesSettings={kubernetesSettings} t={t}/>
      : loading && snapshot === null
        ? <div className={css.center}><span className={css.spinner}/>{t('loading')}</div>
        : error && snapshot === null
          ? <div className={css.center}><strong>{t('error')}</strong><button onClick={() => { void refresh() }}>{t('retry')}</button></div>
          : snapshot === null
            ? null
            : <>
    {error ? <div className={css.error}>{t('error')}</div> : null}
    <section className={css.metrics}>
      <div><span>{t('total')}</span><strong>{snapshot.summary.totalIncidents}</strong></div>
      <div><span>{t('active')}</span><strong>{snapshot.summary.active}</strong></div>
      <div><span>{t('critical')}</span><strong>{snapshot.summary.critical}</strong></div>
      <div><span>{t('reviewCoverage')}</span><strong>{reviewedPercent}%</strong></div>
    </section>
    {section === 'audit' ? <section className={css.auditPanel}>
      {snapshot.audit.length === 0 ? <div className={css.empty}>{t('auditEmpty')}</div> : <div className={css.auditTable} role="table">
        <div className={css.auditHead} role="row"><span>{t('time')}</span><span>{t('alert')}</span><span>{t('outcome')}</span><span>{t('reason')}</span><span>{t('queue')}</span></div>
        {snapshot.audit.map(row => <div className={css.auditRow} role="row" key={row.id}><time>{fmtTime(row.recordedAt)}</time><strong>{row.alertname || row.fingerprint}</strong><Badge value={row.outcome}/><span>{row.reason}</span><span>{row.queueDepth}</span></div>)}
      </div>}
    </section> : <>
      <section className={css.filters}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search')} aria-label={t('search')}/>
        <select value={severity} onChange={event => setSeverity(event.target.value as SeverityFilter)}><option value="all">{t('allSeverity')}</option><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select>
        <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)}><option value="all">{t('allStatus')}</option><option value="investigating">investigating</option><option value="identified">identified</option><option value="monitoring">monitoring</option><option value="resolved">resolved</option></select>
        <select value={review} onChange={event => setReview(event.target.value as ReviewFilter)}><option value="all">{t('allReview')}</option><option value="reviewed">{t('reviewed')}</option><option value="unreviewed">{t('unreviewed')}</option></select>
        <span>{t('results', { count: filtered.length })}</span>
      </section>
      {snapshot.incidents.length === 0 ? <div className={css.empty}>{t('empty')}</div> : <section className={css.content}>
        <div className={css.list}>{filtered.map(item => <button className={item === selected ? css.selected : ''} key={incidentKey(item)} onClick={() => setSelectedKey(incidentKey(item))}>
          <span className={`${css.rail} ${css[`rail_${item.incident.severity}`]}`}/><span className={css.itemBody}><span className={css.itemTop}><strong>{item.incident.title}</strong><time>{fmtTime(item.reportTime)}</time></span><span className={css.itemBottom}><span className={css.badges}><Badge value={item.incident.severity}/><Badge value={item.incident.status}/>{item.feedback === undefined ? null : <Badge value={item.feedback.feedback.verdict}/>}</span><code>{item.sessionId.slice(0, 18)}</code></span></span>
        </button>)}{filtered.length === 0 ? <div className={css.empty}>{t('results', { count: 0 })}</div> : null}</div>
        {selected === undefined ? null : <IncidentDetail item={selected} t={t}/>}
      </section>}
    </>}
    </>}
  </main>
}

export function PortalView({ loadSnapshot, testConnection, prometheusSettings, alertmanagerSettings, kubernetesSettings, t }: Props) {
  return <PortalDashboard
    loadSnapshot={loadSnapshot}
    testConnection={testConnection}
    prometheusSettings={prometheusSettings}
    alertmanagerSettings={alertmanagerSettings}
    kubernetesSettings={kubernetesSettings}
    t={t}
  />
}

export async function fetchPortalSnapshot(signal: AbortSignal): Promise<PortalSnapshot> {
  const response = await fetch(PORTAL_API_PATH, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
  if (!response.ok) throw new Error(`AIOps Portal HTTP ${response.status}`)
  return await response.json() as PortalSnapshot
}

export async function fetchPortalConnectionTest(
  request: ConnectionTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> {
  const response = await fetch(PORTAL_CONNECTION_TEST_API_PATH, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`AIOps connection test HTTP ${response.status}`)
  return await response.json() as ConnectionTestResult
}
