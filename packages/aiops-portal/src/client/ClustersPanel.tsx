import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClusterProbeResult, PortalCluster, PortalClusterToken } from '../types.ts'
import type { PortalViewInjected } from './contracts.ts'
import css from './portal.module.css'

type Props = Pick<PortalViewInjected, 'clusterActions'> & PropsLocale<'aiops-portal'>
type ClusterProps = Props & {
  readonly clusters: readonly PortalCluster[]
  readonly needsCluster: boolean
  readonly onChanged: () => void
  /** A token exists only in the portal's own state; see TokenReveal. */
  readonly onIssued: (issued: PortalClusterToken) => void
}

const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function label(value: string | undefined): string {
  return value ?? ''
}

function probeText(result: ClusterProbeResult | undefined, t: Props['t']): { text: string; tone: string } | undefined {
  if (result === undefined) return undefined
  return result.ok
    ? { text: label(t('clusterProbePassed', { latency: result.latencyMs })), tone: css.testPassed ?? '' }
    : { text: label(t('clusterProbeFailed', { code: result.code })), tone: css.testFailed ?? '' }
}

function actionFailure(error: unknown, t: Props['t']): string {
  const code = error instanceof Error ? error.message : ''
  switch (code) {
    case 'cluster_exists': return label(t('clusterExists'))
    case 'invalid_name': return label(t('clusterInvalidName'))
    case 'invalid_version': return label(t('clusterInvalidVersion'))
    case 'cluster_not_found': return label(t('clusterNotFound'))
    case 'cluster_limit_reached': return label(t('clusterLimitReached'))
    case 'token_not_reissuable': return label(t('clusterTokenFixed'))
    default: return label(t('clusterActionFailed'))
  }
}

function fmtTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

/**
 * One-time token presentation. The plaintext lives in component state only:
 * it is never put in the snapshot, a URL, or browser storage, and closing the
 * panel discards it for good.
 */
export function TokenReveal({ issued, t, onDismiss }: { issued: PortalClusterToken; t: Props['t']; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(issued.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return <section className={css.tokenReveal}>
    <h3>{t('clusterTokenTitle', { name: issued.cluster.name })}</h3>
    <p className={css.tokenOnce}>{t('clusterTokenOnce')}</p>
    <div className={css.tokenRow}>
      <code className={css.tokenValue}>{issued.token}</code>
      <button type="button" onClick={() => { void copy() }}>{copied ? t('clusterTokenCopied') : t('clusterTokenCopy')}</button>
    </div>
    <ol className={css.installSteps}>
      <li><code>{t('clusterInstallStep1', { token: issued.token })}</code></li>
      <li>{t('clusterInstallStep2')}</li>
      <li><code>{t('clusterInstallStep3')}</code></li>
    </ol>
    <button type="button" onClick={onDismiss}>{t('clusterTokenDone')}</button>
  </section>
}

function ClusterCreator({ clusterActions, onChanged, onIssued, t, autoFocus }: Props & { onChanged: () => void; onIssued: (issued: PortalClusterToken) => void; autoFocus?: boolean }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const valid = NAME_RE.test(name) && name.length <= 63

  const create = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setFailure(null)
    try {
      onIssued(await clusterActions.createCluster(name))
      setName('')
      onChanged()
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(false)
    }
  }

  return <div className={css.clusterCreator}>
    <form onSubmit={event => { event.preventDefault(); void create() }}>
      <input
        value={name}
        onChange={event => { setName(event.target.value) }}
        placeholder={t('clusterNamePlaceholder')}
        aria-label={t('clusterName')}
        aria-invalid={name !== '' && !valid}
        autoFocus={autoFocus ?? false}
      />
      <button type="submit" disabled={!valid || busy}>{busy ? t('clusterCreating') : t('clusterCreate')}</button>
    </form>
    <p className={css.clusterHint}>{t('clusterNameHint')}</p>
    {failure === null ? null : <p className={css.clusterFailure}>{failure}</p>}
  </div>
}

/** First-run prompt on the home view: no cluster has a token yet. */
export function ClusterOnboarding({ clusters, needsCluster, clusterActions, onChanged, onIssued, t }: ClusterProps) {
  if (!needsCluster) return null
  return <section className={css.onboarding}>
    <div className={css.onboardingIntro}>
      <div className={css.eyebrow}>{t('clusterOnboardingEyebrow')}</div>
      <h2>{t('clusterOnboardingTitle')}</h2>
      <p>{t('clusterOnboardingBody')}</p>
    </div>
    <ClusterCreator clusterActions={clusterActions} onChanged={onChanged} onIssued={onIssued} t={t} autoFocus/>
    <p className={css.clusterHint}>{t('clusterOnboardingFootnote', { count: clusters.length })}</p>
  </section>
}

/** Cluster table with issue, re-issue, revoke, and probe controls. */
export function ClustersPanel({ clusters, needsCluster, clusterActions, onChanged, onIssued, t }: ClusterProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ClusterProbeResult>>({})
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [targetVersion, setTargetVersion] = useState('')
  const [rollout, setRollout] = useState<{ name: string; version: string } | null>(null)

  const reissue = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      onIssued(await clusterActions.reissueClusterToken(name))
      onChanged()
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(null)
    }
  }
  const revoke = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      await clusterActions.revokeCluster(name)
      setConfirm(null)
      setProbes(current => { const next = { ...current }; delete next[name]; return next })
      onChanged()
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(null)
    }
  }
  const upgrade = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      await clusterActions.upgradeCluster(name, targetVersion)
      setRollout({ name, version: targetVersion })
      setUpgrading(null)
      setTargetVersion('')
      onChanged()
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(null)
    }
  }
  const resume = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      await clusterActions.resumeCluster(name)
      setRollout(null)
      onChanged()
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(null)
    }
  }
  const probe = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      const result = await clusterActions.probeCluster(name)
      setProbes(current => ({ ...current, [name]: result }))
    } catch (error: unknown) {
      setFailure(actionFailure(error, t))
    } finally {
      setBusy(null)
    }
  }

  return <section className={css.clustersPanel}>
    <div className={css.settingsIntro}>
      <div>
        <div className={css.eyebrow}>{t('clustersEyebrow')}</div>
        <h2>{t('clustersTitle')}</h2>
        <p>{t('clustersDescription')}</p>
      </div>
    </div>
    {failure === null ? null : <div className={css.error}>{failure}</div>}
    <ClusterCreator clusterActions={clusterActions} onChanged={onChanged} onIssued={onIssued} t={t}/>
    {upgrading === null ? null : <form className={css.upgradeForm} onSubmit={event => { event.preventDefault() }}>
      <div><strong>{t('clusterUpgradeTitle', { name: upgrading })}</strong><p>{t('clusterUpgradeHint')}</p></div>
      <input value={targetVersion} onChange={event => { setTargetVersion(event.target.value) }} placeholder={t('clusterUpgradePlaceholder')} aria-label={t('clusterUpgradeVersion')} aria-invalid={targetVersion !== '' && !/^[A-Za-z0-9._+-]{1,64}$/.test(targetVersion)}/>
      <button type="submit" disabled={!/^[A-Za-z0-9._+-]{1,64}$/.test(targetVersion) || busy === upgrading} onClick={() => { void upgrade(upgrading) }}>{t('clusterUpgradeConfirm')}</button>
      <button type="button" onClick={() => { setUpgrading(null) }}>{t('clusterCancel')}</button>
    </form>}
    {rollout === null ? null : <div className={css.rolloutNotice}>
      <p>{t('clusterUpgradeRollout', { version: rollout.version })}</p>
      <pre>{`kubectl -n aiops set image deployment/aiops-agent agent=<IMAGE>:${rollout.version}`}</pre>
    </div>}
    {clusters.length === 0
      ? <div className={css.empty}>{needsCluster ? t('clusterEmptyFirst') : t('clusterEmpty')}</div>
      : <div className={css.clusterTable}>
        <div className={css.clusterHead} role="row">
          <span>{t('clusterName')}</span><span>{t('clusterStatus')}</span><span>{t('clusterVersion')}</span><span>{t('clusterLastSeen')}</span><span>{t('clusterActionsLabel')}</span>
        </div>
        {clusters.map(cluster => {
          const probeState = probeText(probes[cluster.name], t)
          const pending = cluster.desiredVersion !== undefined && cluster.desiredVersion !== cluster.agentVersion
          return <div className={css.clusterRow} role="row" key={cluster.name}>
            <strong>{cluster.name}</strong>
            <span><span className={`${css.badge} ${css[cluster.draining === true ? 'tone_draining' : `tone_${cluster.status}`] ?? ''}`}>{cluster.draining === true ? t('clusterStatus_draining') : t(`clusterStatus_${cluster.status}` as 'clusterStatus_connected')}</span></span>
            <span>{cluster.agentVersion ?? '—'}{pending ? <small className={css.versionPending}> → {cluster.desiredVersion}</small> : null}</span>
            <span>{cluster.lastSeenAt === undefined ? '—' : fmtTime(cluster.lastSeenAt)}</span>
            <span className={css.clusterActions}>
              {probeState === undefined ? null : <span className={probeState.tone}>{probeState.text}</span>}
              {cluster.status === 'connected' ? <button type="button" disabled={busy === cluster.name} onClick={() => { void probe(cluster.name) }}>{t('clusterProbe')}</button> : null}
              {cluster.status === 'connected' && cluster.draining === true ? <button type="button" disabled={busy === cluster.name} onClick={() => { void resume(cluster.name) }}>{t('clusterResume')}</button> : null}
              {cluster.status === 'connected' && cluster.draining !== true ? <button type="button" disabled={busy === cluster.name} onClick={() => { setUpgrading(cluster.name); setTargetVersion(cluster.desiredVersion ?? '') }}>{t('clusterUpgrade')}</button> : null}
              {cluster.status === 'pending' ? <button type="button" disabled={busy === cluster.name} onClick={() => { void reissue(cluster.name) }}>{t('clusterReissue')}</button> : null}
              {cluster.status === 'revoked' ? null : confirm === cluster.name
                ? <><button type="button" className={css.danger} disabled={busy === cluster.name} onClick={() => { void revoke(cluster.name) }}>{t('clusterRevokeConfirm')}</button><button type="button" onClick={() => { setConfirm(null) }}>{t('clusterCancel')}</button></>
                : <button type="button" disabled={busy === cluster.name} onClick={() => { setConfirm(cluster.name) }}>{t('clusterRevoke')}</button>}
            </span>
          </div>
        })}
      </div>}
  </section>
}
