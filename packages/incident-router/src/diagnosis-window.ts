/** Deterministic alert-time projection shared by routing events and model prompts. */

import type { AlertmanagerAlert } from '@deepseek-ai/dsh-webhook-alertmanager'
import type { AiopsDiagnosisTimeContext, DiagnosisWindowPolicy } from './types.ts'

const SECOND_MS = 1_000

/** Project an alert start into one bounded, replay-stable observation window. */
export function diagnosisTimeContext(
  alert: Pick<AlertmanagerAlert, 'startsAt'>,
  receivedAt: number,
  policy: DiagnosisWindowPolicy,
): AiopsDiagnosisTimeContext {
  const anchorEpochMs = Date.parse(alert.startsAt)
  if (!Number.isFinite(anchorEpochMs)) throw new TypeError('alert startsAt must be a valid timestamp')
  if (!Number.isFinite(receivedAt)) throw new TypeError('receivedAt must be a finite Unix millisecond timestamp')
  assertPositiveInteger('beforeSeconds', policy.beforeSeconds)
  assertPositiveInteger('afterSeconds', policy.afterSeconds)
  assertPositiveInteger('prometheusStepSeconds', policy.prometheusStepSeconds)
  assertPositiveInteger('logTailLines', policy.logTailLines)

  const startEpochMs = anchorEpochMs - policy.beforeSeconds * SECOND_MS
  const latestEndEpochMs = anchorEpochMs + policy.afterSeconds * SECOND_MS
  const endEpochMs = Math.max(anchorEpochMs, Math.min(receivedAt, latestEndEpochMs))
  const anchor = new Date(anchorEpochMs).toISOString()
  const start = new Date(startEpochMs).toISOString()
  const end = new Date(endEpochMs).toISOString()
  return {
    version: 1,
    anchor: { source: 'alert.startsAt', time: anchor, epochMs: anchorEpochMs },
    window: {
      start,
      end,
      beforeSeconds: policy.beforeSeconds,
      afterSeconds: Math.round((endEpochMs - anchorEpochMs) / SECOND_MS),
    },
    prometheusQueryRange: {
      start,
      end,
      step: `${String(policy.prometheusStepSeconds)}s`,
    },
    kubernetesEvents: { since_time: start, until_time: end },
    kubernetesLogs: {
      since_time: start,
      until_time: end,
      tail_lines: policy.logTailLines,
      timestamps: true,
    },
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}
