import { shellIndex } from '../background-shells.js'
import { openQuerySince } from '../runner.js'
import { isRunning, sessionState } from '../session-mirror.js'

/**
 * Why the agent's work rules out a dream now, or null when it may dream. A turn and background
 * subagents or other background tasks rule it out, since they are model work that can write
 * memory. Background commands and monitors do not: a dream only reads the folders they work in,
 * and the turn the runtime starts when one ends or reports cuts the dream. Background work the
 * runtime has not listed by kind counts as other work.
 */
export async function atWork(taskId: string): Promise<string | null> {
  if (isRunning(taskId)) {
    return 'The agent is in a turn; it dreams when the turn ends.'
  }
  const count = sessionState(taskId).background
  if (count === 0) {
    return null
  }
  const jobs = (await shellIndex(taskId)).liveJobs(openQuerySince(taskId)).filter((job) => job.ambient !== true)
  const commands = Math.min(count, jobs.filter((job) => job.kind === 'shell').length)
  const others = Math.max(count - commands, jobs.length - commands)
  if (others === 0) {
    return null
  }
  const [what, verb, them] =
    others === 1
      ? ['1 subagent or other background task', 'runs', 'it ends, or stop it']
      : [`${String(others)} subagents or other background tasks`, 'run', 'they end, or stop them']
  return `The agent runs no turn, but ${what} still ${verb} in its session; it dreams when ${them} in its Processes.`
}
