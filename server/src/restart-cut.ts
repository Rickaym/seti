import { audit } from './audit.js'
import { stopForRestart } from './restart-state.js'
import { liveSessions } from './runner.js'
import { restartCuts, type CutTurn } from './store/restart.js'

/** How long cut turns get to end and be recorded: Claude Code's interrupt, then its close. */
const CUT_GRACE_MS = 7000

const within = async (work: Promise<unknown>, ms: number) =>
  Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms).unref())])

/**
 * Records the turns running as Seti stops and ends them: each is interrupted, so Claude Code
 * writes its session file before its process closes. Their tasks stay running in the database,
 * and what they wait on stays open, for the next start to resume. Returns what it recorded.
 */
export async function cutRunningTurns(graceMs = CUT_GRACE_MS): Promise<CutTurn[]> {
  stopForRestart()
  const cut = liveSessions().filter(([, session]) => session.running && !session.closed)
  if (cut.length === 0) {
    return []
  }
  const turns = cut.map(([taskId, session]) => ({
    task_id: taskId,
    kind: session.turnKind,
    background: session.backgroundCount,
  }))
  await restartCuts.record(turns)
  await audit.record({
    actor: 'system',
    kind: 'system.stopping',
    subject_type: 'system',
    summary: `Seti is stopping and cut ${String(turns.length)} running ${turns.length === 1 ? 'turn' : 'turns'}`,
    detail: {
      turns: turns.length,
      tasks: turns.map((turn) => turn.task_id),
      kinds: turns.map((turn) => turn.kind),
      background: turns.reduce((sum, turn) => sum + turn.background, 0),
    },
  })
  for (const [, session] of cut) {
    session.cutForRestart()
  }
  await within(Promise.allSettled(cut.map(async ([, session]) => session.done)), graceMs)
  return turns
}
