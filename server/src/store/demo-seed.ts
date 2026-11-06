import {
  AGENTS,
  agentSeeds,
  PR_URL,
  REPO_IDS,
  REPOS,
  TEAM_CHAT,
  TEAM_HANDLES,
  type AgentSeed,
  type DemoRepo,
} from '../demo/content/cast.js'
import { FLEET, FLEET_WORKSPACE, fleetTranscript, type FleetSeed } from '../demo/content/history.js'

type SeedValue = string | number | null

/** Runs one statement with `?` placeholders; the README screenshots and the demo each bring one. */
export type SeedRun = (query: string, ...values: SeedValue[]) => Promise<void>

export interface SeedPlan {
  run: SeedRun
  /** The moment the data is seeded for, in epoch milliseconds. */
  now: number
  /** Where each repo's checkout lives; agents of the repo work there. */
  repoDir: (repo: DemoRepo) => string
}

const ago = (plan: SeedPlan, minutes: number) => new Date(plan.now - minutes * 60_000).toISOString()

async function seedAgent(plan: SeedPlan, agent: AgentSeed): Promise<void> {
  const first = plan.now - agent.started * 60_000
  const last = plan.now - agent.ended * 60_000
  const step = (last - first) / Math.max(1, agent.transcript.rows.length - 1)
  await plan.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, sandbox, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
    agent.id,
    agent.title,
    REPO_IDS[agent.repo],
    plan.repoDir(agent.repo),
    agent.status,
    `session-${agent.id.slice(0, 8)}`,
    new Date(first).toISOString(),
    new Date(last).toISOString(),
  )
  for (const [n, [kind, payload]] of agent.transcript.rows.entries()) {
    await plan.run(
      `INSERT INTO task_message (task_id, kind, payload, outward, created_at) VALUES (?, ?, ?, '[]', ?)`,
      agent.id,
      kind,
      JSON.stringify(payload),
      new Date(Math.round(first + n * step)).toISOString(),
    )
  }
  for (const [column, value] of Object.entries(agent.extra)) {
    if (typeof value === 'boolean') {
      await plan.run(`UPDATE task SET ${column} = ${String(value)} WHERE id = ?`, agent.id)
    } else {
      await plan.run(`UPDATE task SET ${column} = ? WHERE id = ?`, value, agent.id)
    }
  }
}

const DAY_MINUTES = 24 * 60
/** Merges land two hours into a day back, so today's sits before the moment the data shows. */
const MERGE_OFFSET_MINUTES = 120

const MERGED_SNAPSHOT = JSON.stringify({
  state: 'merged',
  conflicting: false,
  ci: null,
  review_ids: [],
  comment_ids: [],
})

async function seedFleetAgent(plan: SeedPlan, seed: FleetSeed, firstPr: number): Promise<void> {
  await seedAgent(plan, {
    id: seed.id,
    title: seed.title,
    repo: seed.repo,
    status: seed.status,
    transcript: fleetTranscript(seed),
    started: seed.from * DAY_MINUTES + 60,
    ended: seed.to * DAY_MINUTES + 30,
    extra: { color: seed.color, workspace_id: FLEET_WORKSPACE.id },
  })
  for (const [n, days] of seed.merged.entries()) {
    const url = `https://github.com/${seed.repo}/pull/${String(firstPr + n)}`
    const at = ago(plan, days * DAY_MINUTES + MERGE_OFFSET_MINUTES)
    await plan.run(
      `INSERT INTO pr_watch (pr_url, snapshot, open, checked_at) VALUES (?, ?, 0, ?)`,
      url,
      MERGED_SNAPSHOT,
      at,
    )
    await plan.run(`INSERT INTO task_pr_dismissed (task_id, pr_url, at) VALUES (?, ?, ?)`, seed.id, url, at)
  }
}

/** A Platform workspace of agents with a month of turns, MCP calls and merged PRs. */
async function seedFleet(plan: SeedPlan): Promise<void> {
  await plan.run(
    `INSERT INTO workspace (id, name, position, created_at) VALUES (?, ?, 1, ?)`,
    FLEET_WORKSPACE.id,
    FLEET_WORKSPACE.name,
    ago(plan, 30 * DAY_MINUTES),
  )
  let firstPr = 300
  for (const seed of FLEET) {
    await seedFleetAgent(plan, seed, firstPr)
    firstPr += seed.merged.length
  }
}

/** The repos and agents, with the storefront agent's PR linked to it, and the Platform fleet. */
export async function seedAgents(plan: SeedPlan): Promise<void> {
  for (const [n, slug] of REPOS.entries()) {
    await plan.run(
      `INSERT INTO repo (id, slug, path, base_branch, created_at) VALUES (?, ?, ?, 'main', ?)`,
      REPO_IDS[slug],
      slug,
      plan.repoDir(slug),
      ago(plan, 60 * 24 * 30 - n),
    )
  }
  for (const agent of agentSeeds()) {
    await seedAgent(plan, agent)
  }
  await plan.run(
    `INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'agent')`,
    AGENTS.checkout,
    PR_URL,
    ago(plan, 10),
  )
  await seedFleet(plan)
}

/** A short group chat: the user, the EA and two agents coordinating a release. */
export async function seedTeamChat(plan: SeedPlan): Promise<void> {
  for (const [key, handle] of Object.entries(TEAM_HANDLES)) {
    await plan.run(
      `INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`,
      AGENTS[key as keyof typeof TEAM_HANDLES],
      handle,
      ago(plan, 30),
    )
  }
  for (const line of TEAM_CHAT) {
    await plan.run(
      `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      line.kind,
      line.handle === null ? null : AGENTS[line.handle],
      line.handle,
      line.text,
      JSON.stringify(line.mentions.map((handle) => ({ handle, task_id: AGENTS[handle] }))),
      ago(plan, line.ago),
    )
  }
}

/** Spaces the EA chat 40 seconds apart, ending three minutes ago. */
export async function stampEaChat(plan: SeedPlan): Promise<void> {
  await plan.run(
    `UPDATE ea_history SET created_at = to_char((?::timestamptz - (interval '40 seconds' * (max_id - id))) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     FROM (SELECT max(id) AS max_id FROM ea_history) m`,
    ago(plan, 3),
  )
}

/** Puts the channel events and the EA's inbox of them 25 minutes back. */
export async function stampChannels(plan: SeedPlan): Promise<void> {
  await plan.run(`UPDATE channel_event SET occurred_at = ?, created_at = ?`, ago(plan, 25), ago(plan, 25))
  await plan.run(
    `UPDATE ea_inbox SET created_at = ?, due_at = ?, delivered_at = ?,
       acknowledged_at = CASE WHEN acknowledged_at IS NULL THEN NULL ELSE ? END`,
    ago(plan, 25),
    ago(plan, 25),
    ago(plan, 24),
    ago(plan, 20),
  )
}
