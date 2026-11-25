import type { AgentOpinions } from '@seti/shared'
import { apiGet } from '@/api'

const FRESH_MS = 30_000

const read = new Map<string, { at: number; opinions: Promise<AgentOpinions> }>()

/** An agent's second opinions by runtime and its PRs' latest reviews, read at most every 30 s. */
export async function agentOpinions(agentId: string): Promise<AgentOpinions> {
  const hit = read.get(agentId)
  if (hit !== undefined && Date.now() - hit.at < FRESH_MS) {
    return hit.opinions
  }
  const opinions = apiGet<AgentOpinions>(`/tasks/${agentId}/second-opinions`)
  read.set(agentId, { at: Date.now(), opinions })
  opinions.catch(() => read.delete(agentId))
  return opinions
}

/** A model's answer as it wrote it: Seti escaped any tag it opened, which reads as text here. */
export const shownAnswer = (answer: string) => answer.replaceAll('&lt;', '<')
