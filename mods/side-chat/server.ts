import { defineMod, textAt, type Aside, type ServerModApi } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

/** Asides the EA's List asides reads back, newest last. */
const LISTED = 20
const ANSWER_CHARS = 600

const clip = (text: string) => (text.length > ANSWER_CHARS ? `${text.slice(0, ANSWER_CHARS - 3)}...` : text)

function askedBy(aside: Aside): string {
  if (aside.asked_by === 'agent') {
    return `agent ${aside.asker_title ?? 'unknown'}`
  }
  return aside.asked_by === 'ea' ? 'the EA' : 'the user'
}

const listed = (aside: Aside) =>
  `- ${aside.id}, asked by ${askedBy(aside)} at ${aside.asked_at}\n  Q: ${aside.question}\n  A: ${clip(aside.answer)}`

/** Changes the agent's asides, then tells its transcript to show them again. */
async function changing<T>(api: ServerModApi, task: string, change: () => Promise<T>): Promise<T> {
  try {
    return await change()
  } finally {
    await api.transcript.refresh(task).catch(() => undefined)
  }
}

/**
 * Side questions to an agent: the dock's route streams an answer, the asides routes read and
 * delete what Seti kept, and `ask` answers the EA and agents whole. Seti's engine forks the
 * session, decides what it may read and stores each answer as an aside.
 */
export const sideChatServer = defineMod({
  manifest,
  server: (api) => {
    api.streamRoute('POST', '/tasks/:task', async ({ params, body }, stream) => {
      const task = params.task ?? ''
      await changing(api, task, async () =>
        api.aside.ask(task, body, async (event) => stream.send(event.type, event), stream.signal),
      )
    })
    api.route('GET', '/tasks/:task/asides', async ({ params }) => ({
      body: { asides: await api.aside.list(params.task ?? '') },
    }))
    api.route('DELETE', '/tasks/:task/asides/:aside', async ({ params }) => {
      const task = params.task ?? ''
      await changing(api, task, async () => api.aside.remove(task, params.aside ?? ''))
      return { body: null }
    })
    api.route('DELETE', '/tasks/:task/asides', async ({ params }) => {
      const task = params.task ?? ''
      return { body: { cleared: await changing(api, task, async () => api.aside.clear(task)) } }
    })
    api.registerCommand('ask', async ({ args }) => {
      const task = textAt(args, 'task')
      const asked = await changing(api, task, async () => api.aside.answer(task, textAt(args, 'question')))
      return { ...asked, text: `${asked.title} answers aside: ${asked.answer}` }
    })
    api.registerCommand('asides', async ({ args }) => {
      const asides = (await api.aside.list(textAt(args, 'task'))).slice(-LISTED)
      return asides.length === 0 ? 'No asides yet.' : asides.map(listed).join('\n')
    })
    api.registerCommand('clear', async ({ args }) => {
      const task = textAt(args, 'task')
      const one = textAt(args, 'aside')
      if (one !== '') {
        await changing(api, task, async () => api.aside.remove(task, one))
        return 'Deleted the aside.'
      }
      const count = await changing(api, task, async () => api.aside.clear(task))
      return `Deleted ${String(count)} ${count === 1 ? 'aside' : 'asides'}.`
    })
  },
})
