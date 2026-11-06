import { createFakeSeti } from '@seti/mod-api/testing'
import { expect, it } from 'vitest'
import manifest from '../seti-mod.json' with { type: 'json' }
import logic from '../src/logic.js'

it('says hello and counts', async () => {
  const { seti, ctx } = createFakeSeti({ manifest, settings: { greeting: 'Hi' } })
  expect(await logic.commands.hello({}, ctx, seti)).toEqual({ text: 'Hi (1)' })
  expect(await logic.commands.hello({}, ctx, seti)).toEqual({ text: 'Hi (2)' })
})
