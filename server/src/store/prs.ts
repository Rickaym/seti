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
