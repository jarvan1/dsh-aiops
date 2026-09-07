/** Verify that relative Markdown links in the external workspace resolve locally. */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ignoredDirectories = new Set(['lib', 'node_modules'])

async function markdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

const missing = []
for (const file of await markdownFiles(root)) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1]
    if (href === undefined || href.startsWith('#') || /^[a-z]+:/i.test(href)) continue
    const target = decodeURIComponent(href.split('#', 1)[0])
    if (target.length === 0) continue
    try {
      await stat(resolve(dirname(file), target))
    } catch {
      missing.push(`${file.slice(root.length + 1)} -> ${href}`)
    }
  }
}

if (missing.length > 0) {
  throw new Error(`missing relative Markdown links:\n${missing.join('\n')}`)
}

console.log('docs:check: all relative Markdown links resolve')
