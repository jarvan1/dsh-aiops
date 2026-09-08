import { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it } from 'vitest'
import NativeKubernetesRuntime from '../src/index.ts'

const namespace = process.env.AIOPS_E2E_NAMESPACE
const pod = process.env.AIOPS_E2E_POD
const context = process.env.AIOPS_E2E_CONTEXT
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(namespace === undefined || pod === undefined)('real read-only CrashLoopBackOff exercise', () => {
  it('reads the Pod, absolute-window Events, and bounded current/previous logs', async () => {
    ctx = new Context()
    const runtime = new NativeKubernetesRuntime(ctx, {
      ...(context === undefined ? {} : { context }),
      ...(process.env.KUBECONFIG === undefined ? {} : { kubeconfig: process.env.KUBECONFIG }),
      defaultLogTailLines: 100,
      maxLogTailLines: 200,
    })
    const observedAt = Date.now()
    const sinceTime = new Date(observedAt - 60 * 60 * 1_000).toISOString()
    const untilTime = new Date(observedAt).toISOString()
    const container = await waitForCrashLoopContainer(runtime, {
      cwd: process.cwd(),
      resource: 'pod',
      name: pod!,
      namespace,
    })
    const events = await runtime.events({
      cwd: process.cwd(),
      namespace,
      fieldSelector: `involvedObject.name=${pod!}`,
      sinceTime,
      untilTime,
    }) as { items?: unknown[] }
    expect(Array.isArray(events.items)).toBe(true)

    const base = {
      cwd: process.cwd(),
      namespace,
      pod: pod!,
      container: container!,
      sinceTime,
      untilTime,
      tailLines: 100,
    }
    const current = await runtime.logs(runtime.resolveLogs(base))
    const previous = await runtime.logs(runtime.resolveLogs({ ...base, previous: true }))
    expect(typeof current).toBe('string')
    expect(typeof previous).toBe('string')
  }, 90_000)
})

async function waitForCrashLoopContainer(
  runtime: NativeKubernetesRuntime,
  request: { cwd: string; resource: string; name: string; namespace: string },
): Promise<string> {
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    const container = crashLoopContainer(await runtime.get(request))
    if (container !== undefined) return container
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Pod ${request.namespace}/${request.name} did not enter CrashLoopBackOff within 75 seconds`)
}

function crashLoopContainer(value: JsonValue): string | undefined {
  const root = objectValue(value)
  const status = objectValue(root?.['status'])
  const statuses = status?.['containerStatuses']
  if (!Array.isArray(statuses)) return undefined
  for (const item of statuses) {
    const record = objectValue(item)
    const waiting = objectValue(objectValue(record?.['state'])?.['waiting'])
    if (waiting?.['reason'] === 'CrashLoopBackOff' && typeof record?.['name'] === 'string') return record['name']
  }
  return undefined
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
    ? value as Record<string, JsonValue>
    : undefined
}
