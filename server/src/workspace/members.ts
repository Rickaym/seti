import { roleLabel, type MessageRow, type TeamMember } from '@seti/shared'
import { messages } from '../db.js'
import { packForDisplay } from '../seti-guide.js'
import { rolePacksByTask } from '../store/context.js'
import { teamRoster } from '../team.js'

const LINE_CHARS = 140
const ROLE_CHARS = 80
const RECENT_ROWS = 40

interface MemberLine {
  task_id: string
  handle: string
  title: string
  status: string
  muted: boolean
  role: string | null
  working_on: string
}

export interface Roster {
  active: MemberLine[]
  inactive: number
}

const clip = (text: string) => (text.length <= LINE_CHARS ? text : `${text.slice(0, LINE_CHARS - 3)}...`)

/** The first line of the agent's latest words, as a hint of what the task is doing. */
export function latestLine(rows: readonly MessageRow[]): string | null {
  for (const row of rows.toReversed()) {
    if (row.kind === 'sdk' && row.payload.type === 'assistant' && row.payload.parent_tool_use_id === null) {
      const text = row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
      const line = text
        .split('\n')
        .map((part) => part.trim())
        .find((part) => part !== '')
      if (line !== undefined) {
        return clip(line)
      }
    }
  }
  return null
}

async function lineOf(member: TeamMember, roles: ReadonlyMap<string, string>): Promise<MemberLine> {
  const rows = (await messages.page(member.task_id, RECENT_ROWS)).messages
  return {
    task_id: member.task_id,
    handle: member.handle,
    title: member.title,
    status: member.status,
    muted: member.muted,
    role: roles.get(member.task_id) ?? null,
    working_on: latestLine(rows) ?? member.title,
  }
}

/** Active agents with what each works on; one roster serves every open workspace. */
export async function loadRoster(): Promise<Roster> {
  const roster = await teamRoster()
  const active = roster.filter((member) => member.active)
  const roles = new Map(
    [...(await rolePacksByTask())].map(([taskId, pack]) => {
      const shown = packForDisplay(pack)
      return [taskId, roleLabel(shown.name, shown.body, ROLE_CHARS)]
    }),
  )
  return {
    active: await Promise.all(active.map(async (member) => lineOf(member, roles))),
    inactive: roster.length - active.length,
  }
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

export function renderMembers(roster: Roster, taskId: string): string {
  const rows = roster.active.map((member) =>
    [
      `@${member.handle}${member.task_id === taskId ? ' (you)' : ''}`,
      member.status,
      member.muted ? 'yes' : 'no',
      cell(member.title),
      cell(member.role ?? '-'),
      cell(member.working_on),
    ].join(' | '),
  )
  return [
    '# Seti agents',
    '',
    'Read-only; Seti rewrites it as agents come and go. Mention one as @handle in chat.md.',
    "@all reaches every active agent that is not muted, @ea is the user's assistant, @user is the user.",
    "Role is the agent's role pack and its first line; route work to the agent whose role fits.",
    '',
    '| Agent | Status | Muted | Task | Role | Working on |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
    `Inactive agents: ${String(roster.inactive)}.`,
    '',
  ].join('\n')
}
