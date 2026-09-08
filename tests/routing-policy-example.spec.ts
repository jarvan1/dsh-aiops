import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  assertRoutingSettings,
  evaluateRoutingPolicy,
  type RoutingSettings,
} from '../packages/incident-router/src/index.ts'
import { describe, expect, it } from 'vitest'

const examples = resolve(import.meta.dirname, '../docs/examples')

describe('routing-policy JSON examples', () => {
  it('keeps the checked-in policy and dry-run labels valid and executable', async () => {
    const policy = JSON.parse(await readFile(resolve(examples, 'routing-policy.example.json'), 'utf8')) as RoutingSettings
    const labels = JSON.parse(await readFile(resolve(examples, 'routing-policy-labels.example.json'), 'utf8')) as Record<string, string>

    expect(() => assertRoutingSettings(policy)).not.toThrow()
    expect(evaluateRoutingPolicy(labels, policy)).toMatchObject({
      version: 1,
      accepted: true,
      alertname: 'TargetDown',
      severity: 'warning',
    })
  })
})
