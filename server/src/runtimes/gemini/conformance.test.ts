import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CASES, describeAdapter } from '../conformance/describe.js'
import { stopAll, type RealProcess } from '../conformance/real-process.js'
import { ScriptedGemini } from './conformance-api.js'
import { geminiCall } from './conformance-rig.js'
import { GEMINI_GAPS, geminiTarget, type GeminiBench } from './conformance-target.js'

const MODEL = 'gemini-3.8-flash'

/** The scripted API and a folder for the rigs, for the program named, if any. */
async function benchFor(binary: string): Promise<GeminiBench | null> {
  if (binary === '') {
    return null
  }
  const model = new ScriptedGemini(geminiCall)
  const baseUrl = await model.start()
  const folder = mkdtempSync(path.join(tmpdir(), 'seti-gemini-rigs-'))
  const started: RealProcess[] = []
  afterAll(async () => {
    await stopAll(started)
    model.close()
    rmSync(folder, { recursive: true, force: true })
  })
  return { binary, model, baseUrl, folder, started, agentModel: MODEL }
}

const bench = await benchFor(process.env.SETI_GEMINI_BIN ?? '')

describe.skipIf(bench === null)('Gemini CLI over the program SETI_GEMINI_BIN names', () => {
  if (bench !== null) {
    describeAdapter(geminiTarget(bench))
  }
})

it('every known gap of the Gemini adapter names a case of the suite', () => {
  const ids = new Set(CASES.map((each) => each.id))
  expect(Object.keys(GEMINI_GAPS).filter((id) => !ids.has(id))).toEqual([])
})
