/** Alertmanager v4 payload validation and provider-neutral normalization. */

import { createHash } from 'node:crypto'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { AlertmanagerWebhookHttpError } from './body.ts'
import type { AlertmanagerAlert, AlertmanagerStringMap, AlertmanagerWebhookEvent } from './types.ts'

type JsonRecord = Record<string, unknown>

/** Require a plain record at one provider field. */
function record(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} must be an object`)
  }
  return value as JsonRecord
}

/** Read one required bounded string. */
function requiredString(value: unknown, field: string, maxTextChars: number): string {
  if (typeof value !== 'string' || value === '' || value.length > maxTextChars) {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} must be a non-empty bounded string`)
  }
  return value
}

/** Read one optional bounded string. */
function optionalString(value: unknown, field: string, maxTextChars: number): string | undefined {
  if (value === undefined || value === '') return undefined
  return requiredString(value, field, maxTextChars)
}

/** Admit only the two Alertmanager lifecycle tags. */
function status(value: unknown, field: string): 'firing' | 'resolved' {
  if (value !== 'firing' && value !== 'resolved') {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} must be firing or resolved`)
  }
  return value
}

/** Snapshot a bounded string dictionary in sorted key order. */
function stringMap(
  value: unknown,
  field: string,
  maxMapEntries: number,
  maxTextChars: number,
): AlertmanagerStringMap {
  if (value === undefined) return {}
  const source = record(value, field)
  const entries = Object.entries(source).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length > maxMapEntries) {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} has too many entries`)
  }
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (key === '' || key.length > maxTextChars || typeof raw !== 'string' || raw.length > maxTextChars) {
      throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} must contain bounded string pairs`)
    }
    output[key] = raw
  }
  return Object.freeze(output)
}

/** Require a parseable RFC3339-compatible timestamp without rewriting provider precision. */
function timestamp(value: unknown, field: string, maxTextChars: number): string {
  const text = requiredString(value, field, maxTextChars)
  if (!Number.isFinite(Date.parse(text))) {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager ${field} must be a valid timestamp`)
  }
  return text
}

/** Derive the fallback identity from labels alone so firing and resolved deliveries correlate. */
function labelFingerprint(labels: AlertmanagerStringMap): string {
  return createHash('sha256').update(JSON.stringify(labels)).digest('hex').slice(0, 32)
}

/** Normalize one alert and reject a malformed provider fingerprint. */
function normalizeAlert(
  value: unknown,
  index: number,
  maxMapEntries: number,
  maxTextChars: number,
): AlertmanagerAlert {
  const source = record(value, `alerts[${String(index)}]`)
  const labels = stringMap(source['labels'], `alerts[${String(index)}].labels`, maxMapEntries, maxTextChars)
  if (labels['alertname'] === undefined || labels['alertname'] === '') {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager alerts[${String(index)}].labels.alertname is required`)
  }
  const supplied = source['fingerprint']
  if (supplied !== undefined && (typeof supplied !== 'string' || !/^[0-9a-f]{16,64}$/i.test(supplied))) {
    throw new AlertmanagerWebhookHttpError(400, `Alertmanager alerts[${String(index)}].fingerprint is invalid`)
  }
  const fingerprint = supplied === undefined ? labelFingerprint(labels) : supplied.toLowerCase()
  const generatorUrl = optionalString(source['generatorURL'], `alerts[${String(index)}].generatorURL`, maxTextChars)
  return Object.freeze({
    status: status(source['status'], `alerts[${String(index)}].status`),
    labels,
    annotations: stringMap(source['annotations'], `alerts[${String(index)}].annotations`, maxMapEntries, maxTextChars),
    startsAt: timestamp(source['startsAt'], `alerts[${String(index)}].startsAt`, maxTextChars),
    endsAt: timestamp(source['endsAt'], `alerts[${String(index)}].endsAt`, maxTextChars),
    ...(generatorUrl === undefined ? {} : { generatorUrl }),
    fingerprint,
    fingerprintSource: supplied === undefined ? 'labels-sha256' : 'provider',
  })
}

/** Parse and normalize one authenticated Alertmanager webhook body. */
export function normalizeAlertmanagerWebhook(
  body: string,
  limits: { readonly maxAlerts: number; readonly maxMapEntries: number; readonly maxTextChars: number },
): AlertmanagerWebhookEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AlertmanagerWebhookHttpError(400, 'request body is not valid JSON')
  }
  if (snapshotJsonValue(parsed) === undefined) {
    throw new AlertmanagerWebhookHttpError(400, 'Alertmanager webhook payload is not lossless JSON')
  }
  const source = record(parsed, 'payload')
  if (source['version'] !== '4') {
    throw new AlertmanagerWebhookHttpError(400, 'Alertmanager payload version must be 4')
  }
  const rawAlerts = source['alerts']
  if (!Array.isArray(rawAlerts) || rawAlerts.length === 0 || rawAlerts.length > limits.maxAlerts) {
    throw new AlertmanagerWebhookHttpError(400, 'Alertmanager alerts must be a non-empty bounded array')
  }
  const alerts = rawAlerts.map((alert, index) => normalizeAlert(
    alert,
    index,
    limits.maxMapEntries,
    limits.maxTextChars,
  ))
  const fingerprints = new Set(alerts.map(alert => alert.fingerprint))
  if (fingerprints.size !== alerts.length) {
    throw new AlertmanagerWebhookHttpError(400, 'Alertmanager alert fingerprints must be unique within one delivery')
  }
  const truncatedAlerts = source['truncatedAlerts'] ?? 0
  if (!Number.isSafeInteger(truncatedAlerts) || (truncatedAlerts as number) < 0) {
    throw new AlertmanagerWebhookHttpError(400, 'Alertmanager truncatedAlerts must be a non-negative safe integer')
  }
  const externalUrl = optionalString(source['externalURL'], 'externalURL', limits.maxTextChars)
  return Object.freeze({
    version: 1,
    payloadDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    status: status(source['status'], 'status'),
    receiver: requiredString(source['receiver'], 'receiver', limits.maxTextChars),
    groupKey: requiredString(source['groupKey'], 'groupKey', limits.maxTextChars),
    truncatedAlerts: truncatedAlerts as number,
    groupLabels: stringMap(source['groupLabels'], 'groupLabels', limits.maxMapEntries, limits.maxTextChars),
    commonLabels: stringMap(source['commonLabels'], 'commonLabels', limits.maxMapEntries, limits.maxTextChars),
    commonAnnotations: stringMap(source['commonAnnotations'], 'commonAnnotations', limits.maxMapEntries, limits.maxTextChars),
    ...(externalUrl === undefined ? {} : { externalUrl }),
    alerts: Object.freeze(alerts),
  })
}
