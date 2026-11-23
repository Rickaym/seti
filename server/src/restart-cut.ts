import { audit } from './audit.js'
import { controlLink } from './node-link.js'
import { stopForRestart } from './restart-state.js'
import { restartCuts, type CutTurn } from './store/restart.js'

/** How long cut turns get to end and be recorded: Claude Code's interrupt, then its close. */
const CUT_GRACE_MS = 7000

/**
 * Records the turns running as Seti stops and ends them: each is interrupted, so Claude Code
 * writes its session file before its process closes. Their tasks stay running in the database,
 * and what they wait on stays open, for the next start to resume. Returns what it recorded.
 */
export async function cutRunningTurns(graceMs = CUT_GRACE_MS): Promise<CutTurn[]> {
  stopForRestart()
  const { sessions } = await controlLink.command('sessions.view', {})
  const cut = sessions.filter((session) => session.running && session.open)
  if (cut.length === 0) {
    return []
  }
  const turns = cut.map((session) => ({ task_id: session.agent, kind: session.kind, background: session.background }))
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
  await controlLink.command('sessions.cut', { agents: turns.map((turn) => turn.task_id), graceMs })
  return turns
}
