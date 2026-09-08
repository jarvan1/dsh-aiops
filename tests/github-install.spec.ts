import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('GitHub source installation', () => {
  it('exposes a repository-root DSH bundle', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dsh?: { bundle?: { patch?: string } }
      scripts?: { prepare?: string }
      dependencies?: Record<string, string>
    }

    expect(manifest.name).toBe('dsh-aiops')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.scripts?.prepare).toBe('pnpm run build:github')
    expect(manifest.dependencies?.['@kubernetes/client-node']).toBe('2.0.0')
  })

  it('uses repository-relative plugin artifacts that are all buildable', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    const entries = [...patch.matchAll(/^\s+name: '(\.\/packages\/[^']+)'$/gm)]
      .map(match => match[1])

    expect(entries).toHaveLength(11)
    expect(patch).not.toContain('KUBECTL_COMMAND')
    for (const entry of entries) await expect(access(resolve(root, entry!))).resolves.toBeUndefined()
  })
})
