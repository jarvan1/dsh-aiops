/** Bounded read-only HTTP response acquisition for AIOps Providers. @module @deepseek-ai/dsh-aiops-http-read */

import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Failure class that capability Providers translate into their public error type. */
export class AiopsHttpReadError extends Error {
  /** Stable transport failure kind. */
  readonly code: 'response_too_large' | 'timeout' | 'transport'

  /**
   * Create one transport failure.
   * @param code - stable failure kind.
   * @param cause - optional Fetch failure.
   */
  constructor(code: AiopsHttpReadError['code'], cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.name = 'AiopsHttpReadError'
    this.code = code
  }
}

/** Inputs for one bounded GET request. */
export interface AiopsHttpReadRequest {
  /** Fully resolved request URL. */
  url: URL
  /** Optional caller cancellation, passed explicitly by each Provider. */
  signal: AbortSignal | undefined
  /** Provider-owned deadline in milliseconds. */
  timeoutMs: number
  /** Provider-unique abort reason used to distinguish the deadline. */
  timeoutCode: string
  /** Maximum complete response body size in bytes. */
  maxResponseBytes: number
  /** Fetch implementation; Providers normally pass `globalThis.fetch`. */
  fetchImpl: typeof globalThis.fetch
}

/** One received status and its complete bounded UTF-8 body. */
export interface AiopsHttpReadResult {
  /** HTTP response metadata. */
  response: Response
  /** Complete decoded response body. */
  body: string
}

/**
 * Issue one non-redirecting GET and collect its body up to the byte limit.
 * @param request - resolved URL, deadline, byte limit, and Fetch implementation.
 * @returns received HTTP response and complete decoded body.
 */
export async function readAiopsHttp(request: AiopsHttpReadRequest): Promise<AiopsHttpReadResult> {
  using requestDeadline = deadline(request.signal, request.timeoutMs, request.timeoutCode)
  let response: Response
  try {
    response = await request.fetchImpl(request.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: requestDeadline.signal,
    })
  } catch (error: unknown) {
    if (timeoutOf(requestDeadline.signal, request.timeoutCode) !== undefined) {
      throw new AiopsHttpReadError('timeout', error)
    }
    throw new AiopsHttpReadError('transport', error)
  }

  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > request.maxResponseBytes) {
    throw new AiopsHttpReadError('response_too_large')
  }
  if (response.body === null) return { response, body: '' }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > request.maxResponseBytes) {
      await reader.cancel()
      throw new AiopsHttpReadError('response_too_large')
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  return { response, body: body + decoder.decode() }
}
