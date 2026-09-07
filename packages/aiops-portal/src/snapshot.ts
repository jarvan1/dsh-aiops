import type { Context } from '@deepseek-ai/cordis'
import {
  decodeAiopsIncidentState,
  decodeAiopsOperatorFeedback,
} from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome, RouteAuditRecord } from '@deepseek-ai/dsh-aiops-incident-router'
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
  const latestRouteBySession = new Map<string, RouteAuditRecord>()
  for (const record of audit) {
    if (record.sessionId !== undefined && !latestRouteBySession.has(record.sessionId)) {
      latestRouteBySession.set(record.sessionId, record)
    }
  }

  const incidents: PortalIncident[] = []
  for (const session of sessions.slice(0, limits.maxScanSessions)) {
    signal?.throwIfAborted()
    const [reportHits, feedbackHits] = await Promise.all([
      ctx.sessionQuery.filterEvents(session.header.id, [{ kind: 'type', values: ['aiops/incident-state'] }]),
      ctx.sessionQuery.filterEvents(session.header.id, [{ kind: 'type', values: ['aiops/operator-feedback'] }]),
    ])
    const reportHit = reportHits.at(-1)
    if (reportHit === undefined) continue
    const reportWindow = await ctx.sessionQuery.readEvent({ sessionId: session.header.id, seq: reportHit.seq }, signal)
    if (reportWindow.target.type !== 'aiops/incident-state') continue
    const incident = decodeAiopsIncidentState(reportWindow.target.data)
    const feedbackHit = feedbackHits.at(-1)
    let feedback: PortalIncident['feedback']
    if (feedbackHit !== undefined) {
      const feedbackWindow = await ctx.sessionQuery.readEvent({ sessionId: session.header.id, seq: feedbackHit.seq }, signal)
      if (feedbackWindow.target.type === 'aiops/operator-feedback') {
        const decoded = decodeAiopsOperatorFeedback(feedbackWindow.target.data)
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
    version: 1,
    workspace,
    generatedAt: Date.now(),
    summary: summarizePortal(bounded, audit),
    incidents: bounded,
    audit,
  }
}
