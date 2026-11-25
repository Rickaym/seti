import { shellIndex } from '../background-shells.js'
import { openQuerySince } from '../runner.js'
import { isRunning, sessionState } from '../session-mirror.js'

const counted = (n: number, one: string, many: string) => (n === 0 ? [] : [`${String(n)} ${n === 1 ? one : many}`])

/**
 * Why the agent is at work, naming what: its turn, or the background work its session still runs
 * (commands it left running, and subagents or other tasks); null when it is not at work.
 */
export async function atWork(taskId: string): Promise<string | null> {
  if (isRunning(taskId)) {
    return 'The agent is in a turn; it dreams when the turn ends.'
  }
  const count = sessionState(taskId).background
  if (count === 0) {
    return null
  }
  const shells = (await shellIndex(taskId)).shells(openQuerySince(taskId))
  const commands = Math.min(count, shells.filter((shell) => shell.status === 'running').length)
  const parts = [
    ...counted(commands, 'background command', 'background commands'),
    ...counted(count - commands, 'subagent or other background task', 'subagents or other background tasks'),
  ]
  const [verb, them] = count === 1 ? ['runs', 'it ends'] : ['run', 'they end']
  return `The agent runs no turn, but ${parts.join(' and ')} still ${verb} in its session; it dreams when ${them}, or stop ${count === 1 ? 'it' : 'them'} in its Processes.`
}
