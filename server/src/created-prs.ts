import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { auditPrLink } from './audit.js'
import { tasks } from './db.js'
import { watchPrLinked } from './ea-watch.js'
import { createPrWatcher } from './pr-link.js'
import { prDismissals } from './store/pr-discovery.js'
import { linkSubagentPrs } from './subtask-prs.js'
import { publish } from './task-events.js'

const watchPrCreation = createPrWatcher()

/**
 * Links the PRs the agent opened to the task, and those a subagent of the session open since
 * prompt `since` opened to it as well.
 */
export async function linkCreatedPrs(taskId: string, m: SDKMessage, since: number | null): Promise<void> {
  const created = watchPrCreation(taskId, m)
  const dismissed = created.length === 0 ? new Set<string>() : await prDismissals.list(taskId)
  const kept = created.filter((pr) => !dismissed.has(pr.url))
  const linked: string[] = []
  for (const { url } of kept) {
    if (await tasks.linkPr(taskId, url, 'agent')) {
      linked.push(url)
    }
  }
  for (const url of linked) {
    await auditPrLink({ actor: 'agent', taskId, url, linked: true })
    await watchPrLinked(taskId, url)
  }
  const bySubagent = await linkSubagentPrs(taskId, kept, since)
  if (linked.length > 0 || bySubagent) {
    publish(taskId, { type: 'prs' })
  }
}
