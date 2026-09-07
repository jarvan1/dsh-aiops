/** Bounded server-side connectivity probes for candidate monitoring endpoints. */

import { AiopsHttpReadError, readAiopsHttp } from '@deepseek-ai/dsh-aiops-http-read'
import type { ConnectionTarget, ConnectionTestResult } from './types.ts'

const TEST_TIMEOUT_MS = 5_000
const TEST_MAX_RESPONSE_BYTES = 1_000_000
const TEST_TIMEOUT_CODE = 'AIOPS_CONNECTION_TEST_TIMEOUT'

function endpoint(raw: string): URL | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') return undefined
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function testUrl(target: ConnectionTarget, baseUrl: URL): URL {
  if (target === 'prometheus') {
    const url = new URL('api/v1/query', baseUrl)
    url.searchParams.set('query', 'vector(1)')
    return url
  }
  const url = new URL('api/v2/alerts', baseUrl)
  url.searchParams.set('active', 'true')
  url.searchParams.set('silenced', 'true')
  url.searchParams.set('inhibited', 'true')
  url.searchParams.set('unprocessed', 'true')
  return url
}

function validPayload(target: ConnectionTarget, body: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(body) as unknown
  } catch {
    return false
  }
  if (target === 'alertmanager') return Array.isArray(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  return envelope['status'] === 'success'
    && typeof envelope['data'] === 'object'
    && envelope['data'] !== null
    && !Array.isArray(envelope['data'])
}

/** Probe the real provider API without changing the saved settings. */
export async function testEndpointConnection(
  target: ConnectionTarget,
  rawBaseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now()
  const latency = (): number => Math.max(0, Date.now() - startedAt)
  const baseUrl = endpoint(rawBaseUrl)
  if (baseUrl === undefined) return { ok: false, code: 'invalid_url', latencyMs: latency() }

  try {
    const received = await readAiopsHttp({
      url: testUrl(target, baseUrl),
      signal,
      timeoutMs: TEST_TIMEOUT_MS,
      timeoutCode: TEST_TIMEOUT_CODE,
      maxResponseBytes: TEST_MAX_RESPONSE_BYTES,
      fetchImpl,
    })
    if (!received.response.ok) {
      return { ok: false, code: 'http_error', status: received.response.status, latencyMs: latency() }
    }
    return validPayload(target, received.body)
      ? { ok: true, latencyMs: latency() }
      : { ok: false, code: 'invalid_response', latencyMs: latency() }
  } catch (error: unknown) {
    if (!(error instanceof AiopsHttpReadError)) {
      return { ok: false, code: 'unreachable', latencyMs: latency() }
    }
    const code = error.code === 'transport' ? 'unreachable' : error.code
    return { ok: false, code, latencyMs: latency() }
  }
}
