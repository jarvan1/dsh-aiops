import type { Context } from '@deepseek-ai/cordis'
import {
  decodeAiopsIncidentState,
  decodeAiopsOperatorFeedback,
} from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome, RouteAuditRecord } from '@deepseek-ai/dsh-aiops-incident-router'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { PortalIncident, PortalSnapshot, PortalSummary } from './types.ts'

export interface PortalLimits {
  readonly maxIncidents: number
  readonly maxAuditRecords: number
  readonly maxScanSessions: number
}

type PortalContext = Pick<Context, 'sessionQuery' | 'aiopsIncidentRouter'>

export function summarizePortal(incidents: readonly PortalIncident[], audit: readonly RouteAuditRecord[]): PortalSummary {
  const auditCounts: Partial<Record<RouteAuditOutcome, number>> = {}
  for (const record of audit) auditCounts[record.outcome] = (auditCounts[record.outcome] ?? 0) + 1
  return {
    totalIncidents: incidents.length,
    active: incidents.filter(item => item.incident.status !== 'resolved').length,
    critical: incidents.filter(item => item.incident.severity === 'critical').length,
    reviewed: incidents.filter(item => item.feedback !== undefined).length,
    confirmed: incidents.filter(item => item.feedback?.feedback.verdict === 'confirmed').length,
    corrected: incidents.filter(item => item.feedback?.feedback.verdict === 'corrected').length,
    rejected: incidents.filter(item => item.feedback?.feedback.verdict === 'rejected').length,
    audit: auditCounts,
  }
}

/** Build one bounded, workspace-owned read model without creating a second data store. */
export async function readPortalSnapshot(
  ctx: PortalContext,
  limits: PortalLimits,
  signal?: AbortSignal,
): Promise<PortalSnapshot> {
  const workspace = ctx.aiopsIncidentRouter.workspacePath
  const sessions = await ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [workspace] }], signal)
  const audit = ctx.aiopsIncidentRouter.listControlAudit({ limit: limits.maxAuditRecords })
  const routingSettings = ctx.aiopsIncidentRouter.routingSettings()
  const routingPolicyAudit = ctx.aiopsIncidentRouter.listPolicyAudit({ limit: limits.maxAuditRecords })
  const latestRouteBySession = new Map<string, RouteAuditRecord>()
  for (const record of audit) {
    if (record.sessionId !== undefined && !latestRouteBySession.has(record.sessionId)) {
      latestRouteBySession.set(record.sessionId, record)
    }
  }

  const incidents: PortalIncident[] = []
  // DSH 0.2.x carries durable incident state as ignorable plugin records; the
  // query seam indexes them but its released types predate the grammar, so
  // hits compare by record-type string and windows decode via pluginRecordOf.
  const INCIDENT_RECORD_TYPE = 'plugin:aiops/incident-state'
  const FEEDBACK_RECORD_TYPE = 'plugin:aiops/operator-feedback'
  for (const session of sessions.slice(0, limits.maxScanSessions)) {
    signal?.throwIfAborted()
    const events = await ctx.sessionQuery.listEvents(session.header.id)
    const reportHits = events.filter(event => event.type === (INCIDENT_RECORD_TYPE as typeof event.type))
    const feedbackHits = events.filter(event => event.type === (FEEDBACK_RECORD_TYPE as typeof event.type))
    const reportHit = reportHits.at(-1)
    if (reportHit === undefined) continue
    const reportWindow = await ctx.sessionQuery.readEvent({ sessionId: session.header.id, seq: reportHit.seq }, signal)
    const reportRecord = pluginRecordOf(reportWindow.target)
    if (reportRecord === undefined || reportRecord.type !== INCIDENT_RECORD_TYPE) continue
    const incident = decodeAiopsIncidentState(reportRecord.data)
    const feedbackHit = feedbackHits.at(-1)
    let feedback: PortalIncident['feedback']
    if (feedbackHit !== undefined) {
      const feedbackWindow = await ctx.sessionQuery.readEvent({ sessionId: session.header.id, seq: feedbackHit.seq }, signal)
      const feedbackRecord = pluginRecordOf(feedbackWindow.target)
      if (feedbackRecord !== undefined && feedbackRecord.type === FEEDBACK_RECORD_TYPE) {
        const decoded = decodeAiopsOperatorFeedback(feedbackRecord.data)
        if (decoded.incidentId === incident.incidentId && decoded.reportSeq === reportHit.seq) {
          feedback = { seq: feedbackHit.seq, time: feedbackHit.time, feedback: decoded }
        }
      }
    }
    const lastRoute = latestRouteBySession.get(session.header.id)
    incidents.push({
      sessionId: session.header.id,
      reportSeq: reportHit.seq,
      reportTime: reportHit.time,
      incident,
      ...(feedback === undefined ? {} : { feedback }),
      ...(lastRoute === undefined ? {} : { lastRoute }),
    })
  }
  incidents.sort((left, right) => right.reportTime - left.reportTime || right.reportSeq - left.reportSeq)
  const bounded = incidents.slice(0, limits.maxIncidents)
  return {
    version: 2,
    workspace,
    generatedAt: Date.now(),
    summary: summarizePortal(bounded, audit),
    incidents: bounded,
    audit,
    routingSettings,
    routingPolicyAudit,
  }
}
