import { expect, it } from 'vitest'
import { proofRuns, proofSuite } from './test-codex-proof-suite.js'

it.runIf(process.env.CI === 'true')('runs in CI, which has the pinned Codex and a sandbox', () => {
  expect(proofRuns()).toBe(true)
})

proofSuite(false)
