import { expect, it, vi } from 'vitest'
import { CASES, describeAdapter } from '../conformance/describe.js'
import { claudeTarget } from './conformance-target.js'

const slot = await vi.hoisted(async () => {
  const { QuerySlot } = await import('./conformance-rig.js')
  return new QuerySlot()
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: (args: Parameters<typeof slot.query>[0]) => slot.query(args),
}))

describeAdapter(claudeTarget(slot))

it('every known gap of the Claude adapter names a case of the suite', () => {
  const ids = new Set(CASES.map((each) => each.id))
  expect(Object.keys(claudeTarget(slot).gaps ?? {}).filter((id) => !ids.has(id))).toEqual([])
})
