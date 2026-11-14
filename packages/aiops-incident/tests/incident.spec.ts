import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import {
  AiopsIncidentStore,
  decodeAiopsIncidentState,
  decodeAiopsOperatorFeedback,
  validateAiopsIncidentTransition,
} from '../src/index.ts'
import type { AiopsIncidentRecord } from '../src/index.ts'

const base = {
  version: 1 as const,
  incidentId: 'inc-payments-1',
  title: 'Payments latency',
  severity: 'critical' as const,
  status: 'investigating' as const,
  evidence: [{ id: 'metric-p99', kind: 'metric' as const, summary: 'p99 exceeded 2 seconds.' }],
  hypotheses: [{ summary: 'API saturation', confidence: 'possible' as const, evidenceIds: ['metric-p99'] }],
  recommendations: [{ action: 'Review pod saturation before scaling.', risk: 'low' as const }],
}

const otherWorkspace = '/definitely/another/workspace'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function openStore(storageRoot: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(JsonBackend, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(AiopsIncidentStore)
  return ctx
}

describe('AIOps incident domain', () => {
  it('canonicalizes text and validates hypothesis evidence references', () => {
    expect(decodeAiopsIncidentState({ ...base, title: '  Payments latency  ' }).title).toBe('Payments latency')
    expect(() => decodeAiopsIncidentState({
      ...base,
      hypotheses: [{ summary: 'Unknown', confidence: 'possible', evidenceIds: ['missing'] }],
    })).toThrow('unknown hypothesis evidence id missing')
    expect(decodeAiopsIncidentState({
      ...base,
      evidence: [{ id: 'alert-latency', kind: 'alert', summary: 'HighLatency is active.' }],
      hypotheses: [],
    }).evidence[0]?.kind).toBe('alert')
  })

  it('rejects empty, oversized, invalid, and duplicate incident fields', () => {
    expect(() => decodeAiopsIncidentState({ ...base, title: ' ' })).toThrow('incident title must be non-empty')
    expect(() => decodeAiopsIncidentState({ ...base, title: 'x'.repeat(2_001) })).toThrow('must not exceed 2000')
    expect(() => decodeAiopsIncidentState({ ...base, incidentId: '-invalid' })).toThrow('invalid characters')
    expect(() => decodeAiopsIncidentState({ ...base, incidentId: `i${'x'.repeat(128)}` })).toThrow('invalid characters')
    expect(() => decodeAiopsIncidentState({
      ...base,
      evidence: [base.evidence[0], base.evidence[0]],
    })).toThrow('duplicate evidence id metric-p99')
    expect(() => decodeAiopsIncidentState({
      ...base,
      hypotheses: [{ ...base.hypotheses[0], evidenceIds: ['metric-p99', 'metric-p99'] }],
    })).toThrow('duplicate hypothesis evidence id metric-p99')
  })

  it('keeps incident identity stable and resolved state terminal', () => {
    const first = decodeAiopsIncidentState(base)
    expect(() => { validateAiopsIncidentTransition(null, first) }).not.toThrow()
    expect(() => {
      validateAiopsIncidentTransition(null, decodeAiopsIncidentState({ ...base, status: 'resolved' }))
    }).toThrow('first incident report cannot already be resolved')
    expect(() => { validateAiopsIncidentTransition(first, first) }).not.toThrow()
    expect(() => {
      validateAiopsIncidentTransition(first, decodeAiopsIncidentState({ ...base, incidentId: 'inc-other' }))
    }).toThrow('cannot replace its incident identity')
    const resolved = decodeAiopsIncidentState({ ...base, status: 'resolved' })
    expect(() => { validateAiopsIncidentTransition(resolved, first) }).toThrow('cannot return')
    expect(() => { validateAiopsIncidentTransition(resolved, resolved) }).not.toThrow()
  })

  it('validates corrected feedback values', () => {
    const confirmed = decodeAiopsOperatorFeedback({
      version: 1,
      feedbackId: `feedback-${'a'.repeat(32)}`,
      incidentId: 'inc-payments-1',
      reportRevision: 3,
      verdict: 'confirmed',
      note: ' Operator confirmed the diagnosis. ',
      origin: 'operator-via-agent',
    })
    expect(confirmed.note).toBe('Operator confirmed the diagnosis.')
    expect(() => decodeAiopsOperatorFeedback({ ...confirmed, verdict: 'corrected' })).toThrow(/requires a correction/)
    expect(() => decodeAiopsOperatorFeedback({ ...confirmed, correction: 'unexpected' })).toThrow(/only corrected/)
    expect(() => decodeAiopsOperatorFeedback({ ...confirmed, reportRevision: 0 })).toThrow()
  })
})

describe('AIOps incident store', () => {
  it('reports revisions, validates transitions, and survives reopen', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-incident-store-'))
    const ctx = await openStore(join(root, 'storages'))
    context = ctx
    const store = ctx.aiopsIncidents

    expect(store.get('aiops-session-1')).toBeUndefined()
    await expect(store.report('aiops-session-1', root, decodeAiopsIncidentState({ ...base, status: 'resolved' })))
      .rejects.toThrow('first incident report cannot already be resolved')

    const changes: AiopsIncidentRecord[] = []
    store.onChanged(record => changes.push(record))

    const first = await store.report('aiops-session-1', root, decodeAiopsIncidentState(base))
    expect(first).toMatchObject({ sessionId: 'aiops-session-1', workspace: root, revision: 1, incident: { incidentId: 'inc-payments-1' } })
    const second = await store.report('aiops-session-1', root, decodeAiopsIncidentState({ ...base, status: 'identified' }))
    expect(second.revision).toBe(2)
    expect(store.get('aiops-session-1')?.incident.status).toBe('identified')
    await expect(store.report('aiops-session-1', otherWorkspace, decodeAiopsIncidentState(base)))
      .rejects.toThrow('already reported under workspace')
    await expect(store.report('aiops-session-1', root, decodeAiopsIncidentState({ ...base, incidentId: 'inc-other' })))
      .rejects.toThrow('cannot replace its incident identity')
    expect(changes.map(record => record.revision)).toEqual([1, 2])

    // Durability: a fresh store over the same medium sees the same records.
    const reopened = await openStore(join(root, 'storages'))
    expect(reopened.aiopsIncidents.get('aiops-session-1')?.revision).toBe(2)
    await reopened.fiber.dispose()
  }, 30_000)

  it('lists incidents workspace-scoped and resolved-only, newest first', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-incident-store-'))
    const ctx = await openStore(join(root, 'storages'))
    context = ctx
    const store = ctx.aiopsIncidents
    await store.report('aiops-a', root, decodeAiopsIncidentState({ ...base, incidentId: 'inc-a' }))
    await store.report('aiops-b', otherWorkspace, decodeAiopsIncidentState({ ...base, incidentId: 'inc-b' }))
    await store.report('aiops-c', root, decodeAiopsIncidentState({ ...base, incidentId: 'inc-c' }))
    await store.report('aiops-c', root, decodeAiopsIncidentState({ ...base, incidentId: 'inc-c', status: 'resolved' }))

    expect(store.listIncidents(root).map(record => record.sessionId)).toEqual(['aiops-c', 'aiops-a'])
    // Same-millisecond reports tie-break on descending session id.
    expect(store.listIncidents().map(record => record.sessionId)).toEqual(['aiops-c', 'aiops-b', 'aiops-a'])
    expect(store.listResolved(root).map(record => record.sessionId)).toEqual(['aiops-c'])
    expect(store.listIncidents(root, 1).map(record => record.sessionId)).toEqual(['aiops-c'])
  }, 30_000)

  it('appends feedback idempotently against the reviewed revision', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-incident-store-'))
    const ctx = await openStore(join(root, 'storages'))
    context = ctx
    const store = ctx.aiopsIncidents
    const feedbackBase = {
      version: 1 as const,
      feedbackId: `feedback-${'a'.repeat(32)}`,
      incidentId: 'inc-payments-1',
      reportRevision: 1,
      verdict: 'confirmed' as const,
      note: 'Operator confirmed the diagnosis.',
      origin: 'operator-via-agent' as const,
    }
    await expect(store.appendFeedback('aiops-none', decodeAiopsOperatorFeedback(feedbackBase)))
      .rejects.toThrow('no stored incident report')

    await store.report('aiops-session-1', root, decodeAiopsIncidentState(base))
    const appended = await store.appendFeedback('aiops-session-1', decodeAiopsOperatorFeedback(feedbackBase))
    expect(appended).toMatchObject({ sessionId: 'aiops-session-1', feedback: { verdict: 'confirmed' } })
    const replay = await store.appendFeedback('aiops-session-1', decodeAiopsOperatorFeedback(feedbackBase))
    expect(replay.time).toBe(appended.time)
    expect(store.latestFeedback('aiops-session-1')?.feedback.feedbackId).toBe(feedbackBase.feedbackId)

    // A replacement report invalidates feedback pinned to the old revision.
    await store.report('aiops-session-1', root, decodeAiopsIncidentState({ ...base, status: 'identified' }))
    await expect(store.appendFeedback('aiops-session-1', decodeAiopsOperatorFeedback(feedbackBase)))
      .rejects.toThrow('no longer the latest stored report')

    const corrected = await store.appendFeedback('aiops-session-1', decodeAiopsOperatorFeedback({
      ...feedbackBase,
      feedbackId: `feedback-${'b'.repeat(32)}`,
      reportRevision: 2,
      verdict: 'corrected',
      correction: 'The rollout, not saturation, caused the failure.',
    }))
    expect(store.listFeedback(root).map(record => record.feedback.feedbackId))
      .toEqual([corrected.feedbackId, feedbackBase.feedbackId])
    expect(store.listFeedback('/missing/workspace')).toEqual([])
  }, 30_000)
})
