import {
  AGENT_SETTING_ENTRIES,
  type AgentCapabilities,
  type AgentSettingEntry,
  type AgentSettingTab,
  type Task,
  type TabSettingId,
} from '@seti/shared'
import type { ReactNode } from 'react'
import { AccessSummary } from '@/panels/access/TaskAccess'
import { AgentPermissions } from '@/panels/tasks/AgentPermissions'
import { TaskBypass } from '@/panels/tasks/BypassToggle'
import { RolePicker, type RoleOwner } from '@/panels/tasks/RolePicker'
import { TaskIsolation } from '@/panels/tasks/SandboxToggle'
import { CompactionRow } from '@/panels/tasks/SessionFields'
import { Row } from '@/panels/tasks/SettingsFields'
import { TaskChannels } from '@/panels/tasks/TaskChannels'
import { TaskColor } from '@/panels/tasks/TaskColor'
import { TaskCpu } from '@/panels/tasks/TaskCpu'
import { TaskHomeAccess } from '@/panels/tasks/TaskHomeAccess'
import { InputModeSelect } from '@/panels/tasks/TaskInputs'
import { TaskMemory } from '@/panels/tasks/TaskMemory'
import { TaskNotify } from '@/panels/tasks/TaskNotify'
import { TaskCredentials } from '@/panels/tasks/TaskProfile'
import { TaskTeam } from '@/panels/tasks/TaskTeam'
import { TaskThreads } from '@/panels/tasks/TaskThreads'
import { WorkspaceSelect } from '@/panels/tasks/workspaces/WorkspaceSelect'

/** What a row of the agent's settings reads and does. */
export interface RowContext {
  task: Task
  caps: AgentCapabilities | null
  running: boolean
  sandboxed: boolean
  onChanged: () => void
  role: { owner: RoleOwner; focus: boolean; onNew: (body: string) => void; onLeave: () => void }
  workspaceFocus: boolean
  openAccess: () => void
  channels: { count: number; onCount: (count: number) => void }
}

/** A row's control, with `warn` when its state is not least privilege; null leaves the row out. */
type RowBody = { body: ReactNode; warn?: boolean } | null

type Rows<T extends AgentSettingTab> = Readonly<Record<TabSettingId<T>, (context: RowContext) => RowBody>>

const GENERAL: Rows<'general'> = {
  role: ({ role, onChanged }) => ({
    body: (
      <RolePicker
        owner={role.owner}
        focus={role.focus}
        onChanged={onChanged}
        onNew={role.onNew}
        onLeave={role.onLeave}
      />
    ),
  }),
  workspace: ({ task, workspaceFocus, onChanged }) => ({
    body: <WorkspaceSelect task={task} focus={workspaceFocus} onMoved={onChanged} />,
  }),
  color: ({ task, onChanged }) => ({ body: <TaskColor task={task} onChanged={onChanged} /> }),
  notify: ({ task, onChanged }) => ({ body: <TaskNotify task={task} onChanged={onChanged} /> }),
}

const ACCESS: Rows<'access'> = {
  credential: ({ task, onChanged }) => ({ body: <TaskCredentials task={task} onChanged={onChanged} /> }),
  access: ({ task, openAccess }) => ({ body: <AccessSummary task={task} onOpen={openAccess} /> }),
  sandbox: ({ task, running, onChanged, caps, sandboxed }) => ({
    body: <TaskIsolation task={task} running={running} onChanged={onChanged} caps={caps} />,
    warn: !sandboxed,
  }),
  home: ({ task, sandboxed, onChanged }) =>
    task.home_access && sandboxed ? { body: <TaskHomeAccess task={task} onChanged={onChanged} /> } : null,
  bypass: ({ task, caps, onChanged }) => ({ body: <TaskBypass task={task} caps={caps} onChanged={onChanged} /> }),
  rules: ({ task }) => ({ body: <AgentPermissions task={task} /> }),
}

const TEAM: Rows<'team'> = {
  chat: ({ task }) => ({ body: <TaskTeam taskId={task.id} /> }),
  channels: ({ task, channels }) => ({ body: <TaskChannels taskId={task.id} onCount={channels.onCount} /> }),
  threads: ({ task }) => ({ body: <TaskThreads taskId={task.id} /> }),
  updates: ({ task, channels, onChanged }) =>
    task.pr_urls.length > 0 || channels.count > 0
      ? { body: <InputModeSelect task={task} onChanged={onChanged} /> }
      : null,
}

const SESSION: Rows<'session'> = {
  memory: ({ task }) => ({ body: <TaskMemory taskId={task.id} /> }),
  cpu: ({ task }) => ({ body: <TaskCpu taskId={task.id} /> }),
  compaction: ({ task, caps }) => ({ body: <CompactionRow taskId={task.id} caps={caps} /> }),
}

/** Each row by setting id; the per-tab types hold every tab to the registry's settings in it. */
const ROWS: Readonly<Record<TabSettingId<AgentSettingTab>, (context: RowContext) => RowBody>> = {
  ...GENERAL,
  ...ACCESS,
  ...TEAM,
  ...SESSION,
}

type TabEntry = Extract<AgentSettingEntry, { place: AgentSettingTab }>

/** The settings of one tab, in the registry's order, each in its row with the registry's label. */
export function SettingRows({ tab, context }: { tab: AgentSettingTab; context: RowContext }) {
  return AGENT_SETTING_ENTRIES.filter((entry): entry is TabEntry => entry.place === tab).map((entry) => {
    const row = ROWS[entry.id](context)
    return row === null ? null : (
      <Row key={entry.id} label={entry.label} warn={row.warn}>
        {row.body}
      </Row>
    )
  })
}
