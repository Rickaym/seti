import {
  archivedRefusal,
  chatSearchQuery,
  teamFileRequest,
  teamMemberInput,
  teamMessagesQuery,
  teamPostInput,
  type TeamMessage,
  type TeamStreamEvent,
} from '@seti/shared'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { currentRequestSource } from '../access.js'
import { sendKey, sendOnce } from '../client-sends.js'
import { sendFiles } from '../file-handoff.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { teamSearch } from '../store/search.js'
import { canRead, teamMessages, USER_READER, type TeamReader } from '../store/team.js'
import { requireTask } from '../tasks.js'
import { subscribeTeam } from '../team-events.js'
import { replyToMention } from '../team-reply.js'
import { postTeamMessage, teamMemberOf, teamRoster, updateMember } from '../team.js'

const KEEPALIVE_MS = 15_000
const BACKLOG = 50
const CATCH_UP = 500

const taskParam = z.object({ taskId: z.string().min(1).max(100) })

function lastEventId(header: string | undefined): number | undefined {
  const id = Number(header)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** The user reads every message; the EA reads public ones and its own direct messages. */
const readerOf = (): TeamReader => (currentRequestSource()?.via === 'ea' ? { kind: 'ea' } : USER_READER)

/** The messages a stream opens with: the newest, those the client missed, or the newest again. */
async function opening(
  reader: TeamReader,
  after: number | undefined,
): Promise<{ reset: boolean; backlog: TeamMessage[] }> {
  const missed = after === undefined ? null : await teamMessages.list(reader, CATCH_UP + 1, after)
  if (missed !== null && missed.length <= CATCH_UP) {
    return { reset: false, backlog: missed }
  }
  return { reset: missed !== null, backlog: await teamMessages.list(reader, BACKLOG) }
}

/** Recent or missed messages, then new ones; a `reset` replaces a gap too long to fill. */
const streamTeam = (c: Context, after: number | undefined) =>
  streamSSE(c, async (sse) => {
    const reader = readerOf()
    const queue: TeamStreamEvent[] = []
    let wake: (() => void) | null = null
    const unsubscribe = subscribeTeam((event) => {
      if (event.type === 'message' && !canRead(reader, event.message)) {
        return
      }
      queue.push(event)
      wake?.()
    })
    sse.onAbort(() => {
      unsubscribe()
      wake?.()
    })
    const { reset, backlog } = await opening(reader, after)
    let cursor = backlog.at(-1)?.id ?? after ?? 0
    const first = { event: reset ? 'reset' : 'backlog', data: JSON.stringify(backlog) }
    await sse.writeSSE(cursor === 0 ? first : { ...first, id: String(cursor) })
    while (!sse.aborted) {
      const event = queue.shift()
      if (event?.type === 'message' && event.message.id > cursor) {
        cursor = event.message.id
        await sse.writeSSE({ event: 'message', id: String(cursor), data: JSON.stringify(event.message) })
      } else if (event?.type === 'member') {
        await sse.writeSSE({ event: 'member', data: JSON.stringify(event.member) })
      } else if (event === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, KEEPALIVE_MS)
        })
        wake = null
        if (queue.length === 0) {
          await sse.writeSSE({ event: 'ping', data: '' })
        }
      }
    }
  })

export const teamRoutes = new Hono()
  .get('/messages', valid('query', teamMessagesQuery), async (c) => {
    const { after, before, around, limit } = c.req.valid('query')
    const reader = readerOf()
    if (around !== undefined) {
      return ok(c, await teamMessages.around(reader, limit, around))
    }
    return ok(
      c,
      before === undefined
        ? await teamMessages.list(reader, limit, after)
        : await teamMessages.before(reader, limit, before),
    )
  })
  .get('/search', valid('query', chatSearchQuery), async (c) =>
    ok(c, await teamSearch.search(readerOf(), c.req.valid('query'))),
  )
  .post('/messages', validJson(teamPostInput), async (c) => {
    const { text, reply_to: replyTo, to, client_id: clientId } = c.req.valid('json')
    const fromEa = currentRequestSource()?.via === 'ea'
    if (replyTo !== undefined && !fromEa) {
      throw new HttpError(400, 'Only the EA replies to a mention')
    }
    if (replyTo !== undefined && to !== undefined) {
      throw new HttpError(400, 'A reply goes back to the one who asked; leave out to')
    }
    const author = fromEa ? 'ea' : 'user'
    const post = async () =>
      replyTo === undefined ? postTeamMessage({ kind: author }, text, { to }) : replyToMention(replyTo, text)
    const key = sendKey('team_post', author, clientId)
    return ok(c, await sendOnce(key, post, { save: (posted) => posted, load: (posted) => posted }))
  })
  .post('/files', validJson(teamFileRequest), async (c) => {
    const { from, ...input } = c.req.valid('json')
    const sender = await requireTask(from)
    if (sender.archived_at !== null) {
      throw new HttpError(409, archivedRefusal(sender.title))
    }
    return ok(c, await sendFiles(sender, input, { actor: 'user' }))
  })
  .get('/members', async (c) => ok(c, await teamRoster()))
  .get('/members/:taskId', valid('param', taskParam), async (c) =>
    ok(c, await teamMemberOf(c.req.valid('param').taskId)),
  )
  .patch('/members/:taskId', valid('param', taskParam), validJson(teamMemberInput), async (c) =>
    ok(c, await updateMember(c.req.valid('param').taskId, c.req.valid('json'), 'user')),
  )
  .get('/stream', valid('query', z.object({ after: z.coerce.number().int().min(0).optional() })), (c) =>
    streamTeam(c, c.req.valid('query').after ?? lastEventId(c.req.header('Last-Event-ID'))),
  )
