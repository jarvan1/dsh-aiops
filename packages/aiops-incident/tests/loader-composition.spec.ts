import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Incident from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('AIOps incident through a real Loader composition', () => {
  it('persists one complete report and exposes the same projected current state', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-incident-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'sessions'))}`,
      '    compression: none',
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-aiops-incident'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-aiops-incident', Incident],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const session = ctx.sessions.create(SessionId('aiops-incident-loader'), { meta: { cwd: root } })
    const writeHandle = await ctx.sessionPersistence.create(session.header)
    const report = {
      version: 1,
      incidentId: 'inc-payments-1',
      title: 'Payments latency',
      severity: 'critical',
      status: 'investigating',
      evidence: [{ id: 'metric-p99', kind: 'metric', summary: 'p99 exceeded 2 seconds.' }],
      hypotheses: [{ summary: 'API saturation', confidence: 'possible', evidenceIds: ['metric-p99'] }],
      recommendations: [{ action: 'Review pod saturation before scaling.', risk: 'low' }],
    }
    const result = await ctx.tools.execute({
      callId: ToolCallId('incident-report'),
      name: 'aiops_incident_report',
      arguments: { incident: report },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(result.isError).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'aiopsIncident')).toEqual(report)

    const feedbackCall = {
      callId: ToolCallId('incident-feedback'),
      name: 'aiops_incident_feedback',
      arguments: { verdict: 'corrected', note: 'The operator found a rollout correlation.', correction: 'A bad rollout caused the latency.' },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    }
    const feedback = await ctx.tools.execute(feedbackCall)
    expect(feedback.isError).toBe(false)
    expect(ctx.sessionProjections.stateOf(session, 'aiopsIncidentFeedback')).toMatchObject({
      incidentId: 'inc-payments-1', verdict: 'corrected', reportSeq: 0,
    })
    const replayedFeedback = await ctx.tools.execute(feedbackCall)
    expect(replayedFeedback.isError).toBe(false)

    await writeHandle.close()
    const readHandle = await ctx.sessionPersistence.open(session.id, 'read')
    const durable = await readHandle.read()
    await readHandle.close()
    expect(durable).toHaveLength(2)
    expect(durable[0]).toMatchObject({ type: 'aiops/incident-state', data: report, ignorable: true })
    expect(durable[1]).toMatchObject({ type: 'aiops/operator-feedback', data: { verdict: 'corrected' }, ignorable: true })

    expect(ctx.tools.get('aiops_incident_report')?.presentCall?.({ incident: report })).toEqual({
      card: 'generic', title: 'Record AIOps incident', kind: 'other', rawInput: report,
    })
    const withoutAgent = await ctx.tools.execute({
      callId: ToolCallId('incident-without-agent'),
      name: 'aiops_incident_report',
      arguments: { incident: report },
      signal: new AbortController().signal,
    })
    expect(withoutAgent.isError).toBe(true)
    const invalidFeedback = await ctx.tools.execute({
      callId: ToolCallId('invalid-feedback'),
      name: 'aiops_incident_feedback',
      arguments: { verdict: 'corrected', note: 'Missing correction.' },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(invalidFeedback.isError).toBe(true)

    const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
    ctx.sessions.flush = () => Promise.resolve(false)
    const uncertain = await ctx.tools.execute({
      callId: ToolCallId('incident-no-flush-listener'),
      name: 'aiops_incident_report',
      arguments: { incident: report },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    ctx.sessions.flush = originalFlush
    expect(uncertain.isError).toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-aiops-incident')
    if (entry?.fiber === undefined) throw new Error('missing incident Loader fiber')
    await entry.fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'aiops_incident_report')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'aiops_incident_feedback')).toBe(false)
  }, 30_000)
})
