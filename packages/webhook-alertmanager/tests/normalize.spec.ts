import { describe, expect, it } from 'vitest'
import { normalizeAlertmanagerWebhook } from '../src/normalize.ts'

const limits = { maxAlerts: 10, maxMapEntries: 10, maxTextChars: 1000 }

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '4',
    status: 'firing',
    receiver: 'platform',
    groupKey: '{}:{alertname="KubePodCrashLooping"}',
    truncatedAlerts: 0,
    groupLabels: { alertname: 'KubePodCrashLooping' },
    commonLabels: { severity: 'critical' },
    commonAnnotations: { summary: 'pod restarts' },
    externalURL: 'https://alertmanager.example',
    alerts: [{
      status: 'firing',
      labels: { severity: 'critical', alertname: 'KubePodCrashLooping', namespace: 'prod' },
      annotations: { summary: 'pod is crash looping' },
      startsAt: '2026-09-06T01:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://prometheus.example/graph',
    }],
    ...overrides,
  })
}

describe('Alertmanager webhook normalization', () => {
  it('normalizes v4 payloads and derives a label-stable fingerprint', () => {
    const event = normalizeAlertmanagerWebhook(payload(), limits)
    expect(event).toMatchObject({ version: 1, status: 'firing', receiver: 'platform' })
    expect(event.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(event.alerts[0]).toMatchObject({
      fingerprintSource: 'labels-sha256',
      fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
      labels: { alertname: 'KubePodCrashLooping', namespace: 'prod', severity: 'critical' },
    })
    const reordered = payload({
      alerts: [{
        status: 'resolved',
        labels: { namespace: 'prod', alertname: 'KubePodCrashLooping', severity: 'critical' },
        annotations: {},
        startsAt: '2026-09-06T01:00:00Z',
        endsAt: '2026-09-06T01:05:00Z',
      }],
    })
    expect(normalizeAlertmanagerWebhook(reordered, limits).alerts[0]?.fingerprint)
      .toBe(event.alerts[0]?.fingerprint)
  })

  it('accepts a validated provider fingerprint and normalizes its case', () => {
    const event = normalizeAlertmanagerWebhook(payload({
      alerts: [{
        status: 'firing',
        labels: { alertname: 'KubePodCrashLooping' },
        annotations: {},
        startsAt: '2026-09-06T01:00:00Z',
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: 'ABCDEF0123456789',
      }],
    }), limits)
    expect(event.alerts[0]).toMatchObject({ fingerprint: 'abcdef0123456789', fingerprintSource: 'provider' })
  })

  it.each([
    [{ version: '3' }, /version/],
    [{ alerts: [] }, /non-empty bounded array/],
    [{ alerts: [{ status: 'firing', labels: {}, annotations: {}, startsAt: 'x', endsAt: 'x' }] }, /alertname/],
    [{ alerts: [{ status: 'firing', labels: { alertname: 'A' }, annotations: {}, startsAt: 'bad', endsAt: 'bad' }] }, /timestamp/],
    [{ alerts: [{ status: 'firing', labels: { alertname: 'A' }, annotations: {}, startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z', fingerprint: 'bad' }] }, /fingerprint/],
  ] as const)('rejects malformed provider input %#', (overrides, message) => {
    expect(() => normalizeAlertmanagerWebhook(payload(overrides), limits)).toThrow(message)
  })

  it('rejects duplicate fingerprints and configured batch overflow', () => {
    const alert = {
      status: 'firing',
      labels: { alertname: 'A' },
      annotations: {},
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '0001-01-01T00:00:00Z',
      fingerprint: '0123456789abcdef',
    }
    expect(() => normalizeAlertmanagerWebhook(payload({ alerts: [alert, alert] }), limits)).toThrow(/unique/)
    expect(() => normalizeAlertmanagerWebhook(payload({ alerts: [alert, { ...alert, fingerprint: 'fedcba9876543210' }] }), {
      ...limits,
      maxAlerts: 1,
    })).toThrow(/bounded array/)
  })
})
