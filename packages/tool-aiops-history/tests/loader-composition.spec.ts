import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AiopsIncidentState } from '@deepseek-ai/dsh-aiops-incident'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Incident from '../../aiops-incident/src/index.ts'
import * as HistoryTools from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function incident(id: string, title: string): AiopsIncidentState {
  return {
    version: 1,
    incidentId: id as AiopsIncidentState['incidentId'],
    title,
    severity: 'critical',
    status: 'investigating',
    evidence: [{
      id: 'metric-p99' as AiopsIncidentState['evidence'][number]['id'],
      kind: 'metric',
      summary: `${title} p99 exceeded two seconds.`,
    }],
    hypotheses: [{
      summary: `${title} API saturation`,
      confidence: 'possible',
      evidenceIds: ['metric-p99' as AiopsIncidentState['evidence'][number]['id']],
    }],
    recommendations: [{ action: `Review ${title} pod saturation.`, risk: 'low' }],
  }
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

describe('AIOps incident history through a real Loader composition', () => {
  it('lists, reads, searches, authorizes, and unregisters durable incident tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-history-loader-'))
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
      "- name: '@deepseek-ai/dsh-session-query-sqlite'",
      '  config:',
      "    path: ':memory:'",
      '    openAt: startup',
      "- name: '@deepseek-ai/dsh-aiops-incident'",
      "- name: 'fake-aiops-router'",
      "- name: '@deepseek-ai/dsh-tool-aiops-history'",
      '  config:',
      '    defaultLimit: 2',
      '    maxLimit: 3',
      '    maxScanSessions: 10',
      '    timeoutMs: 1000',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const fakeRouter = {
      apply(routerContext: Context) {
        routerContext.provide('aiopsIncidentRouter', {
          workspacePath: '/work',
          listControlAudit: ({ outcome }: { outcome?: string }) => [{
            id: 1,
            source: 'primary',
            deliveryId: 'delivery-1',
            fingerprint: '0123456789abcdef',
            alertname: 'KubePodCrashLooping',
            severity: 'critical',
            outcome: outcome ?? 'grouped',
            reason: 'fingerprint-grouped',
            queueDepth: 2,
            reservedTokens: 8192,
            recordedAt: 1,
            attempt: 0,
          }],
        } as never)
      },
    }
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQuery],
      ['@deepseek-ai/dsh-aiops-incident', Incident],
      ['fake-aiops-router', fakeRouter],
      ['@deepseek-ai/dsh-tool-aiops-history', HistoryTools],
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

    const caller = ctx.sessions.create(SessionId('caller'), { meta: { createdAt: 1, cwd: '/work' } })
    caller.append('aiops/incident-state', incident('inc-caller', 'Checkout'))
    const prior = ctx.sessions.create(SessionId('prior'), { meta: { createdAt: 2, cwd: '/work' } })
    prior.append('user/message', {
      id: 'ordinary-message' as never,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'not an incident' }],
    }, { surfaceOp: 'append' })
    prior.append('aiops/incident-state', incident('inc-prior', 'Payments'))
    prior.append('aiops/operator-feedback', {
      version: 1,
      feedbackId: `feedback-${'a'.repeat(32)}` as never,
      incidentId: 'inc-prior' as never,
      reportSeq: 1,
      verdict: 'confirmed',
      note: 'Payments diagnosis confirmed by the operator.',
      origin: 'operator-via-agent',
    })
    const hidden = ctx.sessions.create(SessionId('hidden'), { meta: { createdAt: 3, cwd: '/secret' } })
    hidden.append('aiops/incident-state', incident('inc-hidden', 'Secret'))

    let call = 0
    const execute = (name: string, args: unknown, agent: Agent | null = fakeAgent(caller)) => ctx.tools.execute({
      name,
      arguments: args,
      callId: ToolCallId(`aiops-history-${++call}`),
      signal: new AbortController().signal,
      ...(agent === null ? {} : { agent }),
    })

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'aiops_incident_report', 'aiops_incident_feedback', 'aiops_incident_list', 'aiops_incident_get',
      'aiops_incident_search', 'aiops_feedback_list', 'aiops_routing_audit',
    ])
    expect(ctx.tools.get('aiops_incident_list')?.presentCall?.({})).toMatchObject({ title: 'List AIOps incidents' })
    expect(ctx.tools.get('aiops_incident_get')?.presentCall?.({ session_id: 'prior', seq: 1 }))
      .toMatchObject({ title: 'Read AIOps incident' })
    expect(ctx.tools.get('aiops_incident_search')?.presentCall?.({ query: 'Payments' }))
      .toMatchObject({ title: 'Search AIOps incidents' })
    expect(ctx.tools.get('aiops_feedback_list')?.presentCall?.({}))
      .toMatchObject({ title: 'List AIOps operator feedback' })
    expect(ctx.tools.get('aiops_routing_audit')?.presentCall?.({}))
      .toMatchObject({ title: 'Read AIOps routing audit' })
    const listed = await execute('aiops_incident_list', {})
    expect(listed.isError).toBe(false)
    if (listed.isError) throw listed.error
    expect(parseJson(listed.value as string)).toMatchObject([
      { sessionId: 'prior', incident: { incidentId: 'inc-prior' } },
      { sessionId: 'caller', incident: { incidentId: 'inc-caller' } },
    ])

    const searched = await execute('aiops_incident_search', { query: 'Payments API saturation', limit: 1 })
    expect(searched.isError).toBe(false)
    if (searched.isError) throw searched.error
    const searchRecords = parseJson(searched.value as string) as Array<{ sessionId: string; incident: { title: string } }>
    expect(searchRecords[0]).toMatchObject({
      sessionId: 'prior', incident: { title: 'Payments' },
    })

    const feedback = await execute('aiops_feedback_list', { query: 'Payments diagnosis', verdict: 'confirmed' })
    expect(feedback.isError).toBe(false)
    if (feedback.isError) throw feedback.error
    expect(parseJson(feedback.value as string)).toMatchObject([
      { sessionId: 'prior', feedback: { incidentId: 'inc-prior', verdict: 'confirmed' } },
    ])

    const routing = await execute('aiops_routing_audit', { outcome: 'grouped' })
    expect(routing.isError).toBe(false)
    if (routing.isError) throw routing.error
    expect(parseJson(routing.value as string)).toMatchObject([
      { deliveryId: 'delivery-1', outcome: 'grouped', reason: 'fingerprint-grouped' },
    ])
    expect((await execute('aiops_routing_audit', {}, fakeAgent(hidden))).isError).toBe(true)

    const read = await execute('aiops_incident_get', { session_id: 'prior', seq: 1 })
    expect(read.isError).toBe(false)
    if (read.isError) throw read.error
    expect(parseJson(read.value as string)).toMatchObject({ incident: { incidentId: 'inc-prior' } })
    expect((await execute('aiops_incident_get', { session_id: 'caller', seq: 0 })).isError).toBe(false)

    expect((await execute('aiops_incident_get', { session_id: 'hidden', seq: 0 })).isError).toBe(true)
    expect((await execute('aiops_incident_get', { session_id: 'prior', seq: 0 })).isError).toBe(true)
    expect((await execute('aiops_incident_get', { session_id: 'prior', seq: -1 })).isError).toBe(true)
    expect((await execute('aiops_incident_list', { limit: 4 })).isError).toBe(true)
    expect((await execute('aiops_incident_list', {}, null)).isError).toBe(true)

    const originalReadEvent = ctx.sessionQuery.readEvent.bind(ctx.sessionQuery)
    ctx.sessionQuery.readEvent = async (request, signal) => {
      const window = await originalReadEvent(request, signal)
      return { ...window, session: { ...window.session, cwd: '/secret' } }
    }
    expect((await execute('aiops_incident_get', { session_id: 'prior', seq: 1 })).isError).toBe(true)
    ctx.sessionQuery.readEvent = originalReadEvent

    caller.append('aiops/incident-state', incident('inc-caller', 'Checkout update'))
    const originalFilterSessions = ctx.sessionQuery.filterSessions.bind(ctx.sessionQuery)
    const originalFilterEvents = ctx.sessionQuery.filterEvents.bind(ctx.sessionQuery)
    ctx.sessionQuery.filterSessions = () => Promise.resolve([
      { header: caller.header, live: true, persisted: false },
      { header: prior.header, live: true, persisted: false },
    ])
    ctx.sessionQuery.filterEvents = sessionId => Promise.resolve(sessionId === caller.id
      ? [
        { sessionId: caller.id, seq: 0 as never, time: 5, type: 'aiops/incident-state', surface: 'log-only', text: 'a' },
        { sessionId: caller.id, seq: 1 as never, time: 5, type: 'aiops/incident-state', surface: 'log-only', text: 'b' },
      ]
      : [{ sessionId: prior.id, seq: 1 as never, time: 5, type: 'aiops/incident-state', surface: 'log-only', text: 'c' }])
    const tied = await execute('aiops_incident_list', { limit: 3 })
    expect(tied.isError).toBe(false)
    if (tied.isError) throw tied.error
    const tiedRecords = parseJson(tied.value as string) as Array<{ sessionId: string; seq: number }>
    expect(tiedRecords.map(item => [item.sessionId, item.seq]))
      .toEqual([['prior', 1], ['caller', 1], ['caller', 0]])
    ctx.sessionQuery.filterSessions = originalFilterSessions
    ctx.sessionQuery.filterEvents = originalFilterEvents

    const isolated = ctx.sessions.create(SessionId('isolated'), { meta: { createdAt: 4 } })
    isolated.append('aiops/incident-state', incident('inc-isolated', 'Isolated'))
    const isolatedList = await execute('aiops_incident_list', {}, fakeAgent(isolated))
    expect(isolatedList.isError).toBe(false)
    if (isolatedList.isError) throw isolatedList.error
    expect(JSON.parse(isolatedList.value as string)).toHaveLength(1)
    expect((await execute('aiops_incident_get', { session_id: 'isolated', seq: 0 }, fakeAgent(isolated))).isError)
      .toBe(false)
    expect((await execute('aiops_incident_get', { session_id: 'caller', seq: 0 }, fakeAgent(isolated))).isError)
      .toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-tool-aiops-history')
    if (entry?.fiber === undefined) throw new Error('missing AIOps history Loader fiber')
    await entry.fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['aiops_incident_report', 'aiops_incident_feedback'])

    const incidentEntry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-aiops-incident')
    if (incidentEntry?.fiber === undefined) throw new Error('missing AIOps incident Loader fiber')
    expect(ctx.sessionQuery.extractEventText(caller.snapshotEvents()[0]!)).toContain('Checkout')
    await incidentEntry.fiber.dispose()
    expect(ctx.sessionQuery.extractEventText(caller.snapshotEvents()[0]!)).toBe('')
    expect(ctx.tools.schemas()).toEqual([])
  }, 30_000)
})
