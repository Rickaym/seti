import { expect, it, vi } from 'vitest'
import { proofRuns, proofSuite } from './test-codex-proof-suite.js'

vi.hoisted(() => {
  process.env.SETI_NODE = 'split'
})

it.runIf(process.env.CI === 'true')('runs in CI, which has the pinned Codex and a sandbox', () => {
  expect(proofRuns()).toBe(true)
})

proofSuite(true)
