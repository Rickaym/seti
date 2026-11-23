import { expect, it } from 'vitest'
import { CASES, describeAdapter } from '../conformance/describe.js'
import { scriptedTarget } from './target.js'

describeAdapter(scriptedTarget)

it('runs every case: the scripted adapter declares all the suite reads and has no known gap', () => {
  expect(CASES.filter((each) => (each.skip?.(scriptedTarget.profile) ?? null) !== null)).toEqual([])
  expect(scriptedTarget.gaps).toBeUndefined()
})
