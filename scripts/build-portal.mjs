import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const portal = resolve('packages/aiops-portal')
const result = spawnSync(process.execPath, ['node_modules/tsdown/dist/run.mjs'], {
  cwd: portal,
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
