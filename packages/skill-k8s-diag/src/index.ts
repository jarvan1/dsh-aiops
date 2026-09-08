/** Packaged general AIOps diagnosis skill registration for DSH AIOps Sessions. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'aiops-skill-k8s-diag'
export const inject = ['skills']

export const SKILL_NAME = 'aiops-diag'
export const SKILL_DESCRIPTION = 'Diagnose general Alertmanager alerts with the supplied alert-time window, dynamically selected read-only evidence sources, explicit hypothesis tests, and a durable structured incident report. Use for Kubernetes, node, Prometheus target, service, error-rate, latency, storage, and sparsely labelled alerts.'

const skillPath = fileURLToPath(new URL('../skills/k8s-diag/SKILL.md', import.meta.url))

/** Register the packaged instructions globally so they survive Workspace changes. */
export function apply(ctx: Context): void {
  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    provider: name,
    resourceBase: { kind: 'directory', path: dirname(skillPath) },
    content: skillBody(readFileSync(skillPath, 'utf8')),
  })
}

function skillBody(document: string): string {
  const match = /^---\n[\s\S]*?\n---\n/u.exec(document)
  if (match === null) throw new Error('aiops-diag SKILL.md has invalid frontmatter')
  const body = document.slice(match[0].length).trim()
  if (body === '') throw new Error('aiops-diag SKILL.md has no instructions')
  return body
}
