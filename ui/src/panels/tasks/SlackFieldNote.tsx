import { idsIn, slackFieldNote, slackMentions } from '@seti/shared'
import { useSlackLookup } from '@/lib/slack-names'
import { cn } from '@/lib/utils'

const TONE = {
  name: 'text-foreground',
  unknown: 'text-muted-foreground',
  invalid: 'text-warning-text',
} as const

const MESSAGE_FIELDS = new Set(['message', 'text'])

/**
 * Under a Slack call's field, what its id names, such as `#deploys` or `DM to Dana`, or who its
 * message mentions; nothing for other fields. The line keeps its place while the name loads.
 */
export function SlackFieldNote({ tool, field, value }: { tool: string; field: string; value: string }) {
  const message = /slack/i.test(tool) && MESSAGE_FIELDS.has(field)
  const ids = message ? idsIn(value) : [value.trim()]
  const { names, asking } = useSlackLookup(ids)
  if (message) {
    return ids.length === 0 ? null : (
      <p className="min-h-4 text-2xs text-muted-foreground" data-testid="slack-field-note">
        Mentions {slackMentions(value, names).join(', ')}
      </p>
    )
  }
  const note = slackFieldNote(tool, field, value, names)
  if (note === null) {
    return null
  }
  return (
    <p className={cn('min-h-4 text-2xs', TONE[note.tone])} aria-live="polite" data-testid="slack-field-note">
      {asking && note.tone === 'unknown' ? '' : note.text}
    </p>
  )
}
