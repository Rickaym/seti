import { now, sql } from '../db.js'

/** What ran in an agent when Seti stopped: a turn for a message, for updates, or a wake-up. */
export type CutKind = 'user' | 'updates' | 'wake'

/** A turn Seti's stop cut off, as it records it for the next start. */
export interface CutTurn {
  task_id: string
  kind: CutKind
  /** Background commands and subagents that ran in the session and stop with it. */
  background: number
}

export const restartCuts = {
  /** Leaves the agents seen, as those startup resumes by itself, which need nobody. */
  markResuming: async (ids: readonly string[]): Promise<void> => {
    await sql`UPDATE task SET unseen = false WHERE id = ANY(${[...ids]})`
  },
  /** The agents with a reason line, which startup works out again from what still waits. */
  blockedIds: async (): Promise<string[]> =>
    (await sql<{ id: string }[]>`SELECT id FROM task WHERE blocked IS NOT NULL`).map((row) => row.id),
  /** Records the turns a stop cuts off, replacing what an earlier stop recorded for them. */
  record: async (turns: readonly CutTurn[]): Promise<void> => {
    const at = now()
    for (const turn of turns) {
      await sql`INSERT INTO restart_cut (task_id, cut_kind, cut_background, cut_at)
        VALUES (${turn.task_id}, ${turn.kind}, ${turn.background}, ${at})
        ON CONFLICT (task_id) DO UPDATE SET cut_kind = excluded.cut_kind,
          cut_background = excluded.cut_background, cut_at = excluded.cut_at`
    }
  },
  /** What the last stop recorded, by task; a start that follows a crash finds nothing. */
  recorded: async (): Promise<Map<string, CutTurn>> => {
    const rows = await sql<CutTurn[]>`SELECT task_id, cut_kind AS kind, cut_background AS background
      FROM restart_cut WHERE cut_kind IS NOT NULL`
    return new Map(rows.map((row) => [row.task_id, { ...row }]))
  },
  /** What the last stop recorded for one agent, such as one whose answer comes after the start. */
  of: async (taskId: string): Promise<CutTurn | undefined> =>
    (
      await sql<CutTurn[]>`SELECT task_id, cut_kind AS kind, cut_background AS background
        FROM restart_cut WHERE task_id = ${taskId} AND cut_kind IS NOT NULL`
    ).at(0),
  /** Forgets the recorded turns, except those of agents that still wait on the user. */
  forget: async (keep: readonly string[]): Promise<void> => {
    await sql`UPDATE restart_cut SET cut_kind = NULL, cut_background = 0, cut_at = NULL
      WHERE cut_kind IS NOT NULL AND NOT (task_id = ANY(${[...keep]}))`
  },
  forgetOne: async (taskId: string): Promise<void> => {
    await sql`UPDATE restart_cut SET cut_kind = NULL, cut_background = 0, cut_at = NULL WHERE task_id = ${taskId}`
  },
  /** How often startup resumed the agent since `since` without it finishing a turn. */
  resumes: async (taskId: string, since: string): Promise<number> =>
    (
      await sql<{ resumes: number }[]>`SELECT resumes FROM restart_cut
        WHERE task_id = ${taskId} AND window_start >= ${since}`
    ).at(0)?.resumes ?? 0,
  /** Counts a resume; the count starts over when the last window began before `since`. */
  countResume: async (taskId: string, since: string): Promise<void> => {
    const at = now()
    await sql`INSERT INTO restart_cut (task_id, resumes, window_start) VALUES (${taskId}, 1, ${at})
      ON CONFLICT (task_id) DO UPDATE SET
        resumes = CASE WHEN restart_cut.window_start >= ${since} THEN restart_cut.resumes + 1 ELSE 1 END,
        window_start = CASE WHEN restart_cut.window_start >= ${since} THEN restart_cut.window_start ELSE ${at} END`
  },
  /** The agent finished a turn, so its resumes count from zero again. */
  progressed: async (taskId: string): Promise<void> => {
    await sql`UPDATE restart_cut SET resumes = 0, window_start = NULL WHERE task_id = ${taskId} AND resumes > 0`
  },
  /** Keeps why startup no longer resumes the agent, which its reason line shows. */
  hold: async (taskId: string, reason: string): Promise<void> => {
    await sql`INSERT INTO restart_cut (task_id, held) VALUES (${taskId}, ${reason})
      ON CONFLICT (task_id) DO UPDATE SET held = excluded.held, resumes = 0, window_start = NULL`
  },
  /** A turn started, so the agent is no longer held; true when it was. */
  release: async (taskId: string): Promise<boolean> =>
    (await sql`UPDATE restart_cut SET held = NULL WHERE task_id = ${taskId} AND held IS NOT NULL RETURNING task_id`)
      .length > 0,
  held: async (taskId: string): Promise<string | null> =>
    (await sql<{ held: string | null }[]>`SELECT held FROM restart_cut WHERE task_id = ${taskId}`).at(0)?.held ?? null,
}
