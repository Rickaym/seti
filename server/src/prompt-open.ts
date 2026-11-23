import type { MessageBody, MessageRow, NodeAnswer, NodeAsk } from '@seti/shared'
import { askBeingAnswered } from './node-link.js'
import type { Alongside } from './pg.js'
import { nodePrompts } from './store/node-prompts.js'
import { promptFor } from './turn-prompt.js'

type Append = (taskId: string, body: MessageBody, outward: string[], alongside?: Alongside) => Promise<MessageRow>

/**
 * Records the prompt row of a message going out. A node's ask records it with the ask's id in
 * the same transaction, so the same ask sent again after a control-plane restart gets that row
 * and text back instead of a second row.
 */
export async function openPrompt(
  taskId: string,
  { next, queued }: NodeAsk<'prompt.open'>,
  append: Append,
): Promise<NodeAnswer<'prompt.open'>> {
  const askId = askBeingAnswered()
  const opened = askId === null ? undefined : await nodePrompts.find(askId)
  if (opened !== undefined) {
    return opened
  }
  const { payload, text } = await promptFor(taskId, next, queued)
  const keep: Alongside | undefined =
    askId === null ? undefined : async (db, promptId) => nodePrompts.keep(db, askId, taskId, { promptId, text })
  return { promptId: (await append(taskId, { kind: 'prompt', payload }, [], keep)).id, text }
}
