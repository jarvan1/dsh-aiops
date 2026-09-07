/** SQLite state machine for Alertmanager fingerprint rounds and delivery replay protection. */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { AlertmanagerAlert } from '@deepseek-ai/dsh-webhook-alertmanager'

/** Routing result for one accepted alert. */
export type AcceptedRouteDecision = 'created' | 'appended' | 'resolved' | 'reopened' | 'repeated-resolved'

/** Why one eligible alert did not begin a model turn immediately. */
export type RouteControlReason =
  | 'ready'
  | 'fingerprint-grouped'
  | 'cooldown'
  | 'global-concurrency'
  | 'severity-concurrency'
  | 'global-token-budget'
  | 'severity-token-budget'
  | 'queue-full'
  | 'queue-expired'
  | 'dispatch-failed'
  | 'restart-recovery'

/** Auditable lifecycle transition for one eligible or policy-filtered alert. */
export type RouteAuditOutcome = 'filtered' | 'deferred' | 'grouped' | 'dropped' | 'started' | 'completed' | 'failed'

/** One persisted alert waiting for a bounded diagnostic turn. */
export interface QueuedRoute {
  readonly source: string
  readonly deliveryId: string
  readonly payloadDigest: string
  readonly receivedAt: number
  readonly severity: 'info' | 'warning' | 'critical'
  readonly event: import('@deepseek-ai/dsh-webhook-alertmanager').AlertmanagerWebhookEvent
  readonly alert: AlertmanagerAlert
  readonly reason: RouteControlReason
  readonly availableAt: number
  readonly attempt: number
}

/** Workspace-owned router audit row exposed through history tooling. */
export interface RouteAuditRecord {
  readonly id: number
  readonly source: string
  readonly deliveryId: string
  readonly fingerprint: string
  readonly alertname: string
  readonly severity?: 'info' | 'warning' | 'critical'
  readonly outcome: RouteAuditOutcome
  readonly reason: string
  readonly sessionId?: string
  readonly round?: number
  readonly queueDepth: number
  readonly reservedTokens: number
  readonly recordedAt: number
  readonly attempt: number
}

/** Durable result returned for an accepted alert delivery. */
export interface AcceptedRoute {
  readonly replay: boolean
  readonly decision: AcceptedRouteDecision
  readonly sessionId: SessionIdType
  readonly round: number
  readonly severity: 'info' | 'warning' | 'critical'
}

/** Prior outcome for one exact delivery and fingerprint, independent of current policy. */
export type PriorDeliveryRoute =
  | { readonly kind: 'accepted'; readonly route: AcceptedRoute }
  | { readonly kind: 'filtered' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'dropped' }

interface CurrentRouteRow {
  current_round: number
  session_id: string
  alert_status: 'firing' | 'resolved'
}

interface DeliveryRouteRow {
  payload_digest: string
  session_id: string
  round: number
  decision: AcceptedRouteDecision
  severity: 'info' | 'warning' | 'critical'
}

interface WorkRow {
  source: string
  delivery_id: string
  fingerprint: string
  payload_digest: string
  received_at: number
  severity: 'info' | 'warning' | 'critical'
  event_json: string
  alert_json: string
  state: 'queued' | 'processing' | 'completed' | 'dropped'
  reason: RouteControlReason
  available_at: number
  attempts: number
}

/** Stable Session identity for one source, fingerprint, and alert round. */
export function incidentSessionId(source: string, fingerprint: string, round: number): SessionIdType {
  const digest = createHash('sha256')
    .update(JSON.stringify([source, fingerprint, round]))
    .digest('hex')
    .slice(0, 32)
  return SessionId(`aiops-${digest}`)
}

/** Synchronous SQLite store; transactions serialize competing deliveries before any Session work begins. */
export class IncidentRouteStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    const existing = path !== ':memory:' && existsSync(path)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && !existing) chmodSync(path, 0o600)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version < 0 || version.user_version > 2) {
      this.db.close()
      throw new Error(`incident router schema version ${String(version.user_version)} is unsupported`)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fingerprint_routes (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        current_round INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        alert_status TEXT NOT NULL CHECK (alert_status IN ('firing', 'resolved')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, fingerprint)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS incident_rounds (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        round INTEGER NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        opened_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (source, fingerprint, round)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_routes (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        decision TEXT NOT NULL,
        severity TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source, delivery_id, fingerprint)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS delivery_batches (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source, delivery_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS filtered_deliveries (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        alertname TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source, delivery_id, fingerprint)
      ) STRICT;
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_work (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
        event_json TEXT NOT NULL,
        alert_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'completed', 'dropped')),
        reason TEXT NOT NULL,
        available_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, delivery_id, fingerprint)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS route_work_ready
        ON route_work (state, available_at, received_at);
      CREATE TABLE IF NOT EXISTS route_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        alertname TEXT NOT NULL,
        severity TEXT CHECK (severity IN ('info', 'warning', 'critical')),
        outcome TEXT NOT NULL CHECK (outcome IN ('filtered', 'deferred', 'grouped', 'dropped', 'started', 'completed', 'failed')),
        reason TEXT NOT NULL,
        session_id TEXT,
        round INTEGER,
        queue_depth INTEGER NOT NULL,
        reserved_tokens INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        UNIQUE (source, delivery_id, fingerprint, outcome, attempt)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fingerprint_dispatch (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        dispatched_at INTEGER NOT NULL,
        PRIMARY KEY (source, fingerprint)
      ) STRICT;
      PRAGMA user_version = 2;
    `)
    this.recoverProcessingWork(Date.now())
  }

  /** Close the database after webhook invocations drain. */
  close(): void {
    this.db.close()
  }

  /** Admit one delivery id once and reject later reuse with different authenticated bytes. */
  admitDelivery(input: {
    readonly source: string
    readonly deliveryId: string
    readonly payloadDigest: string
    readonly receivedAt: number
  }): boolean {
    const prior = this.db.prepare(`
      SELECT payload_digest FROM delivery_batches WHERE source = ? AND delivery_id = ?
    `).get(input.source, input.deliveryId) as { payload_digest: string } | undefined
    if (prior !== undefined) {
      if (prior.payload_digest !== input.payloadDigest) {
        throw new Error('Alertmanager delivery id was reused with different content')
      }
      return false
    }
    this.db.prepare(`
      INSERT INTO delivery_batches (source, delivery_id, payload_digest, received_at)
      VALUES (?, ?, ?, ?)
    `).run(input.source, input.deliveryId, input.payloadDigest, input.receivedAt)
    return true
  }

  /** Read a completed per-alert outcome so retries cannot change under a new routing policy. */
  priorDelivery(input: {
    readonly source: string
    readonly deliveryId: string
    readonly fingerprint: string
    readonly payloadDigest: string
  }): PriorDeliveryRoute | undefined {
    const controlled = this.db.prepare(`
      SELECT payload_digest, state FROM route_work
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).get(input.source, input.deliveryId, input.fingerprint) as {
      payload_digest: string
      state: WorkRow['state']
    } | undefined
    if (controlled !== undefined) {
      if (controlled.payload_digest !== input.payloadDigest) {
        throw new Error('Alertmanager delivery id was reused with different content')
      }
      if (controlled.state === 'queued' || controlled.state === 'processing') return { kind: 'queued' }
      if (controlled.state === 'dropped') return { kind: 'dropped' }
    }
    const accepted = this.db.prepare(`
      SELECT payload_digest, session_id, round, decision, severity
      FROM delivery_routes
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).get(input.source, input.deliveryId, input.fingerprint) as DeliveryRouteRow | undefined
    if (accepted !== undefined) {
      if (accepted.payload_digest !== input.payloadDigest) {
        throw new Error('Alertmanager delivery id was reused with different content')
      }
      return {
        kind: 'accepted',
        route: {
          replay: true,
          decision: accepted.decision,
          sessionId: SessionId(accepted.session_id),
          round: accepted.round,
          severity: accepted.severity,
        },
      }
    }
    const filtered = this.db.prepare(`
      SELECT payload_digest FROM filtered_deliveries
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).get(input.source, input.deliveryId, input.fingerprint) as { payload_digest: string } | undefined
    if (filtered === undefined) return undefined
    if (filtered.payload_digest !== input.payloadDigest) {
      throw new Error('Alertmanager delivery id was reused with different content')
    }
    return { kind: 'filtered' }
  }

  /** Record one filtered alert idempotently for operational audit. */
  recordFiltered(input: {
    readonly source: string
    readonly deliveryId: string
    readonly payloadDigest: string
    readonly alert: AlertmanagerAlert
    readonly reason: 'alertname-not-allowed' | 'severity-not-mapped'
    readonly receivedAt: number
  }): void {
    const prior = this.db.prepare(`
      SELECT payload_digest FROM filtered_deliveries
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).get(input.source, input.deliveryId, input.alert.fingerprint) as { payload_digest: string } | undefined
    if (prior !== undefined) {
      if (prior.payload_digest !== input.payloadDigest) {
        throw new Error('Alertmanager delivery id was reused with different content')
      }
      return
    }
    this.db.prepare(`
      INSERT INTO filtered_deliveries
        (source, delivery_id, fingerprint, payload_digest, alertname, reason, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.deliveryId,
      input.alert.fingerprint,
      input.payloadDigest,
      input.alert.labels['alertname'] ?? '',
      input.reason,
      input.receivedAt,
    )
    this.appendAudit({
      source: input.source,
      deliveryId: input.deliveryId,
      fingerprint: input.alert.fingerprint,
      alertname: input.alert.labels['alertname'] ?? '',
      outcome: 'filtered',
      reason: input.reason,
      recordedAt: input.receivedAt,
    })
  }

  /** Persist an eligible alert before any Agent is opened or model budget is reserved. */
  enqueue(input: {
    readonly source: string
    readonly deliveryId: string
    readonly payloadDigest: string
    readonly receivedAt: number
    readonly severity: 'info' | 'warning' | 'critical'
    readonly event: import('@deepseek-ai/dsh-webhook-alertmanager').AlertmanagerWebhookEvent
    readonly alert: AlertmanagerAlert
    readonly reason: RouteControlReason
    readonly availableAt: number
    readonly maxQueueSize: number
    readonly now: number
  }): 'queued' | 'dropped' | 'existing' {
    const prior = this.priorDelivery({
      source: input.source,
      deliveryId: input.deliveryId,
      fingerprint: input.alert.fingerprint,
      payloadDigest: input.payloadDigest,
    })
    if (prior !== undefined) return 'existing'
    const depth = this.queueDepth()
    const drop = depth >= input.maxQueueSize
    const state = drop ? 'dropped' : 'queued'
    const reason: RouteControlReason = drop ? 'queue-full' : input.reason
    this.db.prepare(`
      INSERT INTO route_work
        (source, delivery_id, fingerprint, payload_digest, received_at, severity,
         event_json, alert_json, state, reason, available_at, attempts, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      input.source,
      input.deliveryId,
      input.alert.fingerprint,
      input.payloadDigest,
      input.receivedAt,
      input.severity,
      JSON.stringify(input.event),
      JSON.stringify(input.alert),
      state,
      reason,
      input.availableAt,
      input.now,
    )
    if (drop) {
      this.appendAudit({ ...input, outcome: 'dropped', reason, queueDepth: depth, recordedAt: input.now })
      return 'dropped'
    }
    if (reason !== 'ready') {
      this.appendAudit({
        ...input,
        outcome: reason === 'fingerprint-grouped' ? 'grouped' : 'deferred',
        reason,
        queueDepth: depth + 1,
        recordedAt: input.now,
      })
    }
    return 'queued'
  }

  /** Number of durable queued or currently dispatched work items. */
  queueDepth(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM route_work WHERE state IN ('queued', 'processing')
    `).get() as { count: number }
    return row.count
  }

  /** Whether a fingerprint already has queued or in-flight work to coalesce with. */
  hasPendingFingerprint(source: string, fingerprint: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM route_work
      WHERE source = ? AND fingerprint = ? AND state IN ('queued', 'processing') LIMIT 1
    `).get(source, fingerprint) !== undefined
  }

  /** Latest turn dispatch for the fingerprint, used to derive cooldown availability. */
  lastDispatchAt(source: string, fingerprint: string): number | undefined {
    const row = this.db.prepare(`
      SELECT dispatched_at FROM fingerprint_dispatch WHERE source = ? AND fingerprint = ?
    `).get(source, fingerprint) as { dispatched_at: number } | undefined
    return row?.dispatched_at
  }

  /** Ready fingerprint groups ordered by severity and first receipt time. */
  readyGroups(now: number): { source: string; fingerprint: string; severity: 'info' | 'warning' | 'critical' }[] {
    return this.db.prepare(`
      SELECT source, fingerprint,
        CASE MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
          WHEN 3 THEN 'critical' WHEN 2 THEN 'warning' ELSE 'info' END AS severity
      FROM route_work
      WHERE state = 'queued' AND available_at <= ?
      GROUP BY source, fingerprint
      ORDER BY MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) DESC,
        MIN(received_at) ASC, source ASC, fingerprint ASC
    `).all(now) as { source: string; fingerprint: string; severity: 'info' | 'warning' | 'critical' }[]
  }

  /** Record why a currently ready fingerprint group remains queued. */
  deferGroup(
    source: string,
    fingerprint: string,
    reason: Extract<RouteControlReason,
    'global-concurrency' | 'severity-concurrency' | 'global-token-budget' | 'severity-token-budget'>,
    now: number,
    reservedTokens: number,
  ): void {
    const rows = this.db.prepare(`
      SELECT * FROM route_work
      WHERE source = ? AND fingerprint = ? AND state = 'queued'
      ORDER BY received_at ASC, delivery_id ASC
    `).all(source, fingerprint) as unknown as WorkRow[]
    this.db.prepare(`
      UPDATE route_work SET reason = ?, updated_at = ?
      WHERE source = ? AND fingerprint = ? AND state = 'queued'
    `).run(reason, now, source, fingerprint)
    const depth = this.queueDepth()
    for (const row of rows) {
      if (row.reason === reason) continue
      this.appendAudit({
        ...this.decodeWork(row, row.attempts),
        outcome: 'deferred',
        reason,
        queueDepth: depth,
        reservedTokens,
        recordedAt: now,
        attempt: row.attempts,
      })
    }
  }

  /** Atomically claim the leading same-status alerts for one fingerprint as one model turn. */
  claimGroup(source: string, fingerprint: string, now: number): QueuedRoute[] {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db.prepare(`
        SELECT * FROM route_work
        WHERE source = ? AND fingerprint = ? AND state = 'queued' AND available_at <= ?
        ORDER BY received_at ASC, delivery_id ASC
      `).all(source, fingerprint, now) as unknown as WorkRow[]
      const first = rows[0]
      if (first === undefined) {
        this.db.exec('COMMIT')
        return []
      }
      const firstStatus = (JSON.parse(first.alert_json) as AlertmanagerAlert).status
      const claimed: WorkRow[] = []
      for (const row of rows) {
        const status = (JSON.parse(row.alert_json) as AlertmanagerAlert).status
        if (status !== firstStatus) break
        claimed.push(row)
      }
      const update = this.db.prepare(`
        UPDATE route_work SET state = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE source = ? AND delivery_id = ? AND fingerprint = ? AND state = 'queued'
      `)
      for (const row of claimed) update.run(now, row.source, row.delivery_id, row.fingerprint)
      this.db.exec('COMMIT')
      return claimed.map(row => this.decodeWork(row, row.attempts + 1))
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Audit the start and push later same-fingerprint work behind the new cooldown. */
  markStarted(
    work: QueuedRoute,
    route: AcceptedRoute,
    now: number,
    cooldownUntil: number,
    reservedTokens: number,
  ): void {
    this.db.prepare(`
      INSERT INTO fingerprint_dispatch (source, fingerprint, dispatched_at) VALUES (?, ?, ?)
      ON CONFLICT (source, fingerprint) DO UPDATE SET dispatched_at = excluded.dispatched_at
    `).run(work.source, work.alert.fingerprint, now)
    this.db.prepare(`
      UPDATE route_work SET available_at = MAX(available_at, ?), reason = 'cooldown', updated_at = ?
      WHERE source = ? AND fingerprint = ? AND state = 'queued'
    `).run(cooldownUntil, now, work.source, work.alert.fingerprint)
    this.appendAudit({
      ...work,
      outcome: 'started',
      reason: work.reason,
      sessionId: route.sessionId,
      round: route.round,
      queueDepth: this.queueDepth(),
      reservedTokens,
      recordedAt: now,
      attempt: work.attempt,
    })
  }

  /** Mark one queued delivery durably handed to its Session. */
  markCompleted(work: QueuedRoute, route: AcceptedRoute, now: number, reservedTokens: number): void {
    this.db.prepare(`
      UPDATE route_work SET state = 'completed', updated_at = ?
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).run(now, work.source, work.deliveryId, work.alert.fingerprint)
    this.appendAudit({
      ...work,
      outcome: 'completed',
      reason: 'session-followup-durable',
      sessionId: route.sessionId,
      round: route.round,
      queueDepth: this.queueDepth(),
      reservedTokens,
      recordedAt: now,
      attempt: work.attempt,
    })
  }

  /** Retry a failed dispatch with bounded attempts, otherwise make the drop explicit. */
  retryOrDrop(work: QueuedRoute, now: number, retryAt: number, maxAttempts: number, message: string): void {
    const drop = work.attempt >= maxAttempts
    this.db.prepare(`
      UPDATE route_work SET state = ?, reason = ?, available_at = ?, updated_at = ?
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).run(
      drop ? 'dropped' : 'queued',
      'dispatch-failed',
      retryAt,
      now,
      work.source,
      work.deliveryId,
      work.alert.fingerprint,
    )
    this.appendAudit({
      ...work,
      outcome: drop ? 'dropped' : 'failed',
      reason: `dispatch-failed:${message.slice(0, 500)}`,
      queueDepth: this.queueDepth(),
      recordedAt: now,
      attempt: work.attempt,
    })
  }

  /** Drop queued work that exceeded its deployment-owned maximum age. */
  dropExpired(now: number, maxAgeMs: number): number {
    const rows = this.db.prepare(`
      SELECT * FROM route_work
      WHERE state = 'queued' AND received_at < ?
    `).all(now - maxAgeMs) as unknown as WorkRow[]
    for (const row of rows) {
      this.db.prepare(`
        UPDATE route_work SET state = 'dropped', reason = 'queue-expired', updated_at = ?
        WHERE source = ? AND delivery_id = ? AND fingerprint = ? AND state = 'queued'
      `).run(now, row.source, row.delivery_id, row.fingerprint)
      const work = this.decodeWork(row, row.attempts)
      this.appendAudit({ ...work, outcome: 'dropped', reason: 'queue-expired', recordedAt: now })
    }
    return rows.length
  }

  /** Earliest future wake time for cooldown/retry scheduling. */
  nextAvailableAt(): number | undefined {
    const row = this.db.prepare(`
      SELECT MIN(available_at) AS available_at FROM route_work WHERE state = 'queued'
    `).get() as { available_at: number | null }
    return row.available_at ?? undefined
  }

  /** Read bounded newest-first control history for the configured workspace. */
  listAudit(input: { readonly limit: number; readonly outcome?: RouteAuditOutcome; readonly query?: string }): RouteAuditRecord[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (input.outcome !== undefined) {
      clauses.push('outcome = ?')
      params.push(input.outcome)
    }
    if (input.query !== undefined && input.query.trim() !== '') {
      clauses.push("instr(lower(source || '\n' || delivery_id || '\n' || fingerprint || '\n' || alertname || '\n' || reason || '\n' || coalesce(session_id, '')), lower(?)) > 0")
      params.push(input.query.trim())
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const rows = this.db.prepare(`
      SELECT * FROM route_audit ${where}
      ORDER BY recorded_at DESC, audit_id DESC LIMIT ?
    `).all(...params, input.limit) as unknown as Array<{
      audit_id: number; source: string; delivery_id: string; fingerprint: string; alertname: string
      severity: 'info' | 'warning' | 'critical' | null; outcome: RouteAuditOutcome; reason: string
      session_id: string | null; round: number | null; queue_depth: number; reserved_tokens: number
      recorded_at: number; attempt: number
    }>
    return rows.map(row => ({
      id: row.audit_id,
      source: row.source,
      deliveryId: row.delivery_id,
      fingerprint: row.fingerprint,
      alertname: row.alertname,
      ...(row.severity === null ? {} : { severity: row.severity }),
      outcome: row.outcome,
      reason: row.reason,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.round === null ? {} : { round: row.round }),
      queueDepth: row.queue_depth,
      reservedTokens: row.reserved_tokens,
      recordedAt: row.recorded_at,
      attempt: row.attempt,
    }))
  }

  private recoverProcessingWork(now: number): void {
    const rows = this.db.prepare(`SELECT * FROM route_work WHERE state = 'processing'`).all() as unknown as WorkRow[]
    for (const row of rows) {
      this.db.prepare(`
        UPDATE route_work SET state = 'queued', reason = 'restart-recovery', available_at = ?, updated_at = ?
        WHERE source = ? AND delivery_id = ? AND fingerprint = ?
      `).run(now, now, row.source, row.delivery_id, row.fingerprint)
      this.appendAudit({
        ...this.decodeWork(row, row.attempts),
        outcome: 'deferred',
        reason: 'restart-recovery',
        recordedAt: now,
      })
    }
  }

  private decodeWork(row: WorkRow, attempt: number): QueuedRoute {
    return {
      source: row.source,
      deliveryId: row.delivery_id,
      payloadDigest: row.payload_digest,
      receivedAt: row.received_at,
      severity: row.severity,
      event: JSON.parse(row.event_json) as QueuedRoute['event'],
      alert: JSON.parse(row.alert_json) as AlertmanagerAlert,
      reason: row.reason,
      availableAt: row.available_at,
      attempt,
    }
  }

  private appendAudit(input: {
    readonly source: string
    readonly deliveryId: string
    readonly fingerprint?: string
    readonly alert?: AlertmanagerAlert
    readonly alertname?: string
    readonly severity?: 'info' | 'warning' | 'critical'
    readonly outcome: RouteAuditOutcome
    readonly reason: string
    readonly sessionId?: string
    readonly round?: number
    readonly queueDepth?: number
    readonly reservedTokens?: number
    readonly recordedAt: number
    readonly attempt?: number
  }): void {
    const fingerprint = input.fingerprint ?? input.alert?.fingerprint ?? ''
    const alertname = input.alertname ?? input.alert?.labels['alertname'] ?? ''
    this.db.prepare(`
      INSERT OR IGNORE INTO route_audit
        (source, delivery_id, fingerprint, alertname, severity, outcome, reason,
         session_id, round, queue_depth, reserved_tokens, recorded_at, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.deliveryId,
      fingerprint,
      alertname,
      input.severity ?? null,
      input.outcome,
      input.reason,
      input.sessionId ?? null,
      input.round ?? null,
      input.queueDepth ?? this.queueDepth(),
      input.reservedTokens ?? 0,
      input.recordedAt,
      input.attempt ?? 0,
    )
  }

  /** Resolve one accepted alert delivery inside a single immediate transaction. */
  route(input: {
    readonly source: string
    readonly deliveryId: string
    readonly payloadDigest: string
    readonly alert: AlertmanagerAlert
    readonly severity: 'info' | 'warning' | 'critical'
    readonly receivedAt: number
  }): AcceptedRoute {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.routeInTransaction(input)
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Route after the caller owns the SQLite writer transaction. */
  private routeInTransaction(input: {
    readonly source: string
    readonly deliveryId: string
    readonly payloadDigest: string
    readonly alert: AlertmanagerAlert
    readonly severity: 'info' | 'warning' | 'critical'
    readonly receivedAt: number
  }): AcceptedRoute {
    const accepted = this.db.prepare(`
      SELECT payload_digest, session_id, round, decision, severity
      FROM delivery_routes
      WHERE source = ? AND delivery_id = ? AND fingerprint = ?
    `).get(input.source, input.deliveryId, input.alert.fingerprint) as DeliveryRouteRow | undefined
    if (accepted !== undefined) {
      if (accepted.payload_digest !== input.payloadDigest) {
        throw new Error('Alertmanager delivery id was reused with different content')
      }
      return {
        replay: true,
        decision: accepted.decision,
        sessionId: SessionId(accepted.session_id),
        round: accepted.round,
        severity: accepted.severity,
      }
    }
    const priorDelivery = this.priorDelivery({
      source: input.source,
      deliveryId: input.deliveryId,
      fingerprint: input.alert.fingerprint,
      payloadDigest: input.payloadDigest,
    })
    if (priorDelivery?.kind === 'accepted') return priorDelivery.route
    if (priorDelivery?.kind === 'filtered') {
      throw new Error('filtered Alertmanager delivery cannot enter accepted routing')
    }

    const current = this.db.prepare(`
      SELECT current_round, session_id, alert_status
      FROM fingerprint_routes WHERE source = ? AND fingerprint = ?
    `).get(input.source, input.alert.fingerprint) as CurrentRouteRow | undefined
    let round: number
    let sessionId: SessionIdType
    let decision: AcceptedRouteDecision

    if (current === undefined) {
      round = 1
      sessionId = incidentSessionId(input.source, input.alert.fingerprint, round)
      decision = input.alert.status === 'firing' ? 'created' : 'resolved'
      this.db.prepare(`
        INSERT INTO fingerprint_routes
          (source, fingerprint, current_round, session_id, alert_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.source, input.alert.fingerprint, round, sessionId, input.alert.status, input.receivedAt)
      this.db.prepare(`
        INSERT INTO incident_rounds
          (source, fingerprint, round, session_id, opened_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.source,
        input.alert.fingerprint,
        round,
        sessionId,
        input.receivedAt,
        input.alert.status === 'resolved' ? input.receivedAt : null,
      )
    } else if (current.alert_status === 'resolved' && input.alert.status === 'firing') {
      round = current.current_round + 1
      sessionId = incidentSessionId(input.source, input.alert.fingerprint, round)
      decision = 'reopened'
      this.db.prepare(`
        UPDATE fingerprint_routes
        SET current_round = ?, session_id = ?, alert_status = 'firing', updated_at = ?
        WHERE source = ? AND fingerprint = ?
      `).run(round, sessionId, input.receivedAt, input.source, input.alert.fingerprint)
      this.db.prepare(`
        INSERT INTO incident_rounds
          (source, fingerprint, round, session_id, opened_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(input.source, input.alert.fingerprint, round, sessionId, input.receivedAt)
    } else {
      round = current.current_round
      sessionId = SessionId(current.session_id)
      decision = input.alert.status === 'resolved'
        ? current.alert_status === 'resolved' ? 'repeated-resolved' : 'resolved'
        : 'appended'
      this.db.prepare(`
        UPDATE fingerprint_routes SET alert_status = ?, updated_at = ?
        WHERE source = ? AND fingerprint = ?
      `).run(input.alert.status, input.receivedAt, input.source, input.alert.fingerprint)
      if (input.alert.status === 'resolved' && current.alert_status !== 'resolved') {
        this.db.prepare(`
          UPDATE incident_rounds SET resolved_at = ?
          WHERE source = ? AND fingerprint = ? AND round = ?
        `).run(input.receivedAt, input.source, input.alert.fingerprint, round)
      }
    }

    this.db.prepare(`
      INSERT INTO delivery_routes
        (source, delivery_id, fingerprint, payload_digest, session_id, round, decision, severity, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.deliveryId,
      input.alert.fingerprint,
      input.payloadDigest,
      sessionId,
      round,
      decision,
      input.severity,
      input.receivedAt,
    )
    return { replay: false, decision, sessionId, round, severity: input.severity }
  }
}
