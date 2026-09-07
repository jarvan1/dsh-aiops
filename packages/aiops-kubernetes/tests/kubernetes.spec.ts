import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { KubernetesQueryError, KubectlKubernetesRuntime } from '../src/index.ts'

interface FakeOptions {
  stdout?: string
  stderr?: string
  collectStdout?: boolean
  lossy?: boolean
  outcome?: SubprocessOutcome
  failure?: Error
}

class FakeSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []

  constructor(ctx: Context, private readonly options: FakeOptions = {}) {
    super(ctx)
  }

  override resolveExecutable(): Promise<string> {
    return Promise.resolve('/usr/local/bin/kubectl')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const stdout = this.options.stdout ?? '{}'
    const stderr = this.options.stderr ?? ''
    return {
      pid: 1,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        ...(this.options.collectStdout === false ? {} : {
          stdout: { readFrom: () => ({
            text: stdout,
            nextOffset: Buffer.byteLength(stdout),
            lossy: this.options.lossy ?? false,
          }) },
        }),
        stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
      },
      done: this.options.failure === undefined
        ? Promise.resolve(this.options.outcome ?? { exitCode: 0, signal: null })
        : Promise.reject(this.options.failure),
      terminate() {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('not used'))
  }
}

describe('KubectlKubernetesRuntime', () => {
  it('builds an argv-only namespaced list with selectors', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: '{"items":[]}' })
    const runtime = new KubectlKubernetesRuntime(ctx, {
      context: 'prod-readonly',
      kubeconfig: '/tmp/kubeconfig',
    })

    await expect(runtime.list({
      cwd: '/workspace',
      resource: 'pods',
      namespace: 'payments',
      labelSelector: 'app=api',
      fieldSelector: 'status.phase=Running',
    })).resolves.toEqual({ items: [] })
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', '--context', 'prod-readonly', '--kubeconfig', '/tmp/kubeconfig',
      'get', 'pods', '--namespace', 'payments', '--selector', 'app=api',
      '--field-selector', 'status.phase=Running', '--output=json',
    ])
    expect(subprocess.specs[0]?.stdio.stdin).toBe('ignore')
  })

  it('rejects option-looking model values before spawning', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx)
    const runtime = new KubectlKubernetesRuntime(ctx)
    await expect(runtime.get({ cwd: '/workspace', resource: '--raw', name: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(subprocess.specs).toEqual([])
  })

  it('fails closed when collected stdout is lossy', async () => {
    const ctx = new Context()
    new FakeSubprocess(ctx, { stdout: '{"items":[]}', lossy: true })
    const runtime = new KubectlKubernetesRuntime(ctx, { maxOutputBytes: 8 })
    await expect(runtime.list({ cwd: '/workspace', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('uses default config and builds a cluster-default named get', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: '{"kind":"Pod"}' })
    const runtime = new KubectlKubernetesRuntime(ctx)

    await expect(runtime.get({ cwd: ' /workspace ', resource: ' pods ', name: ' api-1 ' }))
      .resolves.toEqual({ kind: 'Pod' })
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', 'get', 'pods', 'api-1', '--output=json',
    ])
    expect(subprocess.specs[0]?.cwd).toBe('/workspace')
  })

  it('rejects invalid configuration and targets before spawning', async () => {
    for (const config of [
      { command: '' },
      { context: '--other' },
      { kubeconfig: '-config' },
      { graceMs: Number.NaN },
      { graceMs: 0 },
      { graceMs: 2_147_483_648 },
      { maxOutputBytes: 0 },
      { maxOutputBytes: 1.5 },
      { maxOutputBytes: Number.MAX_SAFE_INTEGER + 1 },
      { defaultLogTailLines: 0 },
      { defaultLogTailLines: 1.5 },
      { maxLogTailLines: 0 },
      { maxLogTailLines: 1.5 },
      { defaultLogTailLines: 3, maxLogTailLines: 2 },
    ]) {
      expect(() => new KubectlKubernetesRuntime(new Context(), config)).toThrow()
    }

    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx)
    const runtime = new KubectlKubernetesRuntime(ctx)
    await expect(runtime.get({ cwd: ' ', resource: 'pods', name: 'api' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.get({ cwd: '/workspace', resource: 'pods', name: '-api' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.get({ cwd: '/workspace', resource: 'pods', name: 'api', namespace: '-all' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.list({ cwd: '/workspace', resource: 'pods', labelSelector: '-bad' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.list({ cwd: '/workspace', resource: 'pods', fieldSelector: '-bad' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(subprocess.specs).toEqual([])
  })

  it('lists chronological events with server-side selectors', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: '{"kind":"EventList","items":[]}' })
    const runtime = new KubectlKubernetesRuntime(ctx)

    await expect(runtime.events({
      cwd: '/workspace',
      namespace: 'payments',
      labelSelector: 'app=api',
      fieldSelector: 'involvedObject.name=api-1',
    })).resolves.toEqual({ kind: 'EventList', items: [] })
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', 'get', 'events', '--namespace', 'payments',
      '--selector', 'app=api', '--field-selector', 'involvedObject.name=api-1',
      '--sort-by=.metadata.creationTimestamp', '--output=json',
    ])
  })

  it('filters Events to an inclusive absolute occurrence window', async () => {
    const ctx = new Context()
    new FakeSubprocess(ctx, { stdout: JSON.stringify({
      kind: 'EventList',
      items: [
        { metadata: { name: 'old', creationTimestamp: '2026-09-06T00:30:00Z' }, lastTimestamp: '2026-09-06T00:40:00Z' },
        { metadata: { name: 'overlap', creationTimestamp: '2026-09-06T00:40:00Z' }, lastTimestamp: '2026-09-06T01:05:00Z' },
        { metadata: { name: 'inside', creationTimestamp: '2026-09-06T01:01:00Z' }, eventTime: '2026-09-06T01:01:00Z' },
        { metadata: { name: 'creation-only', creationTimestamp: '2026-09-06T01:02:00Z' } },
        { metadata: { name: 'future', creationTimestamp: '2026-09-06T01:30:00Z' } },
        { metadata: { name: 'undated' } },
      ],
    }) })
    const runtime = new KubectlKubernetesRuntime(ctx)

    const result = await runtime.events({
      cwd: '/workspace',
      sinceTime: '2026-09-06T00:45:00Z',
      untilTime: '2026-09-06T01:15:00Z',
    }) as { items: { metadata: { name: string } }[] }
    expect(result.items.map(item => item.metadata.name)).toEqual(['overlap', 'inside', 'creation-only'])
  })

  it('resolves Provider defaults and reads a bounded Pod-log snapshot', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: '2026-09-05T00:00:00Z ready\n' })
    const runtime = new KubectlKubernetesRuntime(ctx, { defaultLogTailLines: 50, maxLogTailLines: 100 })
    const spec = runtime.resolveLogs({ cwd: ' /workspace ', pod: ' api-1 ' })

    expect(spec).toEqual({
      cwd: '/workspace', pod: 'api-1', previous: false, tailLines: 50, timestamps: false,
    })
    await expect(runtime.logs(spec)).resolves.toBe('2026-09-05T00:00:00Z ready\n')
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', 'logs', 'api-1', '--tail', '50',
    ])
  })

  it('caps requested log lines and forwards every explicit read option', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: 'previous failure\n' })
    const runtime = new KubectlKubernetesRuntime(ctx, { defaultLogTailLines: 50, maxLogTailLines: 100 })
    const spec = runtime.resolveLogs({
      cwd: '/workspace',
      pod: 'api-1',
      namespace: 'payments',
      container: 'api',
      previous: true,
      tailLines: 500,
      since: '15m',
      timestamps: true,
    })

    expect(spec.tailLines).toBe(100)
    await runtime.logs(spec)
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', 'logs', 'api-1', '--namespace', 'payments',
      '--container', 'api', '--tail', '100', '--since', '15m', '--previous', '--timestamps',
    ])
  })

  it('uses an absolute log window and removes lines after its inclusive end', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx, { stdout: [
      '2026-09-06T01:01:00.000000000Z first\n',
      '2026-09-06T01:15:00Z boundary\n',
      '2026-09-06T01:15:01Z later\n',
      'untimestamped line\n',
    ].join('') })
    const runtime = new KubectlKubernetesRuntime(ctx)
    const spec = runtime.resolveLogs({
      cwd: '/workspace',
      pod: 'api-1',
      sinceTime: '2026-09-06T00:45:00Z',
      untilTime: '2026-09-06T01:15:00Z',
      tailLines: 1000,
    })

    expect(spec).toMatchObject({
      sinceTime: '2026-09-06T00:45:00.000Z',
      untilTime: '2026-09-06T01:15:00.000Z',
      timestamps: true,
    })
    await expect(runtime.logs(spec)).resolves.toBe([
      '2026-09-06T01:01:00.000000000Z first\n',
      '2026-09-06T01:15:00Z boundary\n',
    ].join(''))
    expect(subprocess.specs[0]?.argv).toEqual([
      '/usr/local/bin/kubectl', 'logs', 'api-1', '--tail', '1000',
      '--since-time', '2026-09-06T00:45:00.000Z', '--timestamps',
    ])
  })

  it('rejects invalid Pod-log requests before spawning', () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx)
    const runtime = new KubectlKubernetesRuntime(ctx)
    for (const request of [
      { cwd: '/workspace', pod: 'api', tailLines: 0 },
      { cwd: '/workspace', pod: 'api', tailLines: 1.5 },
      { cwd: '/workspace', pod: '-api' },
      { cwd: '/workspace', pod: 'api', container: '-container' },
      { cwd: '/workspace', pod: 'api', since: '-1h' },
      { cwd: '/workspace', pod: 'api', since: '1h', sinceTime: '2026-09-06T00:00:00Z' },
      { cwd: '/workspace', pod: 'api', sinceTime: 'bad' },
      { cwd: '/workspace', pod: 'api', sinceTime: '2026-09-06T02:00:00Z', untilTime: '2026-09-06T01:00:00Z' },
      { cwd: '/workspace', pod: 'api', untilTime: '2026-09-06T01:00:00Z', timestamps: false },
    ]) {
      expect(() => runtime.resolveLogs(request)).toThrow()
    }
    expect(subprocess.specs).toEqual([])
  })

  it('rejects invalid Event windows before spawning', async () => {
    const ctx = new Context()
    const subprocess = new FakeSubprocess(ctx)
    const runtime = new KubectlKubernetesRuntime(ctx)
    await expect(runtime.events({ cwd: '/workspace', sinceTime: 'bad' }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(runtime.events({
      cwd: '/workspace',
      sinceTime: '2026-09-06T02:00:00Z',
      untilTime: '2026-09-06T01:00:00Z',
    })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(subprocess.specs).toEqual([])
  })

  it('contains subprocess startup and missing-stdout failures', async () => {
    const failedContext = new Context()
    new FakeSubprocess(failedContext, { failure: new Error('spawn failed') })
    await expect(new KubectlKubernetesRuntime(failedContext).list({ cwd: '/workspace', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'command_failed', message: 'kubectl could not start.' })

    const missingContext = new Context()
    new FakeSubprocess(missingContext, { collectStdout: false })
    await expect(new KubectlKubernetesRuntime(missingContext).list({ cwd: '/workspace', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'command_failed', message: 'kubectl stdout was not collected.' })
  })

  it.each([
    [{ exitCode: 2, signal: null }, 'forbidden', 'code 2: forbidden'],
    [{ exitCode: 2, signal: null }, '', 'code 2.'],
    [{ exitCode: null, signal: 'SIGTERM' }, '', 'SIGTERM.'],
    [{ exitCode: null, signal: null }, '', 'a signal.'],
  ] satisfies [SubprocessOutcome, string, string][])('contains failed outcome %j', async (outcome, stderr, message) => {
    const ctx = new Context()
    new FakeSubprocess(ctx, { outcome, stderr })
    let failure: unknown
    try {
      await new KubectlKubernetesRuntime(ctx).get({ cwd: '/workspace', resource: 'pod', name: 'api' })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(KubernetesQueryError)
    if (!(failure instanceof KubernetesQueryError)) throw new Error('expected KubernetesQueryError')
    expect(failure.code).toBe('command_failed')
    expect(failure.message).toContain(message)
  })

  it('rejects invalid and non-lossless kubectl JSON', async () => {
    const invalidContext = new Context()
    new FakeSubprocess(invalidContext, { stdout: 'not json' })
    await expect(new KubectlKubernetesRuntime(invalidContext).list({ cwd: '/workspace', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'invalid_response', message: 'kubectl returned invalid JSON.' })

    const unsafeContext = new Context()
    new FakeSubprocess(unsafeContext, { stdout: '1e400' })
    await expect(new KubectlKubernetesRuntime(unsafeContext).list({ cwd: '/workspace', resource: 'pods' }))
      .rejects.toMatchObject({ code: 'invalid_response', message: 'kubectl returned a non-JSON value.' })
  })
})
