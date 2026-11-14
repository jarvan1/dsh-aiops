/**
 * Durable AIOps incident and feedback store over one DSH storage domain.
 *
 * DSH 0.2.x reserves `appendPluginRecord` for packages loaded from the Host's
 * own dependency tree: the writer must share the Host's `dsh-session` module
 * instance or the private-field brand check rejects the call, which external
 * plugins cannot guarantee. The sanctioned home for plugin-owned durable
 * state is the storage service (`ctx.storageDomain`), so incident reports and
 * operator feedback live here instead of Session events. The Session log
 * keeps the diagnosis narrative; this store owns the structured state.
 *
 * @module @deepseek-ai/dsh-aiops-incident/src/store
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { incidentStateSchema, validateAiopsIncidentTransition } from './domain.ts'
import { operatorFeedbackValueSchema } from './feedback.ts'
import type { AiopsFeedbackId, AiopsFeedbackRecord, AiopsIncidentRecord, AiopsIncidentState, AiopsOperatorFeedback } from './types.ts'

/** Storage-domain record schema for the `incidents` table. */
const incidentRecordSchema = z.object({
  sessionId: z.string().min(1).max(256),
  workspace: z.string().min(1),
  revision: z.number().int().positive().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
  incident: incidentStateSchema,
}).strict()

/** Storage-domain record schema for the `feedback` table. */
const feedbackRecordSchema = z.object({
  sessionId: z.string().min(1).max(256),
  feedbackId: z.string().regex(/^feedback-[a-f0-9]{32}$/),
  time: z.number().int().nonnegative().safe(),
  feedback: operatorFeedbackValueSchema,
}).strict()

/**
 * One `aiops_incident` domain: one incident record per diagnostic Session and
 * append-only feedback records. `per-record` layout keeps each report a
 * separately durable document, and `backup-and-skip` treats a record that
 * fails today's schema as absent instead of blocking the open.
 */
export const aiopsIncidentDomainSpec = defineDomain({
  name: 'aiops_incident',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    incidents: domainTable<string, z.infer<typeof incidentRecordSchema>>(incidentRecordSchema),
    feedback: domainTable<string, z.infer<typeof feedbackRecordSchema>>(feedbackRecordSchema),
  },
})

/** The store's public surface; in-memory fakes implement the same shape. */
export interface AiopsIncidentStoreApi {
  /** Latest record for one Session, or undefined before the first report. */
  get(sessionId: string): AiopsIncidentRecord | undefined
  /**
   * Persist one complete replacement report. Validates the lifecycle
   * transition against the stored record, bumps the revision, and resolves
   * after the medium is durable.
   */
  report(sessionId: string, workspace: string, incident: AiopsIncidentState): Promise<AiopsIncidentRecord>
  /** Stored records for one workspace, newest report first. */
  listIncidents(workspace?: string, limit?: number): AiopsIncidentRecord[]
  /** Stored resolved incidents for one workspace, newest report first. */
  listResolved(workspace?: string, limit?: number): AiopsIncidentRecord[]
  /**
   * Append one operator feedback. Requires a stored incident report for the
   * Session and is idempotent per feedback id (a replay returns the stored
   * record).
   */
  appendFeedback(sessionId: string, feedback: AiopsOperatorFeedback): Promise<AiopsFeedbackRecord>
  /** Latest feedback for one Session, or undefined. */
  latestFeedback(sessionId: string): AiopsFeedbackRecord | undefined
  /** Stored feedback for one workspace, newest first. */
  listFeedback(workspace?: string, limit?: number): AiopsFeedbackRecord[]
  /** Subscribe to durable incident-report changes; returns the disposer. */
  onChanged(listener: (record: AiopsIncidentRecord) => void): () => void
}

/** Record-key charset accepted by per-record JSON media (path segments). */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Derive one path-safe storage key. Session ids are hyphenated ULIDs in
 * practice and pass through unchanged (keeping the durable tree readable);
 * any other shape — including the compound `session#feedback` key, whose `#`
 * separator is never path-safe — is replaced by its hex SHA-256 digest, which
 * is injective enough for record addressing and stable across replays.
 */
function recordKey(...parts: string[]): string {
  const joined = parts.join('#')
  return SAFE_KEY_RE.test(joined) ? joined : createHash('sha256').update(joined).digest('hex')
}

function toIncidentRecord(value: z.infer<typeof incidentRecordSchema>): AiopsIncidentRecord {
  return value
}

function toFeedbackRecord(value: z.infer<typeof feedbackRecordSchema>): AiopsFeedbackRecord {
  return { sessionId: value.sessionId, feedbackId: value.feedbackId as AiopsFeedbackId, time: value.time, feedback: value.feedback }
}

/**
 * The `aiopsIncidents` service: opens the `aiops_incident` storage domain at
 * init and serves synchronous reads from the domain's authoritative memory.
 * Writes queue on the domain's single write chain, so `report` performs its
 * read-validate-write atomically against concurrent callers.
 */
export class AiopsIncidentStore extends Service implements AiopsIncidentStoreApi {
  static inject = ['storageDomain']

  private incidents!: KvTable<string, z.infer<typeof incidentRecordSchema>>
  private feedback!: KvTable<string, z.infer<typeof feedbackRecordSchema>>

  constructor(ctx: Context) {
    super(ctx, 'aiopsIncidents')
  }

  async [Service.init](): Promise<void> {
    const domain: Domain<DomainSpec> = await this.ctx.storageDomain.open(aiopsIncidentDomainSpec)
    this.ctx.effect(() => () => void domain.close(), 'aiopsIncidents.domainClose')
    this.incidents = domain.table('incidents') as KvTable<string, z.infer<typeof incidentRecordSchema>>
    this.feedback = domain.table('feedback') as KvTable<string, z.infer<typeof feedbackRecordSchema>>
  }

  get(sessionId: string): AiopsIncidentRecord | undefined {
    const record = this.incidents.get(recordKey(sessionId))
    return record === undefined ? undefined : toIncidentRecord(record)
  }

  async report(sessionId: string, workspace: string, incident: AiopsIncidentState): Promise<AiopsIncidentRecord> {
    const key = recordKey(sessionId)
    const previous = this.incidents.get(key)
    if (previous === undefined) {
      validateAiopsIncidentTransition(null, incident)
      const record = incidentRecordSchema.parse({ sessionId, workspace, revision: 1, updatedAt: Date.now(), incident })
      await this.incidents.put(key, record)
      const stored = toIncidentRecord(record)
      this.ctx.emit('aiopsIncidents/changed', stored)
      return stored
    }
    const stored = toIncidentRecord(previous)
    if (stored.workspace !== workspace) {
      throw new Error(`Session ${sessionId} already reported under workspace ${stored.workspace}.`)
    }
    const next = await this.incidents.update(key, current => {
      validateAiopsIncidentTransition(current.incident, incident)
      return incidentRecordSchema.parse({
        sessionId: current.sessionId,
        workspace: current.workspace,
        revision: current.revision + 1,
        updatedAt: Date.now(),
        incident,
      })
    })
    const result = toIncidentRecord(next)
    this.ctx.emit('aiopsIncidents/changed', result)
    return result
  }

  listIncidents(workspace?: string, limit?: number): AiopsIncidentRecord[] {
    return this.list(this.incidents, workspace, limit)
  }

  listResolved(workspace?: string, limit?: number): AiopsIncidentRecord[] {
    return this.list(this.incidents, workspace, undefined)
      .filter(record => record.incident.status === 'resolved')
      .slice(0, resolveLimit(limit))
  }

  async appendFeedback(sessionId: string, feedback: AiopsOperatorFeedback): Promise<AiopsFeedbackRecord> {
    const incident = this.incidents.get(recordKey(sessionId))
    if (incident === undefined) {
      throw new Error(`Session ${sessionId} has no stored incident report to review.`)
    }
    if (feedback.incidentId !== incident.incident.incidentId || feedback.reportRevision !== incident.revision) {
      throw new Error('The reviewed incident report is no longer the latest stored report for this Session.')
    }
    const key = recordKey(sessionId, feedback.feedbackId)
    const existing = this.feedback.get(key)
    if (existing !== undefined) return toFeedbackRecord(existing)
    const record = feedbackRecordSchema.parse({ sessionId, feedbackId: feedback.feedbackId, time: Date.now(), feedback })
    await this.feedback.put(key, record)
    const stored = toFeedbackRecord(record)
    this.ctx.emit('aiopsFeedback/changed', stored)
    return stored
  }

  latestFeedback(sessionId: string): AiopsFeedbackRecord | undefined {
    let latest: AiopsFeedbackRecord | undefined
    for (const record of this.feedback.entries()) {
      if (record[1].sessionId !== sessionId) continue
      if (latest === undefined || record[1].time > latest.time) latest = toFeedbackRecord(record[1])
    }
    return latest
  }

  listFeedback(workspace?: string, limit?: number): AiopsFeedbackRecord[] {
    const incidentWorkspace = new Map<string, boolean>()
    for (const record of this.incidents.entries()) {
      incidentWorkspace.set(record[1].sessionId, workspace === undefined || record[1].workspace === workspace)
    }
    const records: AiopsFeedbackRecord[] = []
    for (const record of this.feedback.entries()) {
      if (incidentWorkspace.get(record[1].sessionId) === true) records.push(toFeedbackRecord(record[1]))
    }
    return records.sort((left, right) => right.time - left.time || right.sessionId.localeCompare(left.sessionId)).slice(0, resolveLimit(limit))
  }

  onChanged(listener: (record: AiopsIncidentRecord) => void): () => void {
    const dispose = this.ctx.on('aiopsIncidents/changed', listener)
    return () => dispose()
  }

  private list(
    table: KvTable<string, z.infer<typeof incidentRecordSchema>>,
    workspace: string | undefined,
    limit: number | undefined,
  ): AiopsIncidentRecord[] {
    const records: AiopsIncidentRecord[] = []
    for (const entry of table.entries()) {
      if (workspace === undefined || entry[1].workspace === workspace) records.push(toIncidentRecord(entry[1]))
    }
    return records
      .sort((left, right) => right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId))
      .slice(0, resolveLimit(limit))
  }
}

function resolveLimit(limit: number | undefined): number {
  return limit === undefined ? Number.MAX_SAFE_INTEGER : limit
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable AIOps incident and feedback store (the `aiopsIncidents` service). */
    aiopsIncidents: AiopsIncidentStoreApi
  }
  interface Events {
    /** Emitted after one incident report is durable; carries the stored record. */
    'aiopsIncidents/changed'(record: AiopsIncidentRecord): void
    /** Emitted after one operator feedback is durable; carries the stored record. */
    'aiopsFeedback/changed'(record: AiopsFeedbackRecord): void
  }
}
