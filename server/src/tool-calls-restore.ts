import { projectClaude } from '@seti/shared'
import { messages } from './db.js'
import { trackToolCalls } from './tool-calls.js'

const PAGE = 500

/**
 * Follows the stored rows of an open session again, from its first prompt, so a control plane
 * that restarted while the node ran the session shows the tool calls still open in it.
 */
export async function restoreToolCalls(taskId: string, since: number): Promise<void> {
  let after = since - 1
  for (;;) {
    const rows = await messages.firstAfter(taskId, after, PAGE)
    for (const row of rows) {
      if (row.kind === 'sdk') {
        trackToolCalls(taskId, projectClaude(row.payload), Date.parse(row.created_at))
      }
    }
    const last = rows.at(-1)
    if (last === undefined || rows.length < PAGE) {
      return
    }
    after = last.id
  }
}
