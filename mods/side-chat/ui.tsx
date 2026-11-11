import { defineMod, textAt } from '@seti/mod-api'
import { MessageCircleQuestionMark } from 'lucide-react'
import { asideBlockView } from './AsideBlock'
import { SIDE_BUSY, sideChatView } from './SideChat'
import { sideChats } from './chat-store'
import manifest from './seti-mod.json' with { type: 'json' }

const DOCK = 'chat'

/**
 * The side chat's dock, its asides inline in the agent's transcript, and Ask aside from /btw,
 * the palette and an agent's menu, which opens the dock.
 */
export const sideChatUi = defineMod({
  manifest,
  ui: (api) => {
    const chats = sideChats(api)
    api.registerDock({ id: DOCK, icon: MessageCircleQuestionMark, view: sideChatView(api, chats) })
    api.registerTranscriptBlocks({
      id: 'asides',
      watch: chats.watch,
      blocks: (agent) => chats.view(agent).blocks,
      subscribe: chats.subscribe,
      refresh: chats.refresh,
      view: asideBlockView(api, chats),
    })
    api.registerCommand({
      id: 'ask',
      icon: MessageCircleQuestionMark,
      run: (args, context) => {
        const named = textAt(args, 'task')
        const agent = named === '' ? context.agent : named
        if (agent === null) {
          return
        }
        api.agents.openDock(agent, DOCK)
        const question = textAt(args, 'question')
        if (question !== '') {
          chats.ask(agent, question)
        }
      },
      waits: {
        subscribe: chats.subscribe,
        reason: (agent) => (chats.view(agent).answering ? SIDE_BUSY : null),
      },
      status: (args) =>
        `${textAt(args, 'question') === '' ? 'Opens' : 'Asks in'} the side chat; the agent is not interrupted`,
    })
    api.onDispose(chats.forgetAll)
  },
})
