import { expect, it, vi } from 'vitest'
import { proofRuns, proofSuite } from './test-codex-proof-suite.js'

vi.hoisted(() => {
  process.env.SETI_NODE = 'split'
})

/** Claude Code answers the Codex agent's second opinions from a fake; Codex runs for real. */
const sdk = await vi.hoisted(async () => (await import('./test-opinion-sdk.js')).opinionSdk())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

it.runIf(process.env.CI === 'true')('runs in CI, which has the pinned Codex and a sandbox', () => {
  expect(proofRuns()).toBe(true)
})

proofSuite(true)
