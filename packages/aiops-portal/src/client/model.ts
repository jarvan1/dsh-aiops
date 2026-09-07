import type { PortalIncident } from '../types.ts'

export type SeverityFilter = 'all' | PortalIncident['incident']['severity']
export type StatusFilter = 'all' | PortalIncident['incident']['status']
export type ReviewFilter = 'all' | 'reviewed' | 'unreviewed'

export interface PortalFilters {
  readonly query: string
  readonly severity: SeverityFilter
  readonly status: StatusFilter
  readonly review: ReviewFilter
}

export function filterPortalIncidents(
  incidents: readonly PortalIncident[],
  filters: PortalFilters,
): PortalIncident[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return incidents.filter(item => {
    if (filters.severity !== 'all' && item.incident.severity !== filters.severity) return false
    if (filters.status !== 'all' && item.incident.status !== filters.status) return false
    if (filters.review === 'reviewed' && item.feedback === undefined) return false
    if (filters.review === 'unreviewed' && item.feedback !== undefined) return false
    if (query === '') return true
    const searchable = [
      item.sessionId,
      item.incident.incidentId,
      item.incident.title,
      ...item.incident.evidence.map(value => value.summary),
      ...item.incident.hypotheses.map(value => value.summary),
      ...item.incident.recommendations.map(value => value.action),
      item.feedback?.feedback.note ?? '',
      item.feedback?.feedback.correction ?? '',
      item.lastRoute?.alertname ?? '',
      item.lastRoute?.reason ?? '',
    ].join('\n').toLocaleLowerCase()
    return searchable.includes(query)
  })
}
