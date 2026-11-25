import { describe, expect, it } from 'vitest'
import { DREAM_PROMPT_VERSION } from './prompt.js'
import { reportMarkdown } from './report.js'

describe('the dream prompt version', () => {
  it('is a short hash of the wording, and ends the report', () => {
    expect(DREAM_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/)
    const end = {
      state: 'done' as const,
      reason: null,
      cost_usd: 0.25,
      steps: 14,
      denials: 0,
      memory_changes: 1,
      report: null,
    }
    const text = reportMarkdown({ title: 'Lead', night: '2026-11-24', prompt: DREAM_PROMPT_VERSION }, end)
    expect(text.trimEnd().split('\n').at(-1)).toBe(`Prompt ${DREAM_PROMPT_VERSION}.`)
  })
})
