import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { diagnosisTimeContext } from '../src/diagnosis-window.ts'
import type { AiopsAlertRouteEvent } from '../src/types.ts'

describe('Stage D alert-to-diagnosis replay', () => {
  it('preserves the exact time anchor and query parameters of a routed alert', () => {
    const sessionId = SessionId('aiops-replay-stage-d')
    const session = Session.create(sessionId)
    const diagnosis = diagnosisTimeContext(
      { startsAt: '2026-09-06T01:00:00Z' },
      Date.parse('2026-09-06T01:08:00Z'),
      { beforeSeconds: 900, afterSeconds: 1800, prometheusStepSeconds: 30, logTailLines: 1000 },
    )
    const route: AiopsAlertRouteEvent = {
      version: 2,
      source: 'primary-alertmanager',
      deliveryId: 'stage-d-delivery',
      payloadDigest: 'sha256:stage-d',
      receivedAt: Date.parse('2026-09-06T01:08:00Z'),
      fingerprint: '0123456789abcdef',
      round: 1,
      sessionId,
      decision: 'created',
      severity: 'critical',
      diagnosis,
      group: {
        status: 'firing',
        receiver: 'platform',
        groupKey: 'pod-crash',
        truncatedAlerts: 0,
        groupLabels: { alertname: 'KubePodCrashLooping', namespace: 'payments' },
        commonLabels: { severity: 'critical' },
        commonAnnotations: {},
      },
      alert: {
        status: 'firing',
        labels: { alertname: 'KubePodCrashLooping', namespace: 'payments', pod: 'api-1' },
        annotations: { summary: 'Pod is restarting' },
        startsAt: '2026-09-06T01:00:00Z',
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: '0123456789abcdef',
        fingerprintSource: 'provider',
      },
    }
    session.append('aiops/alert-routed', route, { ignorable: true })
    const replayed = Session.create(sessionId, session.snapshotEvents())
    const events = replayed.snapshotEvents()
    const routed = events.find(event => event.type === 'aiops/alert-routed')

    expect(routed?.type === 'aiops/alert-routed' ? routed.data.diagnosis : undefined).toEqual(diagnosis)
    expect(events.at(-1)?.type).toBe('session/end-seed')
  })
})
