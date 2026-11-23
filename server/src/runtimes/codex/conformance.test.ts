import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CASES, describeAdapter } from '../conformance/describe.js'
import { ScriptedResponses } from './conformance-responses.js'
import { codexCall } from './conformance-rig.js'
import { CODEX_GAPS, codexTarget, type CodexBench } from './conformance-target.js'

/** The scripted model and a folder for the rigs, for the binary named, if any. */
async function benchFor(binary: string): Promise<CodexBench | null> {
  if (binary === '') {
    return null
  }
  const model = new ScriptedResponses(codexCall)
  const baseUrl = await model.start()
  const folder = mkdtempSync(path.join(tmpdir(), 'seti-codex-rigs-'))
  afterAll(() => {
    model.close()
    rmSync(folder, { recursive: true, force: true })
  })
  return { binary, model, baseUrl, folder }
}

const bench = await benchFor(process.env.SETI_CODEX_BIN ?? '')

describe.skipIf(bench === null)('Codex over the binary SETI_CODEX_BIN names', () => {
  if (bench !== null) {
    describeAdapter(codexTarget(bench))
  }

  it('every known gap of the Codex adapter names a case of the suite', () => {
    const ids = new Set(CASES.map((each) => each.id))
    expect(Object.keys(CODEX_GAPS).filter((id) => !ids.has(id))).toEqual([])
  })
})
