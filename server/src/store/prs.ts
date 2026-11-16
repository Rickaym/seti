import type { LinkedTask } from '@seti/shared'
import { sql } from '../db.js'

export async function tasksByPrUrl(): Promise<Map<string, LinkedTask[]>> {
  const rows = await sql<(LinkedTask & { pr_url: string })[]>`SELECT t.id, t.title, t.status, p.pr_url
    FROM task_pr p JOIN task t ON t.id = p.task_id
    ORDER BY t.updated_at DESC, t.id, p.linked_at, p.seq`
  const byUrl = new Map<string, LinkedTask[]>()
  for (const { pr_url, ...task } of rows) {
    byUrl.set(pr_url, [...(byUrl.get(pr_url) ?? []), task])
  }
  return byUrl
}

/** PRs linked to an active task, unless GitHub reported them merged or closed after the link. */
export async function linkedPrUrls(): Promise<string[]> {
  const rows = await sql<{ pr_url: string }[]>`SELECT DISTINCT p.pr_url FROM task_pr p JOIN task t ON t.id = p.task_id
    LEFT JOIN pr_watch w ON w.pr_url = p.pr_url
    WHERE t.archived_at IS NULL AND (w.pr_url IS NULL OR w.open = 1 OR p.linked_at > w.checked_at)
    ORDER BY p.pr_url`
  return rows.map((row) => row.pr_url)
}
