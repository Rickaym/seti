import { expect } from 'vitest'
import type { Case } from './case.js'
import type { Subject } from './subject.js'

/** The subject's one-shot, which a case skipped for a runtime without one never reaches. */
function oneShotOf(subject: Subject): NonNullable<Subject['oneShot']> {
  if (subject.oneShot === undefined) {
    throw new Error(`${subject.id} has no one-shot`)
  }
  return subject.oneShot
}

/** One model call with no tools: an answer, its tokens, and no tool that runs. */
export const ONE_SHOT: Case[] = [
  {
    id: 'OS-1',
    title: 'a one-shot returns the answer and its token use from one process it ends',
    proves: 'design C.1 oneShot',
    needsOneShot: true,
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'forty-two' }]] })
      const result = await oneShotOf(subject)(rig, 'What is six times seven?')
      expect(result.text).toBe('forty-two')
      expect(result.refused).toBe(0)
      if (subject.profile.usage.tokens) {
        expect(result.tokens.input + result.tokens.output).toBeGreaterThan(0)
      }
      expect(rig.spawns).toHaveLength(1)
      expect(rig.selfStarts).toHaveLength(0)
    },
  },
  {
    id: 'OS-2',
    title: "a one-shot's tool call is refused without asking anyone and has no effect",
    proves: 'design C.1: the answering model gets no tool',
    needsOneShot: true,
    run: async (subject) => {
      const call = { tool: 'sh', args: { cmd: 'touch leaked' }, output: 'touched' }
      const rig = subject.rig({ turns: [[{ call }, { say: 'answered without it' }]] })
      const result = await oneShotOf(subject)(rig, 'Look around, then answer.')
      expect(rig.effects).toHaveLength(0)
      expect(result.refused).toBe(1)
      expect(result.text).toBe('answered without it')
    },
  },
]
