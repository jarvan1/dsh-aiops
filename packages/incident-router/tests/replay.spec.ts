import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { diagnosisTimeContext } from '../src/diagnosis-window.ts'
import type { AiopsAlertRouteEvent } from '../src/types.ts'

describe('Stage D keyless alert-to-report replay', () => {
  it('preserves the exact time anchor, query parameters, evidence, and hypotheses', () => {
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
    const report: AiopsIncidentState = {
      version: 1,
      incidentId: 'incident-stage-d' as AiopsIncidentState['incidentId'],
      title: 'payments/api-1 CrashLoopBackOff',
      severity: 'critical',
      status: 'identified',
      evidence: [
        { id: 'alert-t0' as AiopsIncidentState['evidence'][number]['id'], kind: 'alert', summary: `Alert began at ${diagnosis.anchor.time}.` },
        { id: 'k8s-exit' as AiopsIncidentState['evidence'][number]['id'], kind: 'kubernetes', summary: 'Previous container exited with code 1 inside the diagnosis window.' },
      ],
      hypotheses: [{
        summary: 'The container process exits during startup.',
        confidence: 'strong',
        evidenceIds: [
          'alert-t0' as AiopsIncidentState['evidence'][number]['id'],
          'k8s-exit' as AiopsIncidentState['evidence'][number]['id'],
        ],
      }],
      recommendations: [{ action: 'Review the startup error and deployment change with the service owner.', risk: 'low' }],
    }

    session.append('aiops/alert-routed', route, { ignorable: true })
    session.append('aiops/incident-state', report, { ignorable: true })
    const replayed = Session.create(sessionId, session.snapshotEvents())
    const events = replayed.snapshotEvents()
    const routed = events.find(event => event.type === 'aiops/alert-routed')
    const persisted = events.find(event => event.type === 'aiops/incident-state')

    expect(routed?.type === 'aiops/alert-routed' ? routed.data.diagnosis : undefined).toEqual(diagnosis)
    expect(persisted?.type === 'aiops/incident-state' ? persisted.data : undefined).toEqual(report)
    expect(events.at(-1)?.type).toBe('session/end-seed')
  })
})
