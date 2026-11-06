import { isReservedHandle, MOD_LIMITS, parseMentions } from '@seti/shared'
import { z } from 'zod'
import { HttpError } from '../../http.js'
import { teamMembers } from '../../store/team.js'
import { postTeamMessage } from '../../team.js'
import type { ModCall } from '../capabilities.js'
import { filterCovers, grantOf, readFilter } from '../scopes.js'
import { defineOp } from './define.js'
import { takeSend } from './limits.js'

const text = z.string().trim().min(1).max(MOD_LIMITS.chatChars)

/** The agent a mod's direct message goes to: one inside its filter, never the user or the EA. */
async function recipient(call: ModCall, to: string): Promise<string> {
  const handle = to.replace(/^@/, '').toLowerCase()
  if (isReservedHandle(handle)) {
    throw new HttpError(403, `A mod messages one agent directly, never @${handle}`)
  }
  const [member] = await teamMembers.byHandles([handle])
  if (member === undefined || !(await filterCovers(readFilter(call), member.task_id))) {
    throw new HttpError(404, `No agent has the handle @${handle}`)
  }
  return handle
}

/** Posts that carry the mod as their author, labelled as the mod's wherever they are read. */
export const chatOps = {
  'chat.post': defineOp({
    args: z.strictObject({ text }),
    run: async (args, { call }) => {
      if (!grantOf(call, 'chat.post').public) {
        throw new HttpError(403, `The mod ${call.modId} was not granted public posts in the group chat`)
      }
      const [mention] = parseMentions(args.text)
      if (mention !== undefined) {
        throw new HttpError(403, `A mod's public post mentions no one, such as @${mention}; message one agent directly`)
      }
      takeSend(call, 'chat')
      const { message } = await postTeamMessage({ kind: 'mod', modId: call.modId }, args.text)
      return { id: message.id }
    },
  }),
  'chat.post.direct': defineOp({
    args: z.strictObject({ text, to: z.string().min(1).max(60) }),
    run: async (args, { call }) => {
      if (!grantOf(call, 'chat.post').direct) {
        throw new HttpError(403, `The mod ${call.modId} was not granted direct messages`)
      }
      const to = await recipient(call, args.to)
      takeSend(call, 'chat')
      const { message } = await postTeamMessage({ kind: 'mod', modId: call.modId }, args.text, { to })
      return { id: message.id }
    },
  }),
}
