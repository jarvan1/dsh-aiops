import type { Context } from '@deepseek-ai/cordis'
import type { AiopsOperatorFeedback } from '@deepseek-ai/dsh-aiops-incident'
import type { RouteAuditOutcome, RouteAuditRecord } from '@deepseek-ai/dsh-aiops-incident-router'
import type { PortalIncident, PortalSnapshot, PortalSummary } from './types.ts'

export interface PortalLimits {
  readonly maxIncidents: number
  readonly maxAuditRecords: number
  readonly maxScanIncidents: number
}

type PortalContext = Pick<Context, 'aiopsIncidents' | 'aiopsIncidentRouter' | 'aiopsAgents'>

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
export function readPortalSnapshot(ctx: PortalContext, limits: PortalLimits): PortalSnapshot {
  const workspace = ctx.aiopsIncidentRouter.workspacePath
  const audit = ctx.aiopsIncidentRouter.listControlAudit({ limit: limits.maxAuditRecords })
  const routingSettings = ctx.aiopsIncidentRouter.routingSettings()
  const routingPolicyAudit = ctx.aiopsIncidentRouter.listPolicyAudit({ limit: limits.maxAuditRecords })
  const latestRouteBySession = new Map<string, RouteAuditRecord>()
  for (const record of audit) {
    if (record.sessionId !== undefined && !latestRouteBySession.has(record.sessionId)) {
      latestRouteBySession.set(record.sessionId, record)
    }
  }

  // Incident reports and operator feedback are plugin-owned storage-domain
  // records: the shared `aiopsIncidents` store serves them synchronously and
  // workspace-scoped, newest report first.
  const incidents: PortalIncident[] = ctx.aiopsIncidents.listIncidents(workspace, limits.maxScanIncidents)
    .slice(0, limits.maxIncidents)
    .map(record => {
      const feedbackRecord = ctx.aiopsIncidents.latestFeedback(record.sessionId)
      let feedback: PortalIncident['feedback']
      if (feedbackRecord !== undefined) {
        const decoded: AiopsOperatorFeedback = feedbackRecord.feedback
        if (decoded.incidentId === record.incident.incidentId && decoded.reportRevision === record.revision) {
          feedback = { time: feedbackRecord.time, feedback: decoded }
        }
      }
      const lastRoute = latestRouteBySession.get(record.sessionId)
      return {
        sessionId: record.sessionId,
        revision: record.revision,
        updatedAt: record.updatedAt,
        incident: record.incident,
        ...(feedback === undefined ? {} : { feedback }),
        ...(lastRoute === undefined ? {} : { lastRoute }),
      }
    })
  // Agent rows are process + registry state, not workspace state: the cluster
  // list is global to this DSH instance and shown read-only next to incidents.
  return {
    version: 4,
    workspace,
    generatedAt: Date.now(),
    summary: summarizePortal(incidents, audit),
    incidents,
    audit,
    routingSettings,
    routingPolicyAudit,
    clusters: ctx.aiopsAgents.listClusters(),
    needsCluster: !ctx.aiopsAgents.configured(),
  }
}
