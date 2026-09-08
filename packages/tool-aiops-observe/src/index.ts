/**
 * Model-facing read-only Alertmanager, Prometheus, and Kubernetes observation tools.
 * @module @deepseek-ai/dsh-tool-aiops-observe
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-aiops-alertmanager'
import type {} from '@deepseek-ai/dsh-aiops-kubernetes'
import type {} from '@deepseek-ai/dsh-aiops-prometheus'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-aiops-observe'

/** Provider-neutral services required by all observation tools. */
export const inject = ['tools', 'alertmanager', 'prometheus', 'kubernetes']

function renderJson(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function renderText(_args: unknown, value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

async function jsonValue(promise: Promise<unknown>): Promise<JsonValue> {
  const value = snapshotJsonValue(await promise)
  if (value === undefined) throw new Error('AIOps Provider returned a non-JSON result.')
  return value as JsonValue
}

const prometheusOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultType: { type: 'string', required: true, enum: ['matrix', 'vector', 'scalar', 'string'] },
    result: { type: 'json', required: true },
  },
} satisfies ValueSchemaSpec

function executionCwd(exec: ToolExecution): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('Kubernetes observation requires an agent session with a working directory.')
  return cwd
}

/** Register the stable observation tool set against provider-neutral services. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'alertmanager_alerts',
    description: 'Read current Alertmanager alerts with optional state, label, and receiver filters. Use alert status and timestamps as evidence; a firing alert does not by itself prove root cause.',
    parameters: {
      active: { type: 'boolean', description: 'Include active non-suppressed alerts; defaults to true.' },
      silenced: { type: 'boolean', description: 'Include alerts suppressed by silences; defaults to true.' },
      inhibited: { type: 'boolean', description: 'Include alerts suppressed by inhibition; defaults to true.' },
      unprocessed: { type: 'boolean', description: 'Include alerts not yet processed; defaults to true.' },
      filters: { type: 'array', items: { type: 'string' }, description: 'Alert label matcher expressions.' },
      receiver: { type: 'string', description: 'Receiver-name regular expression.' },
      receiver_matchers: { type: 'array', items: { type: 'string' }, description: 'Receiver-label matcher expressions.' },
    },
    output: { schema: { type: 'array', items: { type: 'json' } }, render: renderJson },
    execute: (args, exec) => ctx.alertmanager.alerts(ctx.alertmanager.resolveAlerts({
      ...(args.active === undefined ? {} : { active: args.active }),
      ...(args.silenced === undefined ? {} : { silenced: args.silenced }),
      ...(args.inhibited === undefined ? {} : { inhibited: args.inhibited }),
      ...(args.unprocessed === undefined ? {} : { unprocessed: args.unprocessed }),
      ...(args.filters === undefined ? {} : { filters: args.filters }),
      ...(args.receiver === undefined ? {} : { receiver: args.receiver }),
      ...(args.receiver_matchers === undefined ? {} : { receiverMatchers: args.receiver_matchers }),
    }), exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Read Alertmanager alerts', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'prometheus_query',
    description: 'Run a read-only PromQL instant query. Use it to collect metric evidence; do not infer a cause from one sample alone.',
    parameters: {
      query: { type: 'string', required: true, description: 'PromQL expression.' },
      time: { type: 'string', description: 'Optional RFC 3339 timestamp or Unix timestamp accepted by Prometheus.' },
    },
    output: { schema: prometheusOutputSchema, render: renderJson },
    execute: (args, exec) => ctx.prometheus.query(args, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Query Prometheus', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'prometheus_query_range',
    description: 'Run a read-only PromQL range query. Use an explicit time window and resolution to confirm timing and trends.',
    parameters: {
      query: { type: 'string', required: true, description: 'PromQL expression.' },
      start: { type: 'string', required: true, description: 'Inclusive RFC 3339 or Unix start time.' },
      end: { type: 'string', required: true, description: 'Inclusive RFC 3339 or Unix end time.' },
      step: { type: 'string', required: true, description: 'Prometheus query resolution, for example 30s.' },
    },
    output: { schema: prometheusOutputSchema, render: renderJson },
    execute: (args, exec) => ctx.prometheus.queryRange(args, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Query Prometheus range', kind: 'search', rawInput: args }),
  }))

  const exactLabelMatcherSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true, description: 'Exact Prometheus label name.' },
      value: { type: 'string', required: true, description: 'Exact Prometheus label value.' },
    },
  } as const

  ctx.tools.register(defineTool({
    name: 'prometheus_rules',
    description: 'Look up bounded read-only Prometheus alerting-rule definitions by exact alert name and optional alert labels. Returns the configured PromQL; never invent an expression. generator_url is parsed locally only when it identifies the configured Prometheus graph endpoint and is never fetched.',
    parameters: {
      alert_name: { type: 'string', required: true, description: 'Exact alertname from the routed alert.' },
      label_matchers: {
        type: 'array',
        items: exactLabelMatcherSchema,
        description: 'Optional exact alert labels used to rank and compare candidate rule definitions.',
      },
      generator_url: {
        type: 'string',
        description: 'Optional generatorURL copied exactly from the routed alert; never provide another URL.',
      },
      limit: { type: 'integer', description: 'Maximum results; omission uses the Provider default and excess is capped.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => jsonValue(ctx.prometheus.rules({
      alertName: args.alert_name,
      ...(args.label_matchers === undefined ? {} : { labelMatchers: args.label_matchers }),
      ...(args.generator_url === undefined ? {} : { generatorUrl: args.generator_url }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }, exec.signal)),
    presentCall: args => ({ card: 'generic', title: 'Find Prometheus alert rules', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'prometheus_targets',
    description: 'Look up bounded read-only Prometheus scrape-target health and last scrape errors. At least one exact label matcher or scrape pool is required; broad target enumeration is rejected.',
    parameters: {
      label_matchers: {
        type: 'array',
        items: exactLabelMatcherSchema,
        description: 'Exact target labels, normally copied from alert job and instance labels.',
      },
      scrape_pool: { type: 'string', description: 'Optional exact Prometheus scrape-pool name.' },
      state: { type: 'string', enum: ['active', 'dropped', 'any'], description: 'Target state; defaults to any.' },
      limit: { type: 'integer', description: 'Maximum results; omission uses the Provider default and excess is capped.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => jsonValue(ctx.prometheus.targets({
      ...(args.label_matchers === undefined ? {} : { labelMatchers: args.label_matchers }),
      ...(args.scrape_pool === undefined ? {} : { scrapePool: args.scrape_pool }),
      ...(args.state === undefined ? {} : { state: args.state }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }, exec.signal)),
    presentCall: args => ({ card: 'generic', title: 'Find Prometheus targets', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'prometheus_discovery',
    description: 'Discover a strictly bounded set of Prometheus series identities, label names, or label values over an explicit absolute time window. Every request requires concrete selectors; unrestricted metadata enumeration is rejected.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['series', 'label_names', 'label_values'], description: 'Metadata kind to discover.' },
      matchers: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Concrete series selectors. Each must name a metric or contain a non-empty exact label matcher.',
      },
      label_name: { type: 'string', description: 'Required for label_values and invalid for other kinds.' },
      start: { type: 'string', required: true, description: 'Inclusive absolute RFC3339 or Unix start time.' },
      end: { type: 'string', required: true, description: 'Inclusive absolute RFC3339 or Unix end time.' },
      limit: { type: 'integer', description: 'Maximum results; omission uses the Provider default and excess is capped.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => jsonValue(ctx.prometheus.discover({
      kind: args.kind,
      matchers: args.matchers,
      ...(args.label_name === undefined ? {} : { labelName: args.label_name }),
      start: args.start,
      end: args.end,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }, exec.signal)),
    presentCall: args => ({ card: 'generic', title: 'Discover Prometheus metadata', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kubernetes_get',
    description: 'Read one named Kubernetes object as JSON through the configured context. This tool cannot create, patch, delete, exec, or stream logs.',
    parameters: {
      resource: { type: 'string', required: true, description: 'Resource kind or plural resource name.' },
      name: { type: 'string', required: true, description: 'Exact object name.' },
      namespace: { type: 'string', description: 'Namespace; omit to use the configured context default.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => ctx.kubernetes.get({ cwd: executionCwd(exec), ...args }, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Read Kubernetes object', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kubernetes_list',
    description: 'List Kubernetes objects as JSON through the configured context, optionally using label and field selectors. This tool is read-only.',
    parameters: {
      resource: { type: 'string', required: true, description: 'Resource kind or plural resource name.' },
      namespace: { type: 'string', description: 'Namespace; omit to use the configured context default.' },
      label_selector: { type: 'string', description: 'Kubernetes label selector.' },
      field_selector: { type: 'string', description: 'Kubernetes field selector.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => ctx.kubernetes.list({
      cwd: executionCwd(exec),
      resource: args.resource,
      ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
      ...(args.label_selector === undefined ? {} : { labelSelector: args.label_selector }),
      ...(args.field_selector === undefined ? {} : { fieldSelector: args.field_selector }),
    }, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'List Kubernetes objects', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kubernetes_events',
    description: 'List Kubernetes Event objects in chronological order with optional selectors and an absolute inclusive occurrence-time window. Events are observations and may be repeated or delayed.',
    parameters: {
      namespace: { type: 'string', description: 'Namespace; omit to use the configured context default.' },
      label_selector: { type: 'string', description: 'Kubernetes Event label selector.' },
      field_selector: { type: 'string', description: 'Event field selector, for example involvedObject.name=api-1.' },
      since_time: { type: 'string', description: 'Inclusive RFC3339 lower bound for Event occurrence time.' },
      until_time: { type: 'string', description: 'Inclusive RFC3339 upper bound for Event occurrence time.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    execute: (args, exec) => ctx.kubernetes.events({
      cwd: executionCwd(exec),
      ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
      ...(args.label_selector === undefined ? {} : { labelSelector: args.label_selector }),
      ...(args.field_selector === undefined ? {} : { fieldSelector: args.field_selector }),
      ...(args.since_time === undefined ? {} : { sinceTime: args.since_time }),
      ...(args.until_time === undefined ? {} : { untilTime: args.until_time }),
    }, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'List Kubernetes events', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'kubernetes_logs',
    description: 'Read a bounded non-streaming snapshot of one Pod container log. Select a relative or absolute time window; an absolute upper bound is filtered locally. This tool cannot follow logs or exec in the Pod.',
    parameters: {
      pod: { type: 'string', required: true, description: 'Exact Pod name.' },
      namespace: { type: 'string', description: 'Namespace; omit to use the configured context default.' },
      container: { type: 'string', description: 'Container name; omit for a single/default container.' },
      previous: { type: 'boolean', description: 'Read the previous terminated container instance.' },
      tail_lines: { type: 'integer', description: 'Recent line count; omission uses the Provider default and excess is capped.' },
      since: { type: 'string', description: 'Relative Kubernetes duration such as 15m.' },
      since_time: { type: 'string', description: 'Absolute RFC3339 lower bound; mutually exclusive with since.' },
      until_time: { type: 'string', description: 'Absolute RFC3339 upper bound; enables timestamps and filters later lines.' },
      timestamps: { type: 'boolean', description: 'Include a Kubernetes timestamp prefix on each line.' },
    },
    output: { schema: { type: 'string' }, render: renderText },
    execute: (args, exec) => ctx.kubernetes.logs(ctx.kubernetes.resolveLogs({
      cwd: executionCwd(exec),
      pod: args.pod,
      ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
      ...(args.container === undefined ? {} : { container: args.container }),
      ...(args.previous === undefined ? {} : { previous: args.previous }),
      ...(args.tail_lines === undefined ? {} : { tailLines: args.tail_lines }),
      ...(args.since === undefined ? {} : { since: args.since }),
      ...(args.since_time === undefined ? {} : { sinceTime: args.since_time }),
      ...(args.until_time === undefined ? {} : { untilTime: args.until_time }),
      ...(args.timestamps === undefined ? {} : { timestamps: args.timestamps }),
    }), exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Read Kubernetes Pod logs', kind: 'read', rawInput: args }),
  }))
}
