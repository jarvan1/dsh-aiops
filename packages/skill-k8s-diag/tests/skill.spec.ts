import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import { apply, SKILL_DESCRIPTION, SKILL_NAME } from '../src/index.ts'

describe('packaged k8s-diag skill', () => {
  it('registers the validated SKILL.md body as a globally available skill', () => {
    const ctx = new Context()
    const register = vi.fn((_skill: SkillRegistration) => () => {})
    ctx.provide('skills', { register } as never)

    apply(ctx)

    expect(register).toHaveBeenCalledOnce()
    const registration = register.mock.calls[0]?.[0]
    expect(registration).toMatchObject({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: 'bundled',
      provider: 'aiops-skill-k8s-diag',
    })
    expect(registration?.content).toContain('diagnosis.anchor')
    expect(registration?.content).toContain('aiops_incident_report')
    expect(registration?.content).toContain('CrashLoopBackOff')
    expect(registration?.content).not.toContain('name: k8s-diag')
  })

  it('keeps the runtime identity and description aligned with SKILL.md frontmatter', () => {
    const path = fileURLToPath(new URL('../skills/k8s-diag/SKILL.md', import.meta.url))
    const document = readFileSync(path, 'utf8')
    expect(document).toContain(`name: ${SKILL_NAME}`)
    expect(document).toContain(`description: "${SKILL_DESCRIPTION}"`)
    expect(document).toContain('version: "1.1.0"')
  })
})
