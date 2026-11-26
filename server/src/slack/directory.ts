import { idsIn, slackSendTarget, type PermissionRequest } from '@seti/shared'
import { announce, waitingInput } from '../permission-requests.js'
import { summarize } from '../request-text.js'
import { permissionRequests } from '../store/permissions.js'
import { slackNames, type SlackName } from '../store/slack-names.js'
import { publishToOpenStreams } from '../task-events.js'
import { messageOf } from './destination.js'

/** The names a batch states once each; an id the batch names two ways is left out. */
function agreed(names: readonly SlackName[]): SlackName[] {
  const byId = new Map<string, SlackName | null>()
  for (const entry of names) {
    const seen = byId.get(entry.id)
    byId.set(entry.id, seen === undefined || seen?.name === entry.name ? entry : null)
  }
  return [...byId.values()].filter((entry): entry is SlackName => entry !== null)
}

/** The full input of a waiting call, else the input the request stored when it still parses. */
function inputOf(request: PermissionRequest): Record<string, unknown> {
  const waiting = waitingInput(request.id)
  if (Object.keys(waiting).length > 0) {
    return waiting
  }
  try {
    const stored: unknown = JSON.parse(request.input)
    return typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Rewrites the summary of each pending Slack send to or mentioning these ids; tells its views. */
async function renamePendingSends(ids: ReadonlySet<string>): Promise<void> {
  for (const request of await permissionRequests.allPending()) {
    const input = inputOf(request)
    const target = slackSendTarget(request.tool_name, input)
    if (target === null || ![target, ...idsIn(messageOf(input))].some((id) => ids.has(id))) {
      continue
    }
    const renamed = await permissionRequests.resummarize(request.id, await summarize(request.tool_name, input))
    if (renamed !== undefined) {
      await announce(renamed)
    }
  }
}

/**
 * Stores the Slack names Seti saw, then shows the new or changed ones at once: in the summary of
 * each pending send to them, and in every open transcript.
 */
export async function rememberSlackNames(names: readonly SlackName[], source: string, at: string): Promise<void> {
  const fresh = await slackNames.learn(agreed(names), source, at)
  if (fresh.length === 0) {
    return
  }
  await renamePendingSends(new Set(fresh.map((entry) => entry.id)))
  publishToOpenStreams({ type: 'slack-names', names: Object.fromEntries(fresh.map((entry) => [entry.id, entry.name])) })
}
