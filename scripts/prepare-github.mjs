import { readFile, writeFile } from 'node:fs/promises'

const replacements = new Map([
  ['@deepseek-ai/dsh-aiops-http-read', '../../aiops-http-read/lib/index.js'],
  ['@deepseek-ai/dsh-aiops-incident', '../../aiops-incident/lib/index.js'],
  ['@deepseek-ai/dsh-aiops-kubernetes', '../../aiops-kubernetes/lib/index.js'],
])

const files = [
  'packages/aiops-alertmanager/lib/index.js',
  'packages/aiops-prometheus/lib/index.js',
  'packages/aiops-portal/lib/index.js',
  'packages/tool-aiops-history/lib/index.js',
]

for (const file of files) {
  let source = await readFile(file, 'utf8')
  for (const [specifier, replacement] of replacements) {
    source = source.replaceAll(`'${specifier}'`, `'${replacement}'`)
    source = source.replaceAll(`"${specifier}"`, `"${replacement}"`)
  }
  await writeFile(file, source)
}

for (const file of files) {
  const source = await readFile(file, 'utf8')
  for (const specifier of replacements.keys()) {
    if (source.includes(specifier)) {
      throw new Error(`${file} still contains unresolved workspace import ${specifier}`)
    }
  }
}
