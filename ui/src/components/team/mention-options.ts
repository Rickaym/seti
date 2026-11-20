import type { TeamMember } from '@seti/shared'
import type { MentionOption } from '@/lib/mentions'

/** How many agents @active reaches now, such as `6 agents active today`. */
export function activeHint(members: readonly TeamMember[]): string {
  const count = members.filter((member) => member.active_today).length
  if (count === 0) {
    return 'No agents active today'
  }
  return `${String(count)} ${count === 1 ? 'agent' : 'agents'} active today`
}

/** The handles the composer suggests: the reserved ones, then every agent. */
export const mentionOptions = (members: readonly TeamMember[]): MentionOption[] => [
  { handle: 'all', detail: 'Every active agent, at its next step', quiet: false, pinned: true },
  { handle: 'active', detail: activeHint(members), quiet: false, pinned: true },
  { handle: 'ea', detail: 'The EA', quiet: false, pinned: true },
  ...members.map((member) => ({
    handle: member.handle,
    detail: `${member.title}${member.muted ? ' (muted)' : ''}`,
    quiet: member.muted || !member.active,
  })),
]
