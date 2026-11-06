import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // pnpm test runs packages in parallel; the default cache at the workspace root is shared.
    fsModuleCachePath: 'node_modules/.vitest-cache',
    globalSetup: ['./src/test-global.ts'],
    setupFiles: ['./src/test-env.ts'],
    // Runs share one host with Seti, agents and CI runners; more workers only add timing flakes.
    maxWorkers: 4,
    // That host runs at load 15 to 50, where a correct test can take several times its idle time.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
})
