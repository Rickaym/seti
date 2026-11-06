import { defineConfig } from 'vitest/config'

/**
 * The Vitest config each bundled mod's `vitest.config.ts` re-exports. `pnpm test` runs
 * packages in parallel, and by default they share one transform cache at the workspace
 * root, which each run clears when the lockfile changes; this gives every package its own.
 */
export const modTestConfig = defineConfig({
  test: { fsModuleCachePath: 'node_modules/.vitest-cache' },
})
