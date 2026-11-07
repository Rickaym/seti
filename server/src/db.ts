import {
  DEFAULT_PROFILE_ID,
  DEFAULT_SETI_CONTROL,
  type AgentColor,
  type InputMode,
  type MessageBody,
  type MessagePage,
  type MessageRow,
  type PromptAttachment,
  type QueueState,
  type Repo,
  type RepoInput,
  type SetiControlLevel,
  type Task,
  type TaskRepo,
  type TaskSetup,
  type TaskStatus,
} from '@seti/shared'
import { DATABASE_URL } from './config.js'
import { pickAgentColor } from './new-agent-color.js'
import { connect, ensureDatabase, migrate, type Db } from './pg.js'
import { scrubValue } from './scrub.js'
import { readBody, readOutward, readPayload, readStoredBody, storedJson } from './stored-rows.js'

export type { Db, Pool } from './pg.js'

/** The shared pool; connections open on first use. */
export const sql = connect(DATABASE_URL)

/** Creates the database if needed and brings its schema up to date; the server calls it first. */
export async function openDatabase(): Promise<void> {
  await ensureDatabase(DATABASE_URL)
  await migrate(sql)
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 })
}

/** Runs `fn` in one transaction on one connection; a throw rolls every write back. */
export async function transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return sql.begin(fn)
}

export const now = () => new Date().toISOString()

type TaskRecord = Omit<Task, 'worktree' | 'sandbox' | 'repos' | 'setup' | 'seti_control'> & {
  sandbox: number
  seti_level: SetiControlLevel
  /** The switch from before levels, cleared by the migration and kept only for a rollback. */
  seti_control: boolean
  setup: string | null
  extra_repos: TaskRepo[]
  cwd_worktree: boolean
}

/** Who linked a PR to a task: the user, the agent, a session import, or transcript discovery. */
type TaskPrSource = 'user' | 'agent' | 'import' | 'discovered'

type NewTask = Pick<Task, 'id' | 'title' | 'repo_id' | 'cwd' | 'worktree' | 'pr_urls'> &
  Partial<Pick<Task, 'sandbox' | 'profile_id' | 'setup' | 'seti_control' | 'workspace_id'>>
type ImportedTask = NewTask & Pick<Task, 'session_id' | 'source_session_id'>

/** A repo the agent can edit besides the one it runs in. */
interface ExtraRepo {
  repo_id: string
  dir: string
}

/** A message written with its original time, as when importing an existing session. */
export interface BackfillMessage {
  body: MessageBody
  at: string | null
}

/** A transcript row as stored; its kind and payload are read with `toMessage`. */
export interface MessageRecord {
  id: number
  task_id: string
  kind: string
  payload: string
  outward: string
  created_at: string
}

const TASK_SELECT = sql`SELECT t.*, r.slug AS repo_slug,
  ARRAY(SELECT p.pr_url FROM task_pr p WHERE p.task_id = t.id ORDER BY p.linked_at, p.seq) AS pr_urls,
  COALESCE((SELECT json_agg(json_build_object('id', tr.repo_id, 'slug', x.slug, 'dir', tr.dir, 'worktree',
      EXISTS (SELECT 1 FROM task_worktree w WHERE w.task_id = t.id AND w.dir = tr.dir)) ORDER BY tr.position)
    FROM task_repo tr JOIN repo x ON x.id = tr.repo_id WHERE tr.task_id = t.id), '[]'::json) AS extra_repos,
  EXISTS (SELECT 1 FROM task_worktree w WHERE w.task_id = t.id AND w.dir = t.cwd) AS cwd_worktree,
  COALESCE((SELECT json_agg(w.warm_cache::json ORDER BY w.dir) FROM task_worktree w
    WHERE w.task_id = t.id AND w.warm_cache IS NOT NULL), '[]'::json) AS warm_caches,
  ARRAY(SELECT d.dir FROM task_dir d WHERE d.task_id = t.id ORDER BY d.seq) AS dirs
  FROM task t LEFT JOIN repo r ON r.id = t.repo_id`

export const toMessage = (r: MessageRecord): MessageRow => ({
  id: r.id,
  task_id: r.task_id,
  created_at: r.created_at,
  ...readStoredBody(r, r.kind, r.payload),
  outward: readOutward(r.outward),
})

/** The primary repo lives on the task row; extra repos live in task_repo. */
function toTask({ extra_repos, cwd_worktree, setup, seti_level, seti_control: _rollback, ...r }: TaskRecord): Task {
  const primary =
    r.repo_id !== null && r.repo_slug !== null
      ? [{ id: r.repo_id, slug: r.repo_slug, dir: r.cwd, worktree: cwd_worktree }]
      : []
  const repos = [...primary, ...extra_repos]
  return {
    ...r,
    worktree: repos.some((repo) => repo.worktree),
    sandbox: r.sandbox === 1,
    seti_control: seti_level,
    repos,
    setup: setup === null ? null : (JSON.parse(setup) as TaskSetup),
    unseen: r.unseen && r.status !== 'running',
    asking: r.asking && r.status === 'idle',
    closing_line: r.status === 'running' ? null : r.closing_line,
  }
}

async function linkPr(db: Db, taskId: string, url: string, source: TaskPrSource): Promise<boolean> {
  const result = await db`INSERT INTO task_pr (task_id, pr_url, linked_at, source)
    VALUES (${taskId}, ${url}, ${now()}, ${source}) ON CONFLICT DO NOTHING`
  return result.count > 0
}

/** Inserts a task in a preset colour the live agents use least, with its repos and PRs. */
async function insertTask(db: Db, task: ImportedTask, extras: readonly ExtraRepo[], source: TaskPrSource) {
  const ts = now()
  const setup = task.setup === undefined || task.setup === null ? null : JSON.stringify(task.setup)
  const live = await db<{ color: AgentColor }[]>`SELECT color FROM task
    WHERE archived_at IS NULL AND color IS NOT NULL`
  const color = pickAgentColor(live.map((row) => row.color))
  await db`INSERT INTO task (id, title, repo_id, cwd, worktree, sandbox, profile_id, session_id,
      source_session_id, status, created_at, updated_at, setup, seti_level, workspace_id, color)
    VALUES (${task.id}, ${task.title}, ${task.repo_id}, ${task.cwd}, ${task.worktree ? 1 : 0},
      ${task.sandbox === false ? 0 : 1}, ${task.profile_id ?? DEFAULT_PROFILE_ID}, ${task.session_id},
      ${task.source_session_id}, 'idle', ${ts}, ${ts}, ${setup}, ${task.seti_control ?? DEFAULT_SETI_CONTROL},
      COALESCE(${task.workspace_id ?? null}, default_workspace_id()), ${color})`
  for (const [index, extra] of extras.entries()) {
    await db`INSERT INTO task_repo (task_id, repo_id, position, dir)
      VALUES (${task.id}, ${extra.repo_id}, ${index + 1}, ${extra.dir})`
  }
  const placed = task.repo_id === null ? extras : [{ repo_id: task.repo_id, dir: task.cwd }, ...extras]
  for (const worktree of task.worktree ? placed : []) {
    await db`INSERT INTO task_worktree (task_id, repo_id, dir) VALUES (${task.id}, ${worktree.repo_id}, ${worktree.dir})`
  }
  for (const url of task.pr_urls) {
    await linkPr(db, task.id, url, source)
  }
}

export const repos = {
  list: async () => [...(await sql<Repo[]>`SELECT * FROM repo ORDER BY slug`)],
  get: async (id: string) => (await sql<Repo[]>`SELECT * FROM repo WHERE id = ${id}`).at(0),
  insert: async (repo: Repo) => {
    await sql`INSERT INTO repo (id, slug, path, base_branch, created_at)
      VALUES (${repo.id}, ${repo.slug}, ${repo.path}, ${repo.base_branch}, ${repo.created_at})`
  },
  update: async (id: string, input: RepoInput) => {
    const result = await sql`UPDATE repo SET slug = ${input.slug}, path = ${input.path},
      base_branch = ${input.base_branch} WHERE id = ${id}`
    return result.count > 0
  },
  remove: async (id: string) => {
    await sql`DELETE FROM repo WHERE id = ${id}`
  },
}

interface DroppedPrompt {
  id: number
  text: string
  attachments: PromptAttachment[]
  /** Who wrote it when not the user, so a resend keeps saying so. */
  from: string | undefined
}

interface PromptRecord {
  id: number
  payload: string
}

function sentPrompt(taskId: string, row: PromptRecord): DroppedPrompt | null {
  const prompt = readPayload({ task_id: taskId, id: row.id }, 'prompt', row.payload)
  return prompt && { id: row.id, text: prompt.text, attachments: prompt.attachments ?? [], from: prompt.from }
}

interface NewMessage {
  taskId: string
  body: MessageBody
  outward: string[]
  createdAt: string
}

/** Stores a message with its credentials redacted, so the database never holds them. */
async function insertMessage(db: Db, { taskId, body, outward, createdAt }: NewMessage) {
  const payload = storedJson(scrubValue(body.payload))
  const [row] = await db<{ id: number }[]>`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    VALUES (${taskId}, ${body.kind}, ${payload}, ${JSON.stringify(outward)}, ${createdAt}) RETURNING id`
  if (row === undefined) {
    throw new Error('Message was not recorded')
  }
  return row.id
}

export const tasks = {
  /** Tasks that are not archived, the ones that take work; most recently updated first. */
  list: async () =>
    (
      await sql<TaskRecord[]>`${TASK_SELECT} WHERE t.archived_at IS NULL
        ORDER BY t.pinned DESC, t.updated_at DESC, t.id`
    ).map(toTask),
  /** Archived tasks, most recently archived first. */
  listArchived: async () =>
    (await sql<TaskRecord[]>`${TASK_SELECT} WHERE t.archived_at IS NOT NULL ORDER BY t.archived_at DESC, t.id`).map(
      toTask,
    ),
  listAll: async () => (await sql<TaskRecord[]>`${TASK_SELECT} ORDER BY t.updated_at DESC, t.id`).map(toTask),
  get: async (id: string) => {
    const [record] = await sql<TaskRecord[]>`${TASK_SELECT} WHERE t.id = ${id}`
    return record && toTask(record)
  },
  status: async (id: string): Promise<TaskStatus | undefined> =>
    (await sql<{ status: TaskStatus }[]>`SELECT status FROM task WHERE id = ${id}`).at(0)?.status,
  insert: async (task: NewTask, extras: readonly ExtraRepo[] = []) => {
    await transaction(async (tx) => {
      await insertTask(tx, { ...task, session_id: null, source_session_id: null }, extras, 'user')
    })
  },
  /** Inserts an idle task that resumes an existing session, with its earlier transcript. */
  insertImported: async (task: ImportedTask, history: readonly BackfillMessage[]) => {
    await transaction(async (tx) => {
      await insertTask(tx, task, [], 'import')
      const fallback = now()
      for (const row of history) {
        await insertMessage(tx, { taskId: task.id, body: row.body, outward: [], createdAt: row.at ?? fallback })
      }
    })
  },
  setTitle: async (id: string, title: string) => {
    await sql`UPDATE task SET title = ${title} WHERE id = ${id}`
  },
  setPinned: async (id: string, pinned: boolean) => {
    await sql`UPDATE task SET pinned = ${pinned} WHERE id = ${id}`
  },
  setColor: async (id: string, color: AgentColor | null) => {
    await sql`UPDATE task SET color = ${color} WHERE id = ${id}`
  },
  setSandbox: async (id: string, sandbox: boolean) => {
    await sql`UPDATE task SET sandbox = ${sandbox ? 1 : 0} WHERE id = ${id}`
  },
  setSetiControl: async (id: string, level: SetiControlLevel) => {
    await sql`UPDATE task SET seti_level = ${level} WHERE id = ${id}`
  },
  setNotificationsMuted: async (id: string, muted: boolean) => {
    await sql`UPDATE task SET notifications_muted = ${muted} WHERE id = ${id}`
  },
  setProfile: async (id: string, profileId: string) => {
    await sql`UPDATE task SET profile_id = ${profileId} WHERE id = ${id}`
  },
  setWorkspace: async (id: string, workspaceId: string) => {
    await sql`UPDATE task SET workspace_id = ${workspaceId} WHERE id = ${id}`
  },
  setInputMode: async (id: string, mode: InputMode) => {
    await sql`UPDATE task SET input_mode = ${mode} WHERE id = ${id}`
  },
  /** True when the PR was not linked to the task before. */
  linkPr: async (taskId: string, url: string, source: TaskPrSource) => linkPr(sql, taskId, url, source),
  /** True when the PR was linked to the task. */
  unlinkPr: async (id: string, url: string) =>
    (await sql`DELETE FROM task_pr WHERE task_id = ${id} AND pr_url = ${url}`).count > 0,
  /** A turn starting clears a status line from an ended turn; one set since then stays. */
  setStatus: async (id: string, status: TaskStatus, lastError: string | null) => {
    const ended = sql`${status === 'running'} AND status <> 'running' AND status_line_at <= updated_at`
    await sql`UPDATE task SET status = ${status}, last_error = ${lastError}, asking = false,
      updated_at = ${now()},
      status_line = CASE WHEN ${ended} THEN NULL ELSE status_line END,
      status_line_at = CASE WHEN ${ended} THEN NULL ELSE status_line_at END
      WHERE id = ${id}`
  },
  /** Shows a short live status on the agent's row; null clears it. Its order in the list stays. */
  setStatusLine: async (id: string, text: string | null) => {
    await sql`UPDATE task SET status_line = ${text}, status_line_at = ${text === null ? null : now()} WHERE id = ${id}`
  },
  /** Clears the agent's status line; `idle` only while no turn runs. */
  clearStatusLine: async (id: string, { idle = false } = {}) => {
    await sql`UPDATE task SET status_line = NULL, status_line_at = NULL
      WHERE id = ${id} AND status_line IS NOT NULL AND (${!idle} OR status <> 'running')`
  },
  /** Records how the task stopped working; the user has not seen how its turn ended yet. */
  endTurn: async (id: string, end: Pick<Task, 'status' | 'last_error' | 'asking' | 'closing_line'>) => {
    await sql`UPDATE task SET status = ${end.status}, last_error = ${end.last_error}, unseen = true,
      asking = ${end.asking}, closing_line = ${end.closing_line}, updated_at = ${now()} WHERE id = ${id}`
  },
  /** Sets why the agent cannot go on without the user, or clears it; true when that changed it. */
  setBlocked: async (id: string, reason: string | null): Promise<boolean> => {
    const rows = await sql`UPDATE task SET blocked = ${reason}, updated_at = ${now()}
      WHERE id = ${id} AND blocked IS DISTINCT FROM ${reason} RETURNING id`
    return rows.length > 0
  },
  /** The user looked at the agent; a running turn keeps it unseen until it ends. */
  markSeen: async (id: string) => {
    await sql`UPDATE task SET unseen = false WHERE id = ${id} AND status <> 'running'`
  },
  setSession: async (id: string, session: { sessionId: string; permissionMode: string; model: string }) => {
    await sql`UPDATE task SET session_id = ${session.sessionId}, permission_mode = ${session.permissionMode},
      model = ${session.model} WHERE id = ${id}`
  },
  /** Forgets the session id, so the next process starts a new session instead of resuming. */
  clearSession: async (id: string) => {
    await sql`UPDATE task SET session_id = NULL WHERE id = ${id}`
  },
  addOutward: async (id: string, count: number) => {
    await sql`UPDATE task SET outward_count = outward_count + ${count} WHERE id = ${id}`
  },
  remove: async (id: string) => {
    await sql`DELETE FROM task WHERE id = ${id}`
  },
  /**
   * Turns cannot survive a restart; only the server calls this, once at startup. With `resume`, a
   * cut turn that waited on nothing is left seen and marked to resume; the rest need the user.
   */
  markInterrupted: async (resume = false): Promise<{ id: string; resume: boolean }[]> => {
    const rows = await sql<{ id: string; unseen: boolean }[]>`UPDATE task SET status = 'interrupted',
      unseen = NOT (${resume} AND blocked IS NULL AND archived_at IS NULL), blocked = NULL, updated_at = ${now()}
      WHERE status = 'running' RETURNING id, unseen`
    await sql`UPDATE task SET status_line = NULL, status_line_at = NULL WHERE status_line IS NOT NULL`
    return rows.map((row) => ({ id: row.id, resume: !row.unseen }))
  },
}

const QUEUED = sql`(payload::json ->> 'queued')`
/** Enough of a turn's last own messages to find its closing text and its last tool use. */
const TURN_ENDING_ROWS = 40
/** Rows the task's own transcript shows: no subagent messages and no per-step progress reports. */
export const OWN_ROW = sql`(kind <> 'sdk' OR ((payload::json ->> 'parent_tool_use_id') IS NULL
  AND (payload::json ->> 'subtype') IS DISTINCT FROM 'task_progress'))`

export const messages = {
  insert: async (taskId: string, body: MessageBody, outward: string[]): Promise<MessageRow> => {
    const created_at = now()
    const id = await insertMessage(sql, { taskId, body, outward, createdAt: created_at })
    const read = readBody({ task_id: taskId, id }, body.kind, scrubValue(body.payload))
    return { ...read, id, task_id: taskId, outward, created_at }
  },
  after: async (taskId: string, afterId: number) =>
    (
      await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId} AND id > ${afterId} ORDER BY id`
    ).map(toMessage),
  /** The first `limit` of the task's rows after `afterId`, own or not. */
  firstAfter: async (taskId: string, afterId: number, limit: number) =>
    (
      await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId} AND id > ${afterId}
        ORDER BY id LIMIT ${limit}`
    ).map(toMessage),
  /** The task's own `limit` messages just before `before`, or the newest ones without `before`. */
  page: async (taskId: string, limit: number, before = Number.MAX_SAFE_INTEGER): Promise<MessagePage> => {
    const rows = (
      await sql<MessageRecord[]>`SELECT * FROM (SELECT * FROM task_message
        WHERE task_id = ${taskId} AND id < ${before} AND ${OWN_ROW}
        ORDER BY id DESC LIMIT ${limit}) AS page ORDER BY id`
    ).map(toMessage)
    const oldest = rows[0]?.id ?? before
    const [older] = await sql<{ found: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM task_message WHERE task_id = ${taskId} AND id < ${oldest} AND ${OWN_ROW}) AS found`
    return { messages: rows, has_older: older?.found === true }
  },
  /** The task's own `limit` messages just after `after`, oldest first. */
  pageAfter: async (taskId: string, limit: number, after: number): Promise<MessagePage> => {
    const rows = (
      await sql<MessageRecord[]>`SELECT * FROM task_message
        WHERE task_id = ${taskId} AND id > ${after} AND ${OWN_ROW} ORDER BY id LIMIT ${limit + 1}`
    ).map(toMessage)
    const [older] = await sql<{ found: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM task_message WHERE task_id = ${taskId} AND id <= ${after} AND ${OWN_ROW}) AS found`
    return { messages: rows.slice(0, limit), has_older: older?.found === true, has_newer: rows.length > limit }
  },
  /** About `limit` of the task's own messages centred on `id`, oldest first, for a jump far back. */
  around: async (taskId: string, limit: number, id: number): Promise<MessagePage> => {
    const half = Math.floor(limit / 2)
    const [older, newer] = await Promise.all([
      sql<MessageRecord[]>`SELECT * FROM task_message
        WHERE task_id = ${taskId} AND id < ${id} AND ${OWN_ROW} ORDER BY id DESC LIMIT ${half + 1}`,
      sql<MessageRecord[]>`SELECT * FROM task_message
        WHERE task_id = ${taskId} AND id >= ${id} AND ${OWN_ROW} ORDER BY id LIMIT ${limit - half + 1}`,
    ])
    const before = older.slice(0, half).reverse()
    const after = newer.slice(0, limit - half)
    return {
      messages: [...before, ...after].map(toMessage),
      has_older: older.length > half,
      has_newer: newer.length > limit - half,
    }
  },
  /** The latest user message a zero-turn result closed unanswered, unless a command or a resend. */
  droppedPrompt: async (taskId: string, resentNote: string): Promise<DroppedPrompt | null> => {
    const [row] = await sql<PromptRecord[]>`
      WITH latest AS (
        SELECT id, payload, payload::json ->> 'text' AS text FROM task_message
        WHERE task_id = ${taskId} AND kind = 'prompt' AND COALESCE(payload::json ->> 'auto', 'false') = 'false'
        ORDER BY id DESC LIMIT 1
      )
      SELECT latest.id, latest.payload FROM latest
      WHERE latest.text <> '' AND left(latest.text, 1) NOT IN ('/', '!')
        AND EXISTS (SELECT 1 FROM task_message r WHERE r.task_id = ${taskId} AND r.id > latest.id AND r.kind = 'sdk'
          AND r.payload::json ->> 'type' = 'result' AND r.payload::json ->> 'num_turns' = '0')
        AND NOT EXISTS (SELECT 1 FROM task_message a WHERE a.task_id = ${taskId} AND a.id > latest.id AND a.kind = 'sdk'
          AND a.payload::json ->> 'type' = 'assistant' AND (a.payload::json ->> 'parent_tool_use_id') IS NULL)
        AND NOT EXISTS (SELECT 1 FROM task_message n WHERE n.task_id = ${taskId} AND n.id < latest.id AND n.kind = 'seti'
          AND n.payload::json ->> 'error' = ${resentNote}
          AND n.id > COALESCE((SELECT MAX(q.id) FROM task_message q
            WHERE q.task_id = ${taskId} AND q.kind = 'prompt' AND q.id < latest.id), 0))`
    return row === undefined ? null : sentPrompt(taskId, row)
  },
  /** The latest message the user sent, unless a shell command or one taken back from the queue. */
  lastPrompt: async (taskId: string): Promise<DroppedPrompt | null> => {
    const [row] = await sql<PromptRecord[]>`
      SELECT id, payload FROM task_message
      WHERE task_id = ${taskId} AND kind = 'prompt' AND COALESCE(payload::json ->> 'auto', 'false') = 'false'
        AND COALESCE(payload::json ->> 'queued', '') <> 'removed'
      ORDER BY id DESC LIMIT 1`
    const prompt = row === undefined ? null : sentPrompt(taskId, row)
    return prompt === null || prompt.text === '' || prompt.text.startsWith('!') ? null : prompt
  },
  /** The payloads of the agent's own last replies since the latest prompt, oldest first. */
  turnEnding: async (taskId: string) =>
    (
      await sql<{ payload: string }[]>`SELECT payload FROM (
        SELECT id, payload FROM task_message
        WHERE task_id = ${taskId} AND kind = 'sdk' AND payload::json ->> 'type' = 'assistant'
          AND (payload::json ->> 'parent_tool_use_id') IS NULL
          AND id > COALESCE((SELECT MAX(p.id) FROM task_message p WHERE p.task_id = ${taskId} AND p.kind = 'prompt'), 0)
        ORDER BY id DESC LIMIT ${TURN_ENDING_ROWS}
      ) AS ending ORDER BY id`
    ).map((row) => row.payload),
  get: async (taskId: string, id: number) => {
    const [record] = await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId} AND id = ${id}`
    return record && toMessage(record)
  },
  /** Moves a queued prompt out of the waiting state; false when it was not waiting. */
  settleQueued: async (taskId: string, id: number, state: Exclude<QueueState, 'waiting'>) => {
    const [record] = await sql<{ payload: string }[]>`SELECT payload FROM task_message
      WHERE task_id = ${taskId} AND id = ${id} AND kind = 'prompt' AND ${QUEUED} = 'waiting'`
    if (record === undefined) {
      return false
    }
    const payload = JSON.stringify({ ...(JSON.parse(record.payload) as object), queued: state })
    const result = await sql`UPDATE task_message SET payload = ${payload}
      WHERE task_id = ${taskId} AND id = ${id} AND kind = 'prompt' AND ${QUEUED} = 'waiting'`
    return result.count > 0
  },
  /** The task's rows with these ids, oldest first. */
  byIds: async (taskId: string, ids: readonly number[]) =>
    ids.length === 0
      ? []
      : (
          await sql<MessageRecord[]>`SELECT * FROM task_message
            WHERE task_id = ${taskId} AND id = ANY(${[...ids]}::bigint[]) ORDER BY id`
        ).map(toMessage),
}
