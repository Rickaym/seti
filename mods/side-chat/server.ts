import { defineMod, textAt } from '@seti/mod-api'
import manifest from './seti-mod.json' with { type: 'json' }

/**
 * Side questions to an agent: the dock's route streams an answer, a close ends a chat, and `ask`
 * answers the EA and agents whole. Seti's engine forks the session and decides what it may read.
 */
export const sideChatServer = defineMod({
  manifest,
  server: (api) => {
    api.streamRoute('POST', '/tasks/:task', async ({ params, body }, stream) => {
      await api.aside.ask(params.task ?? '', body, async (event) => stream.send(event.type, event), stream.signal)
    })
    api.route('DELETE', '/tasks/:task/chats/:chat', async ({ params }) => {
      await api.aside.close(params.task ?? '', params.chat ?? '')
      return { body: null }
    })
    api.registerCommand('ask', async ({ args }) => {
      const asked = await api.aside.answer(textAt(args, 'task'), textAt(args, 'question'))
      return { ...asked, text: `${asked.title} answers aside: ${asked.answer}` }
    })
  },
})
