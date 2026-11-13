import type { Task } from '@seti/shared'
import {
  Activity,
  KeyRound,
  Layers,
  Settings,
  SlidersHorizontal,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { useCommands } from '@/components/palette/useCommands'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useNarrow } from '@/hooks/useMedia'
import { useSandboxed } from '@/hooks/useSandboxed'
import { WIDE_BUTTON, WIDE_LABEL } from '@/lib/wide-label'
import { AccessSummary, TaskAccessDialog } from '@/panels/access/TaskAccess'
import { AgentPermissions } from '@/panels/tasks/AgentPermissions'
import { BypassToggle } from '@/panels/tasks/BypassToggle'
import { LifecycleActions } from '@/panels/tasks/LifecycleActions'
import { NewRoleDialog, RolePicker, type RoleOwner } from '@/panels/tasks/RolePicker'
import { SandboxToggle } from '@/panels/tasks/SandboxToggle'
import { SessionFields } from '@/panels/tasks/SessionFields'
import { Fields, Row } from '@/panels/tasks/SettingsFields'
import { HeldBack } from '@/panels/tasks/StartFacts'
import { TaskChannels } from '@/panels/tasks/TaskChannels'
import { TaskColor } from '@/panels/tasks/TaskColor'
import { InputModeSelect } from '@/panels/tasks/TaskInputs'
import { TaskLocation } from '@/panels/tasks/TaskLocation'
import { TaskNotify } from '@/panels/tasks/TaskNotify'
import { TaskCredentials } from '@/panels/tasks/TaskProfile'
import { TaskTeam } from '@/panels/tasks/TaskTeam'
import { useArchive } from '@/panels/tasks/useArchive'
import { useSessionRestart } from '@/panels/tasks/useSessionRestart'
import { WorkspaceSelect } from '@/panels/tasks/workspaces/WorkspaceSelect'

type SectionId = 'general' | 'access' | 'team' | 'session'

/** The tabs in reading order, the most used first. */
const SECTIONS: readonly { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'access', label: 'Access', icon: KeyRound },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'session', label: 'Session', icon: Activity },
]

/** A confirmation opened from the details leaves them open behind it. */
const keepForDialogs = (e: Event) => {
  if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]') !== null) {
    e.preventDefault()
  }
}

interface TaskSettingsProps {
  task: Task
  onChanged: () => void
  /** A turn, shell command or background job runs, so the agent cannot be archived yet. */
  busy: boolean
  /** A turn runs, which a session restart stops first. */
  running: boolean
  /** The smaller size compact agent headers use. */
  compact?: boolean
}

/** The cog's size and wide label; framed agents take the smaller size and no label. */
const cogStyle = (compact?: boolean) =>
  compact === true
    ? { size: 'icon-xs' as const, button: undefined, label: 'hidden' }
    : { size: 'icon-sm' as const, button: WIDE_BUTTON, label: WIDE_LABEL }

const roleOwner = (task: Task): RoleOwner => ({
  packsPath: `/tasks/${task.id}/context-packs`,
  rolePath: `/tasks/${task.id}/role`,
  name: task.title,
  pinned: task.pinned,
})

/** What is not needed at a glance, behind a cog: a popover, or a bottom sheet on phones. */
export const TaskSettings = memo(function TaskSettingsView({
  task,
  onChanged,
  busy,
  running,
  compact,
}: TaskSettingsProps) {
  const sandboxed = useSandboxed(task)
  const archive = useArchive(task)
  const session = useSessionRestart(task, running, onChanged)
  const [channelCount, setChannelCount] = useState(0)
  const [open, setOpen] = useState(false)
  const narrow = useNarrow()
  const cog = cogStyle(compact)
  const [accessOpen, setAccessOpen] = useState(false)
  const [roleFocus, setRoleFocus] = useState(false)
  const [workspaceFocus, setWorkspaceFocus] = useState(false)
  const [newRole, setNewRole] = useState<string | null>(null)
  const [section, setSection] = useState<SectionId>('general')
  useCommands([
    {
      id: 'agent.access',
      title: 'Open access',
      detail: task.title,
      icon: KeyRound,
      group: 'Current agent',
      keywords: 'ssh aws mcp servers packs plugins permissions',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setAccessOpen(true)
      },
    },
    {
      id: 'agent.role',
      title: 'Change role',
      detail: task.title,
      icon: UserCog,
      group: 'Current agent',
      keywords: 'role pack system prompt standing instructions lead delegate reviewer watcher',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setSection('general')
        setRoleFocus(true)
        setOpen(true)
      },
    },
    {
      id: 'agent.workspace',
      title: 'Move to workspace...',
      detail: task.title,
      icon: Layers,
      group: 'Current agent',
      keywords: 'workspace move group',
      when: (context) => context.agent?.id === task.id,
      run: () => {
        setSection('general')
        setWorkspaceFocus(true)
        setOpen(true)
      },
    },
  ])
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    setRoleFocus(false)
    setWorkspaceFocus(false)
  }
  const focusContent = (e: Event) => {
    e.preventDefault()
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.focus()
    }
  }
  const panels: Record<SectionId, ReactNode> = {
    general: (
      <Fields>
        <Row label="Role">
          <RolePicker
            owner={roleOwner(task)}
            focus={roleFocus}
            onChanged={onChanged}
            onNew={(body) => {
              setOpen(false)
              setNewRole(body)
            }}
            onLeave={() => {
              setOpen(false)
            }}
          />
        </Row>
        <Row label="Workspace">
          <WorkspaceSelect task={task} focus={workspaceFocus} onMoved={onChanged} />
        </Row>
        <Row label="Color">
          <TaskColor task={task} onChanged={onChanged} />
        </Row>
        <Row label="Notify">
          <TaskNotify task={task} onChanged={onChanged} />
        </Row>
        <Row label="Directories">
          <TaskLocation task={task} onChanged={onChanged} />
        </Row>
      </Fields>
    ),
    access: (
      <Fields>
        <Row label="Credentials">
          <TaskCredentials task={task} onChanged={onChanged} />
        </Row>
        <Row label="Services">
          <AccessSummary
            taskId={task.id}
            onOpen={() => {
              setOpen(false)
              setAccessOpen(true)
            }}
          />
        </Row>
        <Row label="Isolation" warn={!sandboxed}>
          <SandboxToggle task={task} running={running} onChanged={onChanged} />
        </Row>
        <Row label="Bypass">
          <BypassToggle task={task} onChanged={onChanged} />
        </Row>
        <Row label="Rules">
          <AgentPermissions task={task} />
        </Row>
        {task.setup !== null && task.setup.withheld.length > 0 && (
          <Row label="Held back">
            <HeldBack setup={task.setup} />
          </Row>
        )}
        {task.outward_count > 0 && <Row label="Outward calls">{task.outward_count}</Row>}
      </Fields>
    ),
    team: (
      <Fields>
        <Row label="Group chat">
          <TaskTeam taskId={task.id} />
        </Row>
        <Row label="Channels">
          <TaskChannels taskId={task.id} onCount={setChannelCount} />
        </Row>
        {(task.pr_urls.length > 0 || channelCount > 0) && (
          <Row label="Updates">
            <InputModeSelect task={task} onChanged={onChanged} />
          </Row>
        )}
      </Fields>
    ),
    session: <SessionFields task={task} running={running} />,
  }
  const details = (
    <Tabs
      value={section}
      onValueChange={(value) => {
        setSection(SECTIONS.find((s) => s.id === value)?.id ?? 'general')
      }}
      role="group"
      aria-label="Agent details"
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList
        variant="line"
        aria-label="Sections"
        className="w-full shrink-0 justify-start gap-0 border-b border-border px-1 group-data-horizontal/tabs:h-9 pointer-coarse:group-data-horizontal/tabs:h-auto"
      >
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            className="flex-none px-2 max-md:flex-1 pointer-coarse:min-h-11 [&_svg:not([class*='size-'])]:size-3.5"
          >
            <Icon aria-hidden />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {SECTIONS.map(({ id }) => (
        <TabsContent
          key={id}
          value={id}
          className="min-h-56 overflow-y-auto overscroll-contain px-3 py-3 max-md:min-h-72 max-md:px-4"
        >
          {panels[id]}
        </TabsContent>
      ))}
    </Tabs>
  )
  const actions = (
    <LifecycleActions
      busy={busy}
      onRestart={() => {
        setOpen(false)
        void session.restart()
      }}
      onFresh={() => {
        setOpen(false)
        void session.fresh()
      }}
      onArchive={() => {
        setOpen(false)
        void archive()
      }}
    />
  )
  return (
    <>
      {narrow ? (
        <>
          <Button
            variant="ghost"
            size={cog.size}
            aria-label="Agent settings"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setOpen(true)
            }}
          >
            <Settings />
          </Button>
          <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              aria-describedby={undefined}
              className="max-h-[calc(var(--app-height,100dvh)-env(safe-area-inset-top)-1.5rem)] gap-0"
              tabIndex={-1}
              onOpenAutoFocus={focusContent}
              onFocusOutside={keepForDialogs}
              onPointerDownOutside={keepForDialogs}
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-4">
                <SheetTitle className="min-w-0 truncate text-sm font-semibold">Agent settings</SheetTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close agent settings"
                  onClick={() => {
                    setOpen(false)
                  }}
                >
                  <X />
                </Button>
              </div>
              {details}
              <div className="shrink-0 border-t border-border px-4 py-2.5">{actions}</div>
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <Popover open={open} onOpenChange={onOpenChange}>
          <Hint text="Agent settings: general, access, team and session">
            <PopoverTrigger asChild>
              <Button variant="ghost" size={cog.size} aria-label="Agent settings" className={cog.button}>
                <Settings />
                <span className={cog.label}>Settings</span>
              </Button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent
            align="end"
            className="max-h-(--radix-popover-content-available-height) w-[26rem] gap-0 overflow-hidden p-0"
            tabIndex={-1}
            onOpenAutoFocus={focusContent}
            onFocusOutside={keepForDialogs}
            onPointerDownOutside={keepForDialogs}
          >
            {details}
            <div className="shrink-0 border-t border-border px-3 py-2.5">{actions}</div>
          </PopoverContent>
        </Popover>
      )}
      {newRole !== null && (
        <NewRoleDialog
          owner={roleOwner(task)}
          initial={newRole}
          onChanged={onChanged}
          onClose={() => {
            setNewRole(null)
          }}
        />
      )}
      {accessOpen && (
        <TaskAccessDialog
          task={task}
          onChanged={onChanged}
          onClose={() => {
            setAccessOpen(false)
          }}
        />
      )}
    </>
  )
})
