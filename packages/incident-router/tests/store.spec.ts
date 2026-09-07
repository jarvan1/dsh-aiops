import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AlertmanagerAlert, AlertmanagerWebhookEvent } from '@deepseek-ai/dsh-webhook-alertmanager'
import { IncidentRouteStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function alert(status: 'firing' | 'resolved'): AlertmanagerAlert {
  return {
    status,
    labels: { alertname: 'KubePodCrashLooping', severity: 'critical' },
    annotations: {},
    startsAt: '2026-09-06T01:00:00Z',
    endsAt: status === 'resolved' ? '2026-09-06T01:05:00Z' : '0001-01-01T00:00:00Z',
    fingerprint: '0123456789abcdef',
    fingerprintSource: 'provider',
  }
}

function route(store: IncidentRouteStore, deliveryId: string, status: 'firing' | 'resolved', digest = deliveryId) {
  return store.route({
    source: 'primary',
    deliveryId,
    payloadDigest: digest,
    alert: alert(status),
    severity: 'critical',
    receivedAt: Date.now(),
  })
}

function event(alertValue: AlertmanagerAlert): AlertmanagerWebhookEvent {
  return {
    version: 1,
    payloadDigest: 'sha256:queue',
    status: alertValue.status,
    receiver: 'platform',
    groupKey: 'group',
    truncatedAlerts: 0,
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    alerts: [alertValue],
  }
}

describe('incident route store', () => {
  it('keeps firing and resolved notifications in one round, then reopens a new round', () => {
    const store = new IncidentRouteStore(':memory:')
    const created = route(store, 'd1', 'firing')
    const appended = route(store, 'd2', 'firing')
    const resolved = route(store, 'd3', 'resolved')
    const repeated = route(store, 'd4', 'resolved')
    const reopened = route(store, 'd5', 'firing')
    expect(created).toMatchObject({ decision: 'created', round: 1, replay: false })
    expect(appended).toMatchObject({ decision: 'appended', round: 1, sessionId: created.sessionId })
    expect(resolved).toMatchObject({ decision: 'resolved', round: 1, sessionId: created.sessionId })
    expect(repeated).toMatchObject({ decision: 'repeated-resolved', round: 1, sessionId: created.sessionId })
    expect(reopened).toMatchObject({ decision: 'reopened', round: 2, replay: false })
    expect(reopened.sessionId).not.toBe(created.sessionId)
    store.close()
  })

  it('suppresses exact delivery replay and rejects delivery-id content reuse', () => {
    const store = new IncidentRouteStore(':memory:')
    expect(store.admitDelivery({ source: 'primary', deliveryId: 'same', payloadDigest: 'digest-a', receivedAt: 1 }))
      .toBe(true)
    expect(store.admitDelivery({ source: 'primary', deliveryId: 'same', payloadDigest: 'digest-a', receivedAt: 2 }))
      .toBe(false)
    expect(() => store.admitDelivery({ source: 'primary', deliveryId: 'same', payloadDigest: 'digest-b', receivedAt: 3 }))
      .toThrow(/reused with different content/)
    const first = route(store, 'same', 'firing', 'digest-a')
    expect(route(store, 'same', 'firing', 'digest-a')).toEqual({ ...first, replay: true })
    expect(() => route(store, 'same', 'firing', 'digest-b')).toThrow(/reused with different content/)
    store.close()
  })

  it('preserves fingerprint state across process-style reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-aiops-router-'))
    roots.push(root)
    const path = join(root, 'router.sqlite')
    const first = new IncidentRouteStore(path)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    const created = route(first, 'd1', 'firing')
    first.close()
    const reopened = new IncidentRouteStore(path)
    expect(route(reopened, 'd2', 'firing')).toMatchObject({
      decision: 'appended',
      sessionId: created.sessionId,
      round: 1,
    })
    reopened.close()
  })

  it('audits filtered deliveries idempotently and detects conflicting reuse', () => {
    const store = new IncidentRouteStore(':memory:')
    const input = {
      source: 'primary',
      deliveryId: 'filtered',
      payloadDigest: 'digest-a',
      alert: alert('firing'),
      reason: 'alertname-not-allowed' as const,
      receivedAt: 1,
    }
    expect(() => { store.recordFiltered(input); store.recordFiltered(input) }).not.toThrow()
    expect(store.priorDelivery({
      source: input.source,
      deliveryId: input.deliveryId,
      fingerprint: input.alert.fingerprint,
      payloadDigest: input.payloadDigest,
    })).toEqual({ kind: 'filtered' })
    expect(() => store.recordFiltered({ ...input, payloadDigest: 'digest-b' })).toThrow(/reused/)
    store.close()
  })

  it('recovers claimed queue work after a process-style reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-aiops-queue-'))
    roots.push(root)
    const path = join(root, 'router.sqlite')
    const item = alert('firing')
    const first = new IncidentRouteStore(path)
    expect(first.enqueue({
      source: 'primary', deliveryId: 'queued', payloadDigest: 'digest', receivedAt: 10,
      severity: 'critical', event: event(item), alert: item, reason: 'ready', availableAt: 10,
      maxQueueSize: 10, now: 10,
    })).toBe('queued')
    expect(first.claimGroup('primary', item.fingerprint, 10)).toHaveLength(1)
    first.close()

    const reopened = new IncidentRouteStore(path)
    expect(reopened.readyGroups(Date.now())).toMatchObject([
      { source: 'primary', fingerprint: item.fingerprint, severity: 'critical' },
    ])
    expect(reopened.listAudit({ limit: 10, outcome: 'deferred' }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'restart-recovery' })]))
    reopened.close()
  })

  it('bounds the queue, expires stale work, and preserves explicit drop outcomes', () => {
    const store = new IncidentRouteStore(':memory:')
    const first = alert('firing')
    const second = { ...alert('firing'), fingerprint: 'fedcba9876543210' }
    expect(store.enqueue({
      source: 'primary', deliveryId: 'first', payloadDigest: 'first', receivedAt: 1,
      severity: 'critical', event: event(first), alert: first, reason: 'global-concurrency', availableAt: 1,
      maxQueueSize: 1, now: 1,
    })).toBe('queued')
    expect(store.enqueue({
      source: 'primary', deliveryId: 'second', payloadDigest: 'second', receivedAt: 2,
      severity: 'critical', event: event(second), alert: second, reason: 'global-concurrency', availableAt: 2,
      maxQueueSize: 1, now: 2,
    })).toBe('dropped')
    expect(store.dropExpired(2_000, 100)).toBe(1)
    expect(store.priorDelivery({
      source: 'primary', deliveryId: 'first', fingerprint: first.fingerprint, payloadDigest: 'first',
    })).toEqual({ kind: 'dropped' })
    expect(store.listAudit({ limit: 10, outcome: 'dropped' }).map(item => item.reason).sort())
      .toEqual(['queue-expired', 'queue-full'])
    store.close()
  })

  it('keeps the queue bound even when newly admitted work was initially ready', () => {
    const store = new IncidentRouteStore(':memory:')
    const first = alert('firing')
    const second = { ...alert('firing'), fingerprint: 'aaaabbbbccccdddd' }
    expect(store.enqueue({
      source: 'primary', deliveryId: 'ready-first', payloadDigest: 'first', receivedAt: 1,
      severity: 'critical', event: event(first), alert: first, reason: 'ready', availableAt: 1,
      maxQueueSize: 1, now: 1,
    })).toBe('queued')
    expect(store.enqueue({
      source: 'primary', deliveryId: 'ready-second', payloadDigest: 'second', receivedAt: 2,
      severity: 'critical', event: event(second), alert: second, reason: 'ready', availableAt: 2,
      maxQueueSize: 1, now: 2,
    })).toBe('dropped')
    expect(store.queueDepth()).toBe(1)
    expect(store.listAudit({ limit: 10, outcome: 'dropped' }))
      .toEqual([expect.objectContaining({ deliveryId: 'ready-second', reason: 'queue-full' })])
    store.close()
  })

  it('reuses the accepted round when a failed dispatch is retried', () => {
    const store = new IncidentRouteStore(':memory:')
    const item = alert('firing')
    store.enqueue({
      source: 'primary', deliveryId: 'retry', payloadDigest: 'digest', receivedAt: 1,
      severity: 'critical', event: event(item), alert: item, reason: 'ready', availableAt: 1,
      maxQueueSize: 10, now: 1,
    })
    const firstWork = store.claimGroup('primary', item.fingerprint, 1)[0]
    if (firstWork === undefined) throw new Error('missing first claimed work')
    const firstRoute = store.route({
      source: firstWork.source,
      deliveryId: firstWork.deliveryId,
      payloadDigest: firstWork.payloadDigest,
      alert: firstWork.alert,
      severity: firstWork.severity,
      receivedAt: firstWork.receivedAt,
    })
    store.retryOrDrop(firstWork, 2, 3, 3, 'transient failure')
    const retryWork = store.claimGroup('primary', item.fingerprint, 3)[0]
    if (retryWork === undefined) throw new Error('missing retried work')
    expect(store.route({
      source: retryWork.source,
      deliveryId: retryWork.deliveryId,
      payloadDigest: retryWork.payloadDigest,
      alert: retryWork.alert,
      severity: retryWork.severity,
      receivedAt: retryWork.receivedAt,
    })).toEqual({ ...firstRoute, replay: true })
    store.close()
  })
})
