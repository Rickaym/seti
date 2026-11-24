import { slackDestination, slackSendTarget } from '@seti/shared'
import { slackNames } from '../store/slack-names.js'

function messageOf(input: Record<string, unknown>): string {
  const text = input.message ?? input.text
  return typeof text === 'string' ? text : ''
}

/** A Slack send as a request reads it, `Send to #deploys: text`; null for any other call. */
export async function slackSendSummary(tool: string, input: Record<string, unknown>): Promise<string | null> {
  const target = slackSendTarget(tool, input)
  if (target === null) {
    return null
  }
  const where = slackDestination(tool, input, await slackNames.of([target]))
  return `${where ?? target}: ${messageOf(input)}`
}
