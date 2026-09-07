/** Bounded raw HTTP body intake shared by the Alertmanager adapter. */

import type { IncomingMessage } from 'node:http'

/** HTTP refusal whose message contains no secret or payload data. */
export class AlertmanagerWebhookHttpError extends Error {
  override readonly name = 'AlertmanagerWebhookHttpError'

  constructor(
    readonly status: 400 | 401 | 405 | 413 | 415 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new AlertmanagerWebhookHttpError(400, 'invalid Content-Length')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) {
    throw new AlertmanagerWebhookHttpError(413, 'request body is too large')
  }
  return length
}

/** Read one complete, bounded UTF-8 request body. */
export async function readBoundedUtf8Body(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  const declared = contentLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume()
    throw new AlertmanagerWebhookHttpError(413, 'request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
      size += chunk.byteLength
      if (size > maxBodyBytes) {
        request.resume()
        throw new AlertmanagerWebhookHttpError(413, 'request body is too large')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    if (error instanceof AlertmanagerWebhookHttpError) throw error
    throw new AlertmanagerWebhookHttpError(400, 'request body was aborted')
  }
  if (!request.complete) throw new AlertmanagerWebhookHttpError(400, 'request body was aborted')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  } catch {
    throw new AlertmanagerWebhookHttpError(400, 'request body is not valid UTF-8')
  }
}
