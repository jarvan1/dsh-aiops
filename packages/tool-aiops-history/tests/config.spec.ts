import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as HistoryTools from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(config: HistoryTools.Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  HistoryTools.apply(ctx, config)
  return ctx
}

describe('AIOps incident history configuration', () => {
  it('applies programmatic defaults', async () => {
    const ctx = await mount({})
    expect(ctx.tools.get('aiops_incident_list')?.timeoutMs).toBe(HistoryTools.DEFAULT_TIMEOUT_MS)
  })

  it.each([
    [{ defaultLimit: 0 }, 'defaultLimit'],
    [{ maxLimit: 0 }, 'maxLimit'],
    [{ maxScanSessions: 0 }, 'maxScanSessions'],
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ defaultLimit: 2, maxLimit: 1 }, 'defaultLimit must not exceed maxLimit'],
    [{ timeoutMs: Number.MAX_SAFE_INTEGER }, 'timeoutMs must not exceed'],
  ] as const)('rejects invalid config %j', async (config, message) => {
    await expect(mount(config)).rejects.toThrow(message)
  })
})
