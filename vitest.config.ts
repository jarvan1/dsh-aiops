import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'],
    pool: 'threads',
    clearMocks: true,
    restoreMocks: true,
  },
})
