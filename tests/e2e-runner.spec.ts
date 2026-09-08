import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runner = resolve(root, 'scripts/aiops-e2e.mjs')

describe('guarded real Alertmanager/k3s E2E runner', () => {
  it('refuses execution without an explicit disposable-cluster guard and context', () => {
    const result = spawnSync(process.execPath, [runner, 'setup'], { encoding: 'utf8', env: {} })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AIOPS_E2E_CONFIRM=local-test-only')
  })

  it('keeps the scenario matrix and restart verification executable without committed credentials', async () => {
    const source = await readFile(runner, 'utf8')
    for (const scenario of ['KubePodCrashLooping', 'TargetDown', 'ArbitraryVendorSignal', 'ArbitraryMissingSeverity', 'Watchdog', 'LifecycleProbe', 'DuplicateProbe', 'BurstProbe', 'restart-recovery']) {
      expect(source).toContain(scenario)
    }
    expect(source).toContain('real Prometheus -> AlertmanagerConfig -> receiver probe')
    expect(source).toContain('namespace: ${JSON.stringify(namespace)}')
    expect(source).not.toMatch(/Bearer [A-Za-z0-9]/)
    expect(source).not.toContain('192.168.')
    expect(source).toContain("spawnSync('kubectl'")
    expect(source).toContain("['pipe', 'pipe', 'pipe']")
    expect(source).toContain("['delete', 'pod', 'crashloop-webhook-test'")
  })
})
