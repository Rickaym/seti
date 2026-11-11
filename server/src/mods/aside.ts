import type { ModAsideApi } from '@seti/mod-api'
import { SIDE_CHAT_ID, sideChatInput, sideQuestionInput, type Disposer } from '@seti/shared'
import type { z } from 'zod'
import { asAsker, currentRequestSource } from '../access.js'
import { fromAgent } from '../ea-guard.js'
import { describeIssues, HttpError } from '../http.js'
import { askAside, prepareAsk } from '../side-chat/ask.js'
import { closeAllChats } from '../side-chat/chats.js'
import { clearAsides, deleteAside, listAsides } from '../side-chat/history.js'
import { requireTask } from '../tasks.js'
import { requireOp } from './capabilities.js'

type Run = <T>(fn: () => Promise<T>) => Promise<T>

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new HttpError(400, describeIssues(result.error))
  }
  return result.data
}

/** An agent asks through its seti tools; a question of itself has nothing to fork. */
function refuseSelf(task: string): void {
  const source = currentRequestSource()
  if (source?.via === 'agent' && source.taskId === task) {
    throw new HttpError(403, 'You cannot ask a side question of yourself with a seti tool; the user does that in Seti.')
  }
}

/**
 * The tasks.ask capability: side questions the core side chat engine answers, as whoever asked
 * the mod, so agents get no file reads and the audit names the asker. A mod that holds it stops
 * every answer being written when it is turned off; the stored asides stay.
 */
export function asideApi(run: Run, holds: boolean, track: (dispose: Disposer) => Disposer): ModAsideApi {
  if (holds) {
    track(closeAllChats)
  }
  const granted = async () =>
    run(async () => {
      requireOp('tasks.ask')
      return Promise.resolve()
    })
  return {
    ask: async (task, input, emit, signal) => {
      await granted()
      const body = parsed(sideChatInput, input)
      await asAsker(async () => {
        const ask = await prepareAsk(task, body, !fromAgent())
        await ask.run(emit, signal)
      })
    },
    answer: async (task, question) => {
      await granted()
      const asked = parsed(sideQuestionInput, { question }).question
      return asAsker(async () => {
        refuseSelf(task)
        const { id, title } = await requireTask(task)
        return { id, title, ...(await askAside(id, asked, !fromAgent())) }
      })
    },
    list: async (task) => {
      await granted()
      return asAsker(async () => listAsides(task))
    },
    remove: async (task, aside) => {
      await granted()
      if (!SIDE_CHAT_ID.test(aside)) {
        throw new HttpError(400, 'That is not an aside id')
      }
      await asAsker(async () => deleteAside(task, aside))
    },
    clear: async (task) => {
      await granted()
      return asAsker(async () => clearAsides(task))
    },
  }
}
