import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PortalDashboard } from './PortalView.tsx'
import type { PortalViewInjected } from './contracts.ts'
import css from './portal.module.css'

type Props = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<PortalViewInjected>
  & PropsLocale<'aiops-portal'>

function OpsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
    <path d="M3 14.5V11m4 3.5V7m4 7.5V9m4 5.5V4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M2.5 16.5h15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".55"/>
  </svg>
}

export function AIOpsSidebarAction({
  wide, loadSnapshot, testConnection, prometheusSettings, alertmanagerSettings, kubernetesSettings, t,
}: Props) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) trigger.current?.focus()
      wasOpen.current = false
      return
    }
    wasOpen.current = true
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  return <>
    <button
      ref={trigger}
      type="button"
      className={`${css.sidebarAction} ${wide ? '' : css.sidebarActionRail}`}
      aria-label={t('open')}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={wide ? undefined : t('entry')}
      onClick={() => setOpen(true)}
    >
      <OpsIcon/>
      {wide ? <span>{t('entry')}</span> : null}
    </button>
    {open ? <div className={css.overlay} role="presentation">
      <div className={css.overlayMask} aria-hidden="true" onClick={() => setOpen(false)}/>
      <div className={css.globalPanel} role="dialog" aria-modal="true" aria-label={t('title')}>
        <PortalDashboard
          loadSnapshot={loadSnapshot}
          testConnection={testConnection}
          prometheusSettings={prometheusSettings}
          alertmanagerSettings={alertmanagerSettings}
          kubernetesSettings={kubernetesSettings}
          onClose={() => setOpen(false)}
          t={t}
        />
      </div>
    </div> : null}
  </>
}
