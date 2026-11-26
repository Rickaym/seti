import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CASES, describeAdapter } from '../conformance/describe.js'
import { stopAll, type RealProcess } from '../conformance/real-process.js'
import { ScriptedResponses, type CallMapper } from './conformance-responses.js'
import { codeModeCall, codexCall } from './conformance-rig.js'
import { CODEX_GAPS, codexTarget, type CodexBench } from './conformance-target.js'

/** A model the suite runs Codex with, and how that model calls its tools. */
interface Shape {
  model: string
  calls: CallMapper
}

/** One model that Codex offers its tools to directly, and one that calls them from a script. */
const SHAPES: Shape[] = [
  { model: 'gpt-5.5', calls: codexCall },
  { model: 'gpt-6.2-sol', calls: codeModeCall },
]

/** The scripted model and a folder for the rigs, for the binary named, if any. */
async function benchFor(binary: string, shape: Shape): Promise<CodexBench | null> {
  if (binary === '') {
    return null
  }
  const model = new ScriptedResponses(shape.calls)
  const baseUrl = await model.start()
  const folder = mkdtempSync(path.join(tmpdir(), 'seti-codex-rigs-'))
  const started: RealProcess[] = []
  afterAll(async () => {
    await stopAll(started)
    model.close()
    rmSync(folder, { recursive: true, force: true })
  })
  return { binary, model, baseUrl, folder, started, agentModel: shape.model }
}

const binary = process.env.SETI_CODEX_BIN ?? ''

describe.runIf(process.env.CI === 'true')('the Codex conformance run in CI', () => {
  it('has the pinned binary, so the cases below run instead of skipping', () => {
    expect(binary, 'CI must set SETI_CODEX_BIN (scripts/codex-binary.mjs)').not.toBe('')
  })
})

for (const shape of SHAPES) {
  const bench = await benchFor(binary, shape)
  describe.skipIf(bench === null)(`Codex with ${shape.model} over the binary SETI_CODEX_BIN names`, () => {
    if (bench !== null) {
      describeAdapter(codexTarget(bench))
      it('offers the model no tool that starts a subagent', () => {
        expect(bench.model.bodies.length).toBeGreaterThan(0)
        expect(bench.model.bodies.filter((body) => body.includes('"spawn_agent"'))).toEqual([])
      })
    }
  })
}

it('every known gap of the Codex adapter names a case of the suite', () => {
  const ids = new Set(CASES.map((each) => each.id))
  expect(Object.keys(CODEX_GAPS).filter((id) => !ids.has(id))).toEqual([])
})
