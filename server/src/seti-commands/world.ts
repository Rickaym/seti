import { sourcesOf, type CommandAuthor, type CommandSource, type CommandWorld, type Task } from '@seti/shared'
import { effectiveAccess } from '../agent-access.js'
import { hostMaxPercent, taskCpuCap } from '../cpu-cap.js'
import { profileSummaries } from '../credential-profiles.js'
import { taskMemoryCap } from '../memory-cap.js'
import { agentCapabilities } from '../runtimes/capabilities.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { listWorkspaces } from '../task-actions.js'

const when = async <T>(sources: readonly CommandSource[], source: CommandSource, load: () => Promise<T>) =>
  sources.includes(source) ? load() : null

/** The agent's state a Seti command line is checked against, with only the sources it reads. */
export async function commandWorld(task: Task, author: CommandAuthor, line: string): Promise<CommandWorld> {
  const sources = sourcesOf(line)
  const [policy, access, credentials, workspaces, memory, cpu] = await Promise.all([
    sandboxPolicy.get(),
    when(sources, 'access', async () => effectiveAccess(task)),
    when(sources, 'credentials', profileSummaries),
    when(sources, 'workspaces', listWorkspaces),
    when(sources, 'memory', async () => taskMemoryCap(task.id)),
    when(sources, 'cpu', async () => ({ cap: await taskCpuCap(task.id), max_percent: hostMaxPercent() })),
  ])
  return {
    author,
    task,
    caps: agentCapabilities(task.runtime),
    sandboxOn: policy.enabled,
    access,
    credentials,
    workspaces,
    memory,
    cpu,
  }
}
