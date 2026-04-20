import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'test-artifacts/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
