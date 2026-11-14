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
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Incident from '../../aiops-incident/src/index.ts'
import * as HistoryTools from '../src/index.ts'
import { executeTestTool, installTestToolExecutor } from '../../../tests/helpers/tool-executor.ts'

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

function agentOf(sessionId: string, cwd?: string): Agent {
  return { session: { id: sessionId, ...(cwd === undefined ? {} : { header: { cwd } }) } } as unknown as Agent
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

describe('AIOps incident history through a real Loader composition', () => {
  it('lists, reads, searches, authorizes, and unregisters durable incident tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-history-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'storages'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-aiops-incident'",
      "- name: 'fake-aiops-router'",
      "- name: '@deepseek-ai/dsh-tool-aiops-history'",
      '  config:',
      '    defaultLimit: 2',
      '    maxLimit: 3',
      '    maxScanRecords: 10',
      '    timeoutMs: 1000',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    // The storage hub is a Service class without `apply`, so it mounts directly
    // rather than through the Loader; its backends and consumers load via yml.
    await ctx.plugin(Storage)
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
      ['@deepseek-ai/dsh-storage-json', JsonBackend],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
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
    installTestToolExecutor(ctx)

    // Seed the plugin-owned store the way the reporting tools would.
    const store = ctx.aiopsIncidents
    await store.report('caller', '/work', incident('inc-caller', 'Checkout'))
    await store.report('prior', '/work', incident('inc-prior', 'Payments'))
    await store.appendFeedback('prior', Incident.decodeAiopsOperatorFeedback({
      version: 1,
      feedbackId: `feedback-${'a'.repeat(32)}`,
      incidentId: 'inc-prior',
      reportRevision: 1,
      verdict: 'confirmed',
      note: 'Payments diagnosis confirmed by the operator.',
      origin: 'operator-via-agent',
    }))
    await store.report('hidden', '/secret', incident('inc-hidden', 'Secret'))

    const caller = agentOf('caller', '/work')
    const execute = (name: string, args: unknown, agent: Agent | null = caller) => executeTestTool(ctx, {
      name,
      arguments: args,
      ...(agent === null ? {} : { agent }),
    })

    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'aiops_feedback_list', 'aiops_incident_feedback', 'aiops_incident_get', 'aiops_incident_list',
      'aiops_incident_report', 'aiops_incident_search', 'aiops_routing_audit',
    ])
    expect(ctx.tools.get('aiops_incident_list')?.presentCall?.({})).toMatchObject({ title: 'List AIOps incidents' })
    expect(ctx.tools.get('aiops_incident_get')?.presentCall?.({ session_id: 'prior', revision: 1 }))
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
      { sessionId: 'prior', revision: 1, incident: { incidentId: 'inc-prior' } },
      { sessionId: 'caller', revision: 1, incident: { incidentId: 'inc-caller' } },
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
    expect((await execute('aiops_routing_audit', {}, agentOf('hidden', '/secret'))).isError).toBe(true)

    const read = await execute('aiops_incident_get', { session_id: 'prior', revision: 1 })
    expect(read.isError).toBe(false)
    if (read.isError) throw read.error
    expect(parseJson(read.value as string)).toMatchObject({ incident: { incidentId: 'inc-prior' } })
    expect((await execute('aiops_incident_get', { session_id: 'caller', revision: 1 })).isError).toBe(false)

    expect((await execute('aiops_incident_get', { session_id: 'hidden', revision: 1 })).isError).toBe(true)
    expect((await execute('aiops_incident_get', { session_id: 'prior', revision: 2 })).isError).toBe(true)
    expect((await execute('aiops_incident_get', { session_id: 'prior', revision: -1 })).isError).toBe(true)
    expect((await execute('aiops_incident_list', { limit: 4 })).isError).toBe(true)
    expect((await execute('aiops_incident_list', {}, null)).isError).toBe(true)

    // A cwd-less caller sees only its own Session's record.
    await store.report('isolated', '/elsewhere', incident('inc-isolated', 'Isolated'))
    const isolatedAgent = agentOf('isolated')
    const isolatedList = await execute('aiops_incident_list', {}, isolatedAgent)
    expect(isolatedList.isError).toBe(false)
    if (isolatedList.isError) throw isolatedList.error
    expect(JSON.parse(isolatedList.value as string)).toHaveLength(1)
    expect((await execute('aiops_incident_get', { session_id: 'isolated', revision: 1 }, isolatedAgent)).isError)
      .toBe(false)
    expect((await execute('aiops_incident_get', { session_id: 'caller', revision: 1 }, isolatedAgent)).isError)
      .toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-tool-aiops-history')
    if (entry?.fiber === undefined) throw new Error('missing AIOps history Loader fiber')
    await entry.fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual(['aiops_incident_feedback', 'aiops_incident_report'])

    const incidentEntry = [...ctx.loader.entries()].find(candidate =>
      candidate.options.name === '@deepseek-ai/dsh-aiops-incident')
    if (incidentEntry?.fiber === undefined) throw new Error('missing AIOps incident Loader fiber')
    await incidentEntry.fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  }, 30_000)
})
