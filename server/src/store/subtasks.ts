import type { MessagePage } from '@seti/shared'
import { now, sql, toMessage, type MessageRecord } from '../db.js'

/** Who linked a PR to a subagent: the subagent by opening it, or the user. */
type SubtaskPrSource = 'agent' | 'user'

export const subtaskMessages = {
  /**
   * The `limit` messages of the given subagent calls just before `before`, or the newest ones, with
   * the updates Seti routed to their parent agent on their behalf.
   */
  page: async (
    taskId: string,
    parents: readonly string[],
    limit: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<MessagePage> => {
    const ids = [...parents]
    const newest = (
      await sql<MessageRecord[]>`
        SELECT * FROM task_message
        WHERE task_id = ${taskId} AND kind = 'sdk' AND (payload::json ->> 'parent_tool_use_id') = ANY(${ids})
          AND id < ${before}
        UNION ALL
        SELECT * FROM task_message
        WHERE task_id = ${taskId} AND kind = 'input' AND (payload::json -> 'subtask' ->> 'tool_use_id') = ANY(${ids})
          AND id < ${before}
        ORDER BY id DESC LIMIT ${limit + 1}`
    ).map(toMessage)
    return { messages: newest.slice(0, limit).reverse(), has_older: newest.length > limit }
  },
}

export const subtaskPrs = {
  /** Links a PR of the task to one subagent, taking it from any other; true when that changed. */
  link: async (taskId: string, url: string, toolUseId: string, source: SubtaskPrSource) =>
    (
      await sql`INSERT INTO subtask_pr (task_id, pr_url, tool_use_id, linked_at, source)
        VALUES (${taskId}, ${url}, ${toolUseId}, ${now()}, ${source})
        ON CONFLICT (task_id, pr_url) DO UPDATE SET tool_use_id = excluded.tool_use_id,
          linked_at = excluded.linked_at, source = excluded.source
        WHERE subtask_pr.tool_use_id <> excluded.tool_use_id`
    ).count > 0,
  /** True when the PR was linked to that subagent. */
  unlink: async (taskId: string, url: string, toolUseId: string) =>
    (await sql`DELETE FROM subtask_pr WHERE task_id = ${taskId} AND pr_url = ${url} AND tool_use_id = ${toolUseId}`)
      .count > 0,
  /** PR URLs by the Agent call of the subagent they are linked to, oldest link first. */
  ofTask: async (taskId: string): Promise<Map<string, string[]>> => {
    const rows = await sql<{ tool_use_id: string; pr_url: string }[]>`SELECT tool_use_id, pr_url FROM subtask_pr
      WHERE task_id = ${taskId} ORDER BY linked_at, pr_url`
    const byCall = new Map<string, string[]>()
    for (const row of rows) {
      byCall.set(row.tool_use_id, [...(byCall.get(row.tool_use_id) ?? []), row.pr_url])
    }
    return byCall
  },
}
