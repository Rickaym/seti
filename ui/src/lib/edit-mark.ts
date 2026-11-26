import { slackSendKind } from '@seti/shared'
import { toolName } from '@/lib/tool-summary'

/** What the user did to a held call, as the transcript's edit mark stores it. */
export interface EditMark {
  fields: readonly string[]
  denied: boolean
  /** The call's tool; marks written before it was stored leave it out. */
  tool?: string
}

const SLACK_DONE = { send: 'sent', draft: 'saved as a draft', schedule: 'scheduled' } as const

/** `the message`, `the channel id and message`: field names as words. */
function fieldWords(fields: readonly string[]): string {
  const words = fields.map((field) => field.replaceAll('_', ' '))
  const last = words.at(-1) ?? 'text'
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${last}` : last
  return `the ${list}`
}

/** The call as a person names it: `github.create_issue`, or `the call` when Seti did not store it. */
function callWords(tool: string | undefined): string {
  if (tool === undefined) {
    return 'the call'
  }
  const { server, name } = toolName(tool)
  return server === null ? name : `${server}.${name}`
}

/** One sentence that says what the user edited and whether the call then went out, for any screen. */
export function editMarkText({ fields, denied, tool }: EditMark): string {
  const what = fieldWords(fields)
  const slack = tool === undefined ? null : slackSendKind(tool)
  if (slack !== null) {
    return denied
      ? `You edited ${what}, then denied it. Nothing was ${SLACK_DONE[slack]}.`
      : `You edited ${what} before it was ${SLACK_DONE[slack]}. Above is the agent's draft.`
  }
  const call = callWords(tool)
  return denied
    ? `You edited ${what}, then denied ${call}. Nothing ran.`
    : `You edited ${what} before ${call} ran. Above is the agent's draft.`
}
