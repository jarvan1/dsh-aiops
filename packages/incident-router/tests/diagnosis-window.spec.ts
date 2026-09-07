import { describe, expect, it } from 'vitest'
import { diagnosisTimeContext } from '../src/diagnosis-window.ts'

const policy = {
  beforeSeconds: 900,
  afterSeconds: 1800,
  prometheusStepSeconds: 30,
  logTailLines: 1000,
}

describe('diagnosisTimeContext', () => {
  it('derives exact tool parameters around startsAt and caps the end at receipt time', () => {
    expect(diagnosisTimeContext(
      { startsAt: '2026-09-06T01:00:00+00:00' },
      Date.parse('2026-09-06T01:12:34Z'),
      policy,
    )).toEqual({
      version: 1,
      anchor: { source: 'alert.startsAt', time: '2026-09-06T01:00:00.000Z', epochMs: 1788656400000 },
      window: {
        start: '2026-09-06T00:45:00.000Z',
        end: '2026-09-06T01:12:34.000Z',
        beforeSeconds: 900,
        afterSeconds: 754,
      },
      prometheusQueryRange: {
        start: '2026-09-06T00:45:00.000Z',
        end: '2026-09-06T01:12:34.000Z',
        step: '30s',
      },
      kubernetesEvents: {
        since_time: '2026-09-06T00:45:00.000Z',
        until_time: '2026-09-06T01:12:34.000Z',
      },
      kubernetesLogs: {
        since_time: '2026-09-06T00:45:00.000Z',
        until_time: '2026-09-06T01:12:34.000Z',
        tail_lines: 1000,
        timestamps: true,
      },
    })
  })

  it('never emits a future end and bounds delayed deliveries at configured lookahead', () => {
    const beforeAnchor = diagnosisTimeContext(
      { startsAt: '2026-09-06T01:00:00Z' },
      Date.parse('2026-09-06T00:59:00Z'),
      policy,
    )
    expect(beforeAnchor.window.end).toBe('2026-09-06T01:00:00.000Z')

    const delayed = diagnosisTimeContext(
      { startsAt: '2026-09-06T01:00:00Z' },
      Date.parse('2026-09-06T03:00:00Z'),
      policy,
    )
    expect(delayed.window.end).toBe('2026-09-06T01:30:00.000Z')
    expect(delayed.window.afterSeconds).toBe(1800)
  })

  it('rejects invalid timestamps and non-positive policy values', () => {
    expect(() => diagnosisTimeContext({ startsAt: 'bad' }, 0, policy)).toThrow('startsAt')
    expect(() => diagnosisTimeContext({ startsAt: '2026-09-06T01:00:00Z' }, Number.NaN, policy))
      .toThrow('receivedAt')
    expect(() => diagnosisTimeContext(
      { startsAt: '2026-09-06T01:00:00Z' },
      0,
      { ...policy, beforeSeconds: 0 },
    )).toThrow('beforeSeconds')
  })
})
