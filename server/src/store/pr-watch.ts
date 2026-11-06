import type { LinkedPrState } from '@seti/shared'
import { now, sql } from '../db.js'
import type { PrSnapshot } from '../pr-events.js'

/** A task a PR's updates go to, and the Agent call of the subagent the PR is linked to, if any. */
export interface PrListener {
  task_id: string
  tool_use_id: string | null
}

/** A task's link to a PR that GitHub last reported merged or closed. */
export interface EndedLink {
  task_id: string
  pr_url: string
  state: Exclude<LinkedPrState, 'open'>
  /** The subagent the PR was linked to as well, if any. */
  tool_use_id: string | null
}

/** A stored transcript row, its payload still JSON text. */
export interface StoredCall {
  payload: string
  created_at: string
}

/** Each task's linked and dismissed PRs; a PR both linked and dismissed counts as linked. */
const TASK_PRS = sql`SELECT task_id, pr_url, 0 AS dismissed FROM task_pr
  UNION ALL SELECT task_id, pr_url, 1 AS dismissed FROM task_pr_dismissed d
    WHERE NOT EXISTS (SELECT 1 FROM task_pr l WHERE l.task_id = d.task_id AND l.pr_url = d.pr_url)`

export const prWatch = {
  /**
   * PRs linked to at least one active task that takes updates or that the EA watches, unless GitHub
   * reported them merged or closed after they were linked.
   */
  watched: async () =>
    (
      await sql<{ pr_url: string }[]>`SELECT DISTINCT p.pr_url FROM task_pr p JOIN task t ON t.id = p.task_id
        LEFT JOIN pr_watch w ON w.pr_url = p.pr_url
        WHERE t.archived_at IS NULL
          AND (t.input_mode <> 'off' OR EXISTS (SELECT 1 FROM ea_watch e WHERE e.task_id = t.id))
          AND (w.pr_url IS NULL OR w.open = 1 OR p.linked_at > w.checked_at)
        ORDER BY p.pr_url`
    ).map((row) => row.pr_url),
  /** Links to PRs GitHub reported merged or closed after they were linked, which Seti drops. */
  endedLinks: async (): Promise<EndedLink[]> => [
    ...(await sql<EndedLink[]>`SELECT p.task_id, p.pr_url, (w.snapshot::json ->> 'state') AS state, s.tool_use_id
      FROM task_pr p JOIN pr_watch w ON w.pr_url = p.pr_url
      LEFT JOIN subtask_pr s ON s.task_id = p.task_id AND s.pr_url = p.pr_url
      WHERE w.open = 0 AND p.linked_at <= w.checked_at AND (w.snapshot::json ->> 'state') IN ('merged', 'closed')
      ORDER BY p.task_id, p.linked_at, p.seq`),
  ],
  /** Tool calls and results of the tasks linked to the PR, stored between `from` and `to`. */
  calls: async (url: string, from: string, to: string): Promise<StoredCall[]> => [
    ...(await sql<StoredCall[]>`SELECT m.payload, m.created_at FROM task_message m
      WHERE m.task_id IN (SELECT task_id FROM task_pr WHERE pr_url = ${url}) AND m.kind = 'sdk'
        AND m.created_at >= ${from} AND m.created_at <= ${to}
        AND (strpos(m.payload, '"tool_use"') > 0 OR strpos(m.payload, '"tool_result"') > 0)
      ORDER BY m.id`),
  ],
  /** Tasks the EA watches that link this PR. */
  eaWatchers: async (url: string) =>
    (
      await sql<{ task_id: string }[]>`SELECT p.task_id FROM task_pr p JOIN ea_watch e ON e.task_id = p.task_id
        JOIN task t ON t.id = p.task_id
        WHERE p.pr_url = ${url} AND t.archived_at IS NULL ORDER BY p.linked_at, p.seq`
    ).map((row) => row.task_id),
  /** Tasks that take updates from this PR, oldest link first, with the subagent it is linked to. */
  listeners: async (url: string): Promise<PrListener[]> => [
    ...(await sql<PrListener[]>`SELECT p.task_id, s.tool_use_id FROM task_pr p JOIN task t ON t.id = p.task_id
        LEFT JOIN subtask_pr s ON s.task_id = p.task_id AND s.pr_url = p.pr_url
        WHERE p.pr_url = ${url} AND t.input_mode <> 'off' AND t.archived_at IS NULL
        ORDER BY p.linked_at, p.seq`),
  ],
  /**
   * Last polled state of the task's linked PRs by URL, and of the PRs unlinked from it once they
   * merged or closed; PRs never polled are left out.
   */
  taskStates: async (taskId: string): Promise<Record<string, LinkedPrState>> =>
    Object.fromEntries(
      (
        await sql<{ pr_url: string; state: LinkedPrState }[]>`SELECT p.pr_url, (w.snapshot::json ->> 'state') AS state
          FROM (${TASK_PRS}) p JOIN pr_watch w ON w.pr_url = p.pr_url
          WHERE p.task_id = ${taskId} AND (p.dismissed = 0 OR w.open = 0) ORDER BY p.pr_url`
      ).map((row) => [row.pr_url, row.state]),
    ),
  /** The states `taskStates` gives, for every task, by task id. */
  allTaskStates: async (): Promise<Map<string, Record<string, LinkedPrState>>> => {
    const rows = await sql<{ task_id: string; pr_url: string; state: LinkedPrState }[]>`SELECT p.task_id, p.pr_url,
        (w.snapshot::json ->> 'state') AS state
      FROM (${TASK_PRS}) p JOIN pr_watch w ON w.pr_url = p.pr_url
      WHERE p.dismissed = 0 OR w.open = 0 ORDER BY p.task_id, p.pr_url`
    const byTask = new Map<string, Record<string, LinkedPrState>>()
    for (const row of rows) {
      const states = byTask.get(row.task_id) ?? {}
      states[row.pr_url] = row.state
      byTask.set(row.task_id, states)
    }
    return byTask
  },
  snapshot: async (url: string): Promise<PrSnapshot | undefined> => {
    const [row] = await sql<{ snapshot: string }[]>`SELECT snapshot FROM pr_watch WHERE pr_url = ${url}`
    return row && (JSON.parse(row.snapshot) as PrSnapshot)
  },
  save: async (url: string, snapshot: PrSnapshot) => {
    await sql`INSERT INTO pr_watch (pr_url, snapshot, open, checked_at)
      VALUES (${url}, ${JSON.stringify(snapshot)}, ${snapshot.state === 'open' ? 1 : 0}, ${now()})
      ON CONFLICT (pr_url) DO UPDATE SET snapshot = excluded.snapshot, open = excluded.open,
        checked_at = excluded.checked_at`
  },
}
