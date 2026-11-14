import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonBackend from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Incident from '../src/index.ts'
import { executeTestTool, installTestToolExecutor } from '../../../tests/helpers/tool-executor.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

describe('AIOps incident through a real Loader composition', () => {
  it('persists reports and feedback in the plugin-owned storage domain', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-incident-loader-'))
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
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-storage-json', JsonBackend],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
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
    installTestToolExecutor(ctx)

    const session = { id: 'aiops-incident-loader', header: { cwd: root } }
    const agent = { session } as unknown as Agent
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
    const result = await executeTestTool(ctx, {
      name: 'aiops_incident_report',
      arguments: { incident: report },
      agent,
    })
    if (result.isError) console.log('REPORT RESULT', JSON.stringify(result, null, 2))
    expect(result.isError).toBe(false)
    expect(ctx.aiopsIncidents.get('aiops-incident-loader')).toMatchObject({
      sessionId: 'aiops-incident-loader',
      workspace: root,
      revision: 1,
      incident: report,
    })
    // The report is a durable document in the plugin-owned storage medium.
    const storedFiles = await listFiles(join(root, 'storages'))
    expect(storedFiles.some(path => path.includes('aiops_incident') && path.endsWith('aiops-incident-loader.json'))).toBe(true)

    const feedbackCall = {
      name: 'aiops_incident_feedback',
      callId: 'incident-feedback',
      arguments: { verdict: 'corrected', note: 'The operator found a rollout correlation.', correction: 'A bad rollout caused the latency.' },
      agent,
    }
    const feedback = await executeTestTool(ctx, feedbackCall)
    expect(feedback.isError).toBe(false)
    expect(ctx.aiopsIncidents.latestFeedback('aiops-incident-loader')?.feedback).toMatchObject({
      incidentId: 'inc-payments-1', verdict: 'corrected', reportRevision: 1,
    })
    const replayedFeedback = await executeTestTool(ctx, feedbackCall)
    expect(replayedFeedback.isError).toBe(false)
    expect(ctx.aiopsIncidents.listFeedback(root)).toHaveLength(1)

    // A replacement report bumps the revision; replaying the same feedback
    // call stays idempotent (same call id → same feedback id → stored record).
    const updated = await executeTestTool(ctx, {
      name: 'aiops_incident_report',
      arguments: { incident: { ...report, status: 'identified' } },
      agent,
    })
    expect(updated.isError).toBe(false)
    expect(ctx.aiopsIncidents.get('aiops-incident-loader')?.revision).toBe(2)
    const replayedAfterBump = await executeTestTool(ctx, feedbackCall)
    expect(replayedAfterBump.isError).toBe(false)
    expect(ctx.aiopsIncidents.listFeedback(root)).toHaveLength(1)

    expect(ctx.tools.get('aiops_incident_report')?.presentCall?.({ incident: report })).toEqual({
      card: 'generic', title: 'Record AIOps incident', kind: 'other', rawInput: report,
    })
    const withoutAgent = await executeTestTool(ctx, {
      name: 'aiops_incident_report',
      arguments: { incident: report },
    })
    expect(withoutAgent.isError).toBe(true)
    const invalidFeedback = await executeTestTool(ctx, {
      name: 'aiops_incident_feedback',
      arguments: { verdict: 'corrected', note: 'Missing correction.' },
      agent,
    })
    expect(invalidFeedback.isError).toBe(true)

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-aiops-incident')
    if (entry?.fiber === undefined) throw new Error('missing incident Loader fiber')
    await entry.fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'aiops_incident_report')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'aiops_incident_feedback')).toBe(false)
  }, 30_000)
})
