import { describe, expect, it, vi } from 'vitest'
import { AiopsHttpReadError, readAiopsHttp } from '../src/index.ts'

const base = {
  url: new URL('http://example.test/api'),
  signal: undefined,
  timeoutMs: 50,
  timeoutCode: 'TEST_TIMEOUT',
  maxResponseBytes: 10,
}

describe('readAiopsHttp', () => {
  it('issues a fixed GET and returns status with the decoded body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('你好'))
    await expect(readAiopsHttp({ ...base, fetchImpl })).resolves.toMatchObject({ body: '你好' })
    expect(fetchImpl).toHaveBeenCalledWith(base.url, expect.objectContaining({
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
    }))
  })

  it('returns an empty body when Fetch supplies no body stream', async () => {
    const response = new Response(null, { status: 204 })
    await expect(readAiopsHttp({ ...base, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) }))
      .resolves.toEqual({ response, body: '' })
  })

  it('rejects declared and streamed bodies above the byte limit', async () => {
    const declared = vi.fn<typeof fetch>().mockResolvedValue(new Response('x', {
      headers: { 'content-length': '11' },
    }))
    await expect(readAiopsHttp({ ...base, fetchImpl: declared })).rejects.toMatchObject({ code: 'response_too_large' })

    const streamed = vi.fn<typeof fetch>().mockResolvedValue(new Response('01234567890'))
    await expect(readAiopsHttp({ ...base, fetchImpl: streamed })).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('distinguishes deadline expiry from other Fetch failures', async () => {
    const timedOut = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'))
      }, { once: true })
    }))
    await expect(readAiopsHttp({ ...base, timeoutMs: 1, fetchImpl: timedOut }))
      .rejects.toMatchObject({ code: 'timeout' })

    const cause = new Error('offline')
    await expect(readAiopsHttp({ ...base, fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(cause) }))
      .rejects.toMatchObject(new AiopsHttpReadError('transport', cause))
  })
})
