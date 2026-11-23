import { projectClaude, type ToolCall } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { goldenCorpus } from '../golden/corpus.js'
import { asciiJson } from '../golden/json.js'
import { asRecord } from '../repeat-hooks.js'
import { decideClaude, type Setup } from './policy-fixtures.js'

/** The setups every recorded call is decided in: Seti's default and the modes an agent runs in. */
const SETUPS: Record<string, Setup> = {
  sandboxed: { sandboxed: true, guard: true },
  unsandboxed: { sandboxed: false, guard: true },
  ask: { sandboxed: false, guard: true, mode: 'ask' },
  bypass: { sandboxed: false, guard: true, mode: 'bypass' },
  plan: { sandboxed: true, guard: true, mode: 'plan' },
}

/** A call's main target, so a reader of the golden file sees what was decided. */
const targetOf = (call: ToolCall): string =>
  call.shell?.command ??
  call.read?.paths[0] ??
  call.edit?.changes[0]?.path ??
  call.web?.url ??
  call.search?.path ??
  call.subagent?.agentType ??
  ''

/** Every tool call the golden transcripts record, once each, with the transcript it came from. */
function recordedCalls(): { transcript: string; call: ToolCall }[] {
  const seen = new Set<string>()
  return goldenCorpus().flatMap((transcript) =>
    transcript.rows
      .flatMap((row) => (row.kind === 'sdk' ? projectClaude(row.payload) : []))
      .flatMap((event) => {
        if (event.type !== 'tool.started' || seen.has(event.call.callId)) {
          return []
        }
        seen.add(event.call.callId)
        return [{ transcript: transcript.name, call: event.call }]
      }),
  )
}

const calls = recordedCalls()

describe("Seti's own decision on every recorded tool call", () => {
  it('replays enough of the corpus to matter', () => {
    expect(calls.length).toBeGreaterThan(40)
  })

  it('stays as the golden file freezes it, in every mode', async () => {
    const decided = calls.map(({ transcript, call }) => {
      const input = asRecord(call.input)
      const decisions = Object.fromEntries(
        Object.entries(SETUPS).map(([name, setup]) => {
          const decision = decideClaude(call.name, input, setup)
          return [name, [decision.verdict, decision.step, decision.rule ?? ''].join(' ').trim()]
        }),
      )
      return { transcript, tool: call.name, target: targetOf(call), decisions }
    })
    await expect(asciiJson(decided)).toMatchFileSnapshot('./replay-corpus.golden.json')
  })

  it('leaves every question and plan to the user, in every mode', () => {
    const userOnly = calls.filter(({ call }) => call.kind === 'question' || call.name === 'ExitPlanMode')
    expect(userOnly.length).toBeGreaterThan(0)
    for (const { call } of userOnly) {
      for (const setup of Object.values(SETUPS)) {
        expect(decideClaude(call.name, asRecord(call.input), setup).verdict, call.callId).toBe('ask')
      }
    }
  })
})
