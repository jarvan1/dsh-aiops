import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function harness(): { ctx: Context; register: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  contexts.push(ctx)
  const remove = vi.fn()
  const register = vi.fn(() => remove)
  ctx.provide('webServer', { register } as never)
  ctx.provide('webhookRuntime', {} as never)
  ctx.provide('credentials', {} as never)
  ctx.provide('aiopsTelemetry', { markComponent: vi.fn() } as never)
  return { ctx, register, remove }
}

const valid = {
  source: 'primary',
  path: '/alertmanager',
  secretEnv: 'AIOPS_ALERTMANAGER_WEBHOOK_SECRET',
  maxBodyBytes: 1024,
  maxAlerts: 10,
  maxMapEntries: 20,
  maxTextChars: 1000,
} satisfies Config

describe('Alertmanager webhook plugin config', () => {
  it('registers and lifecycle-removes one exact route', async () => {
    const test = harness()
    apply(test.ctx, valid)
    expect(test.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'exact', path: '/alertmanager' }))
    await test.ctx.fiber.dispose()
    expect(test.remove).toHaveBeenCalledOnce()
  })

  it.each([
    [{ ...valid, source: '' }, /source/],
    [{ ...valid, path: 'alertmanager' }, /path/],
    [{ ...valid, path: '/' }, /path/],
    [{ ...valid, path: '/alertmanager/' }, /path/],
    [{ ...valid, secretEnv: 'bad ref' }, /credential ref/],
  ] as const)('rejects invalid config %#', (config, message) => {
    const test = harness()
    expect(() => { apply(test.ctx, config) }).toThrow(message)
    expect(test.register).not.toHaveBeenCalled()
  })
})
