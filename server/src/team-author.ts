import type { TeamMessage } from '@seti/shared'
import type { TeamAuthor } from './team-recipient.js'

/** How a message names its author: @handle, mod:<id>, user or ea. */
export const authorLabel = (message: Pick<TeamMessage, 'author_kind' | 'author_handle' | 'author_mod_id'>) => {
  if (message.author_kind === 'mod') {
    return `mod:${message.author_mod_id ?? 'unknown'}`
  }
  return message.author_kind === 'task' ? `@${message.author_handle ?? 'task'}` : message.author_kind
}

/** Agents and mods post on their own, so their messages are paced; the user and the EA are not. */
export const paced = (author: TeamAuthor) => author.kind === 'task' || author.kind === 'mod'

const SPEAKERS: Partial<Record<string, string>> = { user: 'The user', ea: 'The EA' }

/** Who an agent is told wrote a message; a mod's post says it is the mod's, never the user's. */
export function speakerOf(message: TeamMessage): string {
  if (message.author_kind === 'mod') {
    return `The ${message.author_mod_id ?? 'unknown'} mod (not the user)`
  }
  const from = authorLabel(message)
  return SPEAKERS[from] ?? from
}
