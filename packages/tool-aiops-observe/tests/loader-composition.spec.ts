import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AlertmanagerRuntime } from '@deepseek-ai/dsh-aiops-alertmanager'
import type {
  AlertmanagerAlertsRequest,
  AlertmanagerAlertsSpec,
} from '@deepseek-ai/dsh-aiops-alertmanager'
import { KubernetesRuntime } from '@deepseek-ai/dsh-aiops-kubernetes'
import type {
  KubernetesEventsRequest,
  KubernetesGetRequest,
  KubernetesListRequest,
  KubernetesLogsRequest,
  KubernetesLogsSpec,
} from '@deepseek-ai/dsh-aiops-kubernetes'
import { PrometheusRuntime } from '@deepseek-ai/dsh-aiops-prometheus'
import type {
  PrometheusDiscoveryRequest,
  PrometheusDiscoveryResult,
  PrometheusInstantQuery,
  PrometheusRangeQuery,
  PrometheusRulesRequest,
  PrometheusRulesResult,
  PrometheusTargetsRequest,
  PrometheusTargetsResult,
} from '@deepseek-ai/dsh-aiops-prometheus'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as ObserveTools from '../src/index.ts'

class FakeAlertmanager extends AlertmanagerRuntime {
  readonly requests: AlertmanagerAlertsRequest[] = []

  override resolveAlerts(request: AlertmanagerAlertsRequest): AlertmanagerAlertsSpec {
    this.requests.push(request)
    return {
      active: request.active ?? true,
      silenced: request.silenced ?? true,
      inhibited: request.inhibited ?? true,
      unprocessed: request.unprocessed ?? true,
      filters: request.filters ?? [],
      ...(request.receiver === undefined ? {} : { receiver: request.receiver }),
      receiverMatchers: request.receiverMatchers ?? [],
    }
  }

  override alerts(_spec: AlertmanagerAlertsSpec): Promise<[{ labels: { alertname: string } }]> {
    return Promise.resolve([{ labels: { alertname: 'HighLatency' } }])
  }
}

class FakePrometheus extends PrometheusRuntime {
  readonly ruleRequests: PrometheusRulesRequest[] = []
  readonly targetRequests: PrometheusTargetsRequest[] = []
  readonly discoveryRequests: PrometheusDiscoveryRequest[] = []

  override query(request: PrometheusInstantQuery): Promise<{ resultType: 'vector'; result: JsonValue }> {
    return Promise.resolve({ resultType: 'vector', result: [{ metric: {}, value: [1, request.query] }] })
  }

  override queryRange(_request: PrometheusRangeQuery): Promise<{ resultType: 'matrix'; result: JsonValue }> {
    return Promise.resolve({ resultType: 'matrix', result: [] })
  }

  override rules(request: PrometheusRulesRequest): Promise<PrometheusRulesResult> {
    this.ruleRequests.push(request)
    return Promise.resolve({
      alertName: request.alertName,
      rules: [],
      truncated: false,
    })
  }

  override targets(request: PrometheusTargetsRequest): Promise<PrometheusTargetsResult> {
    this.targetRequests.push(request)
    return Promise.resolve({
      targets: [{
        state: 'active',
        labels: { job: 'api' },
        discoveredLabels: {},
        health: 'down',
        lastError: 'connection refused',
      }],
      truncated: false,
    })
  }

  override discover(request: PrometheusDiscoveryRequest): Promise<PrometheusDiscoveryResult> {
    this.discoveryRequests.push(request)
    return Promise.resolve({ kind: request.kind, items: ['instance'], truncated: false })
  }
}

class FakeKubernetes extends KubernetesRuntime {
  readonly eventsRequests: KubernetesEventsRequest[] = []
  readonly lists: KubernetesListRequest[] = []
  readonly logRequests: KubernetesLogsRequest[] = []

  override get(request: KubernetesGetRequest): Promise<JsonValue> {
    return Promise.resolve({ kind: request.resource, metadata: { name: request.name } })
  }

  override list(request: KubernetesListRequest): Promise<JsonValue> {
    this.lists.push(request)
    return Promise.resolve({ kind: `${request.resource}List`, items: [] })
  }

  override events(request: KubernetesEventsRequest): Promise<JsonValue> {
    this.eventsRequests.push(request)
    return Promise.resolve({ kind: 'EventList', items: [] })
  }

  override resolveLogs(request: KubernetesLogsRequest): KubernetesLogsSpec {
    this.logRequests.push(request)
    return {
      cwd: request.cwd,
      pod: request.pod,
      ...(request.namespace === undefined ? {} : { namespace: request.namespace }),
      ...(request.container === undefined ? {} : { container: request.container }),
      previous: request.previous ?? false,
      tailLines: request.tailLines ?? 200,
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.sinceTime === undefined ? {} : { sinceTime: request.sinceTime }),
      ...(request.untilTime === undefined ? {} : { untilTime: request.untilTime }),
      timestamps: request.timestamps ?? request.untilTime !== undefined,
    }
  }

  override logs(_spec: KubernetesLogsSpec): Promise<string> {
    return Promise.resolve('ready\n')
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('AIOps observation tools through a real Loader composition', () => {
  it('publishes and executes the ten provider-neutral read tools, then unregisters them', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-aiops-observe-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@test/alertmanager'",
      "- name: '@test/prometheus'",
      "- name: '@test/kubernetes'",
      "- name: '@deepseek-ai/dsh-tool-aiops-observe'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@test/alertmanager', FakeAlertmanager],
      ['@test/prometheus', FakePrometheus],
      ['@test/kubernetes', FakeKubernetes],
      ['@deepseek-ai/dsh-tool-aiops-observe', ObserveTools],
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

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'alertmanager_alerts', 'prometheus_query', 'prometheus_query_range', 'prometheus_rules',
      'prometheus_targets', 'prometheus_discovery', 'kubernetes_get',
      'kubernetes_list', 'kubernetes_events', 'kubernetes_logs',
    ])
    const alertResult = await ctx.tools.execute({
      callId: ToolCallId('alerts'),
      name: 'alertmanager_alerts',
      arguments: {
        active: false,
        silenced: false,
        inhibited: false,
        unprocessed: false,
        filters: ['alertname="HighLatency"'],
        receiver: 'oncall-.*',
        receiver_matchers: ['owner="payments"'],
      },
      signal: new AbortController().signal,
    })
    expect(alertResult.isError).toBe(false)
    const alertmanagerRuntime = ctx.alertmanager as FakeAlertmanager
    expect(alertmanagerRuntime.requests[0]).toEqual({
      active: false,
      silenced: false,
      inhibited: false,
      unprocessed: false,
      filters: ['alertname="HighLatency"'],
      receiver: 'oncall-.*',
      receiverMatchers: ['owner="payments"'],
    })
    await ctx.tools.execute({
      callId: ToolCallId('alerts-defaults'),
      name: 'alertmanager_alerts',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(alertmanagerRuntime.requests[1]).toEqual({})
    const metrics = await ctx.tools.execute({
      callId: ToolCallId('metrics'),
      name: 'prometheus_query',
      arguments: { query: 'up' },
      signal: new AbortController().signal,
    })
    expect(metrics.isError).toBe(false)
    if (metrics.isError) throw new Error('expected metrics success')
    expect(metrics.value).toEqual({ resultType: 'vector', result: [{ metric: {}, value: [1, 'up'] }] })

    const range = await ctx.tools.execute({
      callId: ToolCallId('metrics-range'),
      name: 'prometheus_query_range',
      arguments: { query: 'up', start: '1', end: '2', step: '30s' },
      signal: new AbortController().signal,
    })
    expect(range.isError).toBe(false)
    if (range.isError) throw new Error('expected metrics range success')
    expect(range.value).toEqual({ resultType: 'matrix', result: [] })

    const prometheusRuntime = ctx.prometheus as FakePrometheus
    const rules = await ctx.tools.execute({
      callId: ToolCallId('prometheus-rules'),
      name: 'prometheus_rules',
      arguments: {
        alert_name: 'TargetDown',
        label_matchers: [{ name: 'job', value: 'api' }],
        generator_url: 'https://metrics.test/graph?g0.expr=up',
        limit: 5,
      },
      signal: new AbortController().signal,
    })
    expect(rules.isError).toBe(false)
    expect(prometheusRuntime.ruleRequests).toEqual([{
      alertName: 'TargetDown',
      labelMatchers: [{ name: 'job', value: 'api' }],
      generatorUrl: 'https://metrics.test/graph?g0.expr=up',
      limit: 5,
    }])

    const targets = await ctx.tools.execute({
      callId: ToolCallId('prometheus-targets'),
      name: 'prometheus_targets',
      arguments: {
        label_matchers: [{ name: 'job', value: 'api' }],
        scrape_pool: 'api',
        state: 'active',
        limit: 3,
      },
      signal: new AbortController().signal,
    })
    expect(targets.isError).toBe(false)
    expect(prometheusRuntime.targetRequests).toEqual([{
      labelMatchers: [{ name: 'job', value: 'api' }],
      scrapePool: 'api',
      state: 'active',
      limit: 3,
    }])

    const discovery = await ctx.tools.execute({
      callId: ToolCallId('prometheus-discovery'),
      name: 'prometheus_discovery',
      arguments: {
        kind: 'label_values',
        matchers: ['up{job="api"}'],
        label_name: 'instance',
        start: '2026-09-08T00:00:00Z',
        end: '2026-09-08T00:30:00Z',
        limit: 10,
      },
      signal: new AbortController().signal,
    })
    expect(discovery.isError).toBe(false)
    expect(prometheusRuntime.discoveryRequests).toEqual([{
      kind: 'label_values',
      matchers: ['up{job="api"}'],
      labelName: 'instance',
      start: '2026-09-08T00:00:00Z',
      end: '2026-09-08T00:30:00Z',
      limit: 10,
    }])

    const session = ctx.sessions.create(SessionId('aiops-loader'), { meta: { cwd: '/workspace' } })
    const kubernetes = await ctx.tools.execute({
      callId: ToolCallId('kubernetes'),
      name: 'kubernetes_get',
      arguments: { resource: 'pod', name: 'api-1' },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(kubernetes.isError).toBe(false)
    if (kubernetes.isError) throw new Error('expected Kubernetes success')
    expect(kubernetes.value).toEqual({ kind: 'pod', metadata: { name: 'api-1' } })

    const kubernetesRuntime = ctx.kubernetes as FakeKubernetes
    const list = await ctx.tools.execute({
      callId: ToolCallId('kubernetes-list'),
      name: 'kubernetes_list',
      arguments: {
        resource: 'pods',
        namespace: 'payments',
        label_selector: 'app=api',
        field_selector: 'status.phase=Running',
      },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(list.isError).toBe(false)
    expect(kubernetesRuntime.lists[0]).toEqual({
      cwd: '/workspace',
      resource: 'pods',
      namespace: 'payments',
      labelSelector: 'app=api',
      fieldSelector: 'status.phase=Running',
    })
    await ctx.tools.execute({
      callId: ToolCallId('kubernetes-list-defaults'),
      name: 'kubernetes_list',
      arguments: { resource: 'services' },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(kubernetesRuntime.lists[1]).toEqual({ cwd: '/workspace', resource: 'services' })

    await ctx.tools.execute({
      callId: ToolCallId('kubernetes-events'),
      name: 'kubernetes_events',
      arguments: {
        namespace: 'payments',
        label_selector: 'app=api',
        field_selector: 'involvedObject.name=api-1',
        since_time: '2026-09-06T00:45:00Z',
        until_time: '2026-09-06T01:15:00Z',
      },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    await ctx.tools.execute({
      callId: ToolCallId('kubernetes-events-defaults'),
      name: 'kubernetes_events',
      arguments: {},
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(kubernetesRuntime.eventsRequests).toEqual([{
      cwd: '/workspace',
      namespace: 'payments',
      labelSelector: 'app=api',
      fieldSelector: 'involvedObject.name=api-1',
      sinceTime: '2026-09-06T00:45:00Z',
      untilTime: '2026-09-06T01:15:00Z',
    }, { cwd: '/workspace' }])

    const logs = await ctx.tools.execute({
      callId: ToolCallId('kubernetes-logs'),
      name: 'kubernetes_logs',
      arguments: {
        pod: 'api-1',
        namespace: 'payments',
        container: 'api',
        previous: true,
        tail_lines: 50,
        since: '15m',
        timestamps: true,
      },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(logs.isError).toBe(false)
    if (logs.isError) throw new Error('expected Kubernetes logs success')
    expect(logs.content).toEqual([{ type: 'text', text: 'ready\n' }])
    await ctx.tools.execute({
      callId: ToolCallId('kubernetes-logs-defaults'),
      name: 'kubernetes_logs',
      arguments: { pod: 'api-2' },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(kubernetesRuntime.logRequests).toEqual([{
      cwd: '/workspace',
      pod: 'api-1',
      namespace: 'payments',
      container: 'api',
      previous: true,
      tailLines: 50,
      since: '15m',
      timestamps: true,
    }, { cwd: '/workspace', pod: 'api-2' }])

    await ctx.tools.execute({
      callId: ToolCallId('kubernetes-logs-absolute'),
      name: 'kubernetes_logs',
      arguments: {
        pod: 'api-3',
        since_time: '2026-09-06T00:45:00Z',
        until_time: '2026-09-06T01:15:00Z',
        tail_lines: 1000,
      },
      signal: new AbortController().signal,
      agent: { session } as unknown as Agent,
    })
    expect(kubernetesRuntime.logRequests[2]).toEqual({
      cwd: '/workspace',
      pod: 'api-3',
      sinceTime: '2026-09-06T00:45:00Z',
      untilTime: '2026-09-06T01:15:00Z',
      tailLines: 1000,
    })

    const missingSession = await ctx.tools.execute({
      callId: ToolCallId('kubernetes-no-session'),
      name: 'kubernetes_get',
      arguments: { resource: 'pod', name: 'api-1' },
      signal: new AbortController().signal,
    })
    expect(missingSession.isError).toBe(true)

    expect(ctx.tools.get('prometheus_query')?.presentCall?.({ query: 'up' })).toMatchObject({
      title: 'Query Prometheus', kind: 'search',
    })
    expect(ctx.tools.get('prometheus_query_range')?.presentCall?.({
      query: 'up', start: '1', end: '2', step: '30s',
    })).toMatchObject({
      title: 'Query Prometheus range', kind: 'search',
    })
    expect(ctx.tools.get('kubernetes_get')?.presentCall?.({ resource: 'pod', name: 'api-1' })).toMatchObject({
      title: 'Read Kubernetes object', kind: 'read',
    })
    expect(ctx.tools.get('kubernetes_list')?.presentCall?.({ resource: 'pods' })).toMatchObject({
      title: 'List Kubernetes objects', kind: 'search',
    })
    expect(ctx.tools.get('alertmanager_alerts')?.presentCall?.({})).toMatchObject({
      title: 'Read Alertmanager alerts', kind: 'search',
    })
    expect(ctx.tools.get('kubernetes_events')?.presentCall?.({})).toMatchObject({
      title: 'List Kubernetes events', kind: 'search',
    })
    expect(ctx.tools.get('kubernetes_logs')?.presentCall?.({ pod: 'api-1' })).toMatchObject({
      title: 'Read Kubernetes Pod logs', kind: 'read',
    })

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-tool-aiops-observe')
    if (entry?.fiber === undefined) throw new Error('missing observation tool Loader fiber')
    await entry.fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  }, 30_000)
})
