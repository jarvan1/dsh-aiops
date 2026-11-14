/** Pure IM message renderers for delivered AIOps diagnoses. @module */

import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import type { AiopsDeliveryProvider } from './types.ts'

/** Session context attached to every rendered message. */
export interface DeliveryMeta {
  /** Owning diagnostic Session id. */
  readonly sessionId: string
  /** Revision of the incident report being pushed. */
  readonly reportRevision: number
  /** Configured Portal base URL for the deep link; absent when unset. */
  readonly portalUrl?: string
}

/** One rendered provider message: human title plus the exact JSON body. */
export interface DeliveryMessage {
  /** Short human-readable notification title. */
  readonly title: string
  /** Complete JSON request body for the provider webhook. */
  readonly body: string
}

/** Largest incident title characters rendered into one message. */
export const MAX_TITLE_CHARS = 120
/** Largest one fact value (for example a hypothesis summary) in characters. */
export const MAX_FACT_CHARS = 200

const SEVERITY_EMOJI = { info: 'ℹ️', warning: '⚠️', critical: '🚨' } as const
const FEISHU_TEMPLATE = { info: 'blue', warning: 'orange', critical: 'red' } as const
const CONFIDENCE_ORDER = ['confirmed', 'strong', 'possible', 'insufficient'] as const

/** Clamp one rendered fragment to a bounded character count. */
export function clampText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Pick the strongest hypothesis by calibrated confidence, keeping the
 * model's own order inside one confidence class.
 */
export function topHypothesis(
  incident: AiopsIncidentState,
): AiopsIncidentState['hypotheses'][number] | undefined {
  for (const confidence of CONFIDENCE_ORDER) {
    const found = incident.hypotheses.find(hypothesis => hypothesis.confidence === confidence)
    if (found !== undefined) return found
  }
  return undefined
}

function facts(
  incident: AiopsIncidentState,
  meta: DeliveryMeta,
): Array<{ readonly label: string; readonly value: string }> {
  const hypothesis = topHypothesis(incident)
  return [
    { label: 'Severity', value: incident.severity },
    { label: 'Status', value: incident.status },
    { label: 'Incident', value: incident.incidentId },
    { label: 'Session', value: `${meta.sessionId} · report r${meta.reportRevision}` },
    { label: 'Evidence', value: `${incident.evidence.length} item(s)` },
    { label: 'Hypotheses', value: `${incident.hypotheses.length}` },
    { label: 'Recommendations', value: `${incident.recommendations.length}` },
    ...(hypothesis === undefined
      ? []
      : [{ label: 'Top hypothesis', value: clampText(hypothesis.summary, MAX_FACT_CHARS) }]),
  ]
}

/** Render a Feishu interactive card for one incident report. */
export function renderFeishuDelivery(incident: AiopsIncidentState, meta: DeliveryMeta): DeliveryMessage {
  const emoji = SEVERITY_EMOJI[incident.severity]
  const title = `${emoji} [AIOps] ${clampText(incident.title, MAX_TITLE_CHARS)}`
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: facts(incident, meta).map(fact => `**${fact.label}:** ${fact.value}`).join('\n') } },
  ]
  if (meta.portalUrl !== undefined) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: 'Open AIOps Portal' },
        type: 'primary',
        url: meta.portalUrl,
      }],
    })
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: 'Diagnosed by DSH AIOps · advisory only; no infrastructure was changed.' }],
  })
  return {
    title,
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: { title: { tag: 'plain_text', content: title }, template: FEISHU_TEMPLATE[incident.severity] },
        elements,
      },
    }),
  }
}

/** Render a DingTalk markdown message for one incident report. */
export function renderDingtalkDelivery(incident: AiopsIncidentState, meta: DeliveryMeta): DeliveryMessage {
  const emoji = SEVERITY_EMOJI[incident.severity]
  const title = `${emoji} [AIOps] ${clampText(incident.title, MAX_TITLE_CHARS)}`
  const notificationTitle = `[AIOps][${incident.severity.toUpperCase()}] ${clampText(incident.title, MAX_TITLE_CHARS)}`
  const lines = [`### ${title}`, ...facts(incident, meta).map(fact => `**${fact.label}:** ${fact.value}`)]
  if (meta.portalUrl !== undefined) lines.push(`[Open AIOps Portal](${meta.portalUrl})`)
  return {
    title: notificationTitle,
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: notificationTitle, text: lines.join('  \n') },
    }),
  }
}

/** Render a Slack incoming-webhook message for one incident report. */
export function renderSlackDelivery(incident: AiopsIncidentState, meta: DeliveryMeta): DeliveryMessage {
  const emoji = SEVERITY_EMOJI[incident.severity]
  const lines = [
    `*${emoji} [AIOps][${incident.severity.toUpperCase()}] ${clampText(incident.title, MAX_TITLE_CHARS)}*`,
    ...facts(incident, meta).map(fact => `*${fact.label}:* ${fact.value}`),
  ]
  if (meta.portalUrl !== undefined) lines.push(`<${meta.portalUrl}|Open AIOps Portal>`)
  return { title: `[AIOps] ${incident.title}`, body: JSON.stringify({ text: lines.join('\n') }) }
}

const RENDERERS: Record<AiopsDeliveryProvider, (
  incident: AiopsIncidentState,
  meta: DeliveryMeta,
) => DeliveryMessage> = {
  feishu: renderFeishuDelivery,
  dingtalk: renderDingtalkDelivery,
  slack: renderSlackDelivery,
}

/** Render one provider message for one incident report. */
export function renderDeliveryMessage(
  provider: AiopsDeliveryProvider,
  incident: AiopsIncidentState,
  meta: DeliveryMeta,
): DeliveryMessage {
  return RENDERERS[provider](incident, meta)
}
