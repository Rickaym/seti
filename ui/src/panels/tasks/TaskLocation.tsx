import type { Repo, Task, TaskDirInput, TaskRepoInput } from '@seti/shared'
import { Folder, FolderGit2, FolderOpen, GitBranch, MapPin, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPatch, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const NEXT_TURN = 'Applies from the next turn'

/** One trailing column per row, so the run marker and its button line up across rows. */
const SLOT = 'inline-flex size-6 shrink-0 items-center justify-center pointer-coarse:size-11'
const REVEAL =
  'pointer-fine:opacity-0 pointer-fine:group-focus-within/dir:opacity-100 pointer-fine:group-hover/dir:opacity-100'

/** One directory the agent works in: a repo of the task, a plain directory, or where it runs. */
interface Entry {
  dir: string
  label: string
  repoId: string | null
  worktree: boolean
}

/** Every entry once, where the agent runs first. */
function entriesOf(task: Task): Entry[] {
  const repos = task.repos.map((repo) => ({
    dir: repo.dir,
    label: repo.slug,
    repoId: repo.id,
    worktree: repo.worktree,
  }))
  const dirs = task.dirs.map((dir) => ({ dir, label: dir, repoId: null, worktree: false }))
  const listed = [...repos, ...dirs]
  const home = listed.find((entry) => entry.dir === task.cwd) ?? {
    dir: task.cwd,
    label: task.cwd,
    repoId: null,
    worktree: false,
  }
  return [home, ...listed.filter((entry) => entry !== home)]
}

/** The visible pair: a short name, and the path without a tail that only repeats the name. */
function displayOf(entry: Entry): { name: string; where: string } {
  const parts = entry.dir.split('/').filter((part) => part !== '')
  const folder = parts.at(-1) ?? entry.dir
  const name = entry.repoId === null ? folder : (entry.label.split('/').at(-1) ?? entry.label)
  const where = folder === name ? `/${parts.slice(0, -1).join('/')}/`.replace('//', '/') : entry.dir
  return { name, where }
}

function copyPath(dir: string): void {
  navigator.clipboard.writeText(dir).then(
    () => toast.success(`Copied ${dir}`),
    () => toast.error(`Copy failed; the path is ${dir}`),
  )
}

async function act(run: () => Promise<unknown>, onChanged: () => void): Promise<void> {
  try {
    await run()
    toast.success(NEXT_TURN)
    onChanged()
  } catch (e) {
    toast.error(errorText(e))
  }
}

function RepoAdder({ task, onAdded }: { task: Task; onAdded: () => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [repoId, setRepoId] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [ref, setRef] = useState('')

  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then(setRepos)
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  const taken = new Set(task.repos.map((repo) => repo.id))
  const choices = (repos ?? []).filter((repo) => !taken.has(repo.id))
  const chosen = choices.find((repo) => repo.id === repoId)
  if (repos !== null && choices.length === 0) {
    return <p className="text-xs text-muted-foreground">Every registered repo is already part of this agent.</p>
  }
  const add = async () => {
    const body: TaskRepoInput = { repo_id: repoId, worktree, ...(worktree && ref.trim() !== '' ? { ref } : {}) }
    await act(async () => apiPost(`/tasks/${task.id}/repos`, body), onAdded)
  }
  return (
    <div className="space-y-2">
      <NativeSelect
        aria-label="Repo"
        className="w-full"
        value={repoId}
        onChange={(e) => {
          setRepoId(e.target.value)
        }}
      >
        <NativeSelectOption value="">{repos === null ? 'Loading...' : 'Pick a repo'}</NativeSelectOption>
        {choices.map((repo) => (
          <NativeSelectOption key={repo.id} value={repo.id}>
            {repo.slug}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch aria-label="Isolated worktree" checked={worktree} onCheckedChange={setWorktree} />
        {worktree ? 'Fresh worktree under ~/.seti/worktrees' : 'Works directly in the checkout'}
      </label>
      {worktree && (
        <Input
          aria-label="Start from"
          value={ref}
          onChange={(e) => {
            setRef(e.target.value)
          }}
          placeholder={chosen?.base_branch ?? 'main'}
        />
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={chosen === undefined} onClick={() => void add()}>
          <Plus />
          Add
        </Button>
      </div>
    </div>
  )
}

function DirAdder({ task, onAdded }: { task: Task; onAdded: () => void }) {
  const [path, setPath] = useState('')
  const add = async () => {
    const body: TaskDirInput = { path }
    await act(async () => apiPost(`/tasks/${task.id}/dirs`, body), onAdded)
  }
  return (
    <div className="space-y-2">
      <Input
        aria-label="Directory path"
        value={path}
        onChange={(e) => {
          setPath(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && path.trim() !== '') {
            void add()
          }
        }}
        placeholder="~/notes or /srv/data"
      />
      <p className="text-2xs text-muted-foreground">
        An existing directory; not your home, a dot folder or Seti&apos;s data.
      </p>
      <div className="flex justify-end">
        <Button size="sm" disabled={path.trim() === ''} onClick={() => void add()}>
          <Plus />
          Add
        </Button>
      </div>
    </div>
  )
}

/** Adds a registered repo or an existing directory to the task. */
function LocationAdder({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'repo' | 'dir'>('repo')
  const done = () => {
    setOpen(false)
    onChanged()
  }
  const tab = (value: 'repo' | 'dir', label: string, Icon: typeof FolderGit2) => (
    <Button
      size="xs"
      variant={kind === value ? 'secondary' : 'ghost'}
      aria-pressed={kind === value}
      onClick={() => {
        setKind(value)
      }}
    >
      <Icon />
      {label}
    </Button>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Add a repo or directory this agent can read and edit">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" className="pointer-coarse:h-11" aria-label="Add repo or directory">
            <Plus />
            Add
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-80 space-y-2">
        <div className="flex gap-1">
          {tab('repo', 'Repo', FolderGit2)}
          {tab('dir', 'Directory', FolderOpen)}
        </div>
        {open && kind === 'repo' && <RepoAdder task={task} onAdded={done} />}
        {open && kind === 'dir' && <DirAdder task={task} onAdded={done} />}
      </PopoverContent>
    </Popover>
  )
}

function EntryRow({ task, entry, onChanged }: { task: Task; entry: Entry; onChanged: () => void }) {
  const confirm = useConfirm()
  const runsHere = entry.dir === task.cwd
  const name = entry.repoId === null ? entry.dir : entry.label

  const moveHere = async () => {
    const message = `The agent restarts in ${entry.dir} at its next turn and keeps its conversation.`
    if (await confirm({ title: 'Change the working directory?', message, confirmLabel: 'Work here' })) {
      await act(async () => apiPatch(`/tasks/${task.id}`, { cwd: entry.dir }), onChanged)
    }
  }
  const remove = async () => {
    const kept = entry.worktree ? ' Its worktree stays on disk until the agent is deleted.' : ' Its files stay.'
    const message = `Remove ${name} from this agent?${kept}`
    if (!(await confirm({ message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    const path =
      entry.repoId === null
        ? `/tasks/${task.id}/dirs?path=${encodeURIComponent(entry.dir)}`
        : `/tasks/${task.id}/repos/${entry.repoId}`
    await act(async () => apiDelete(path), onChanged)
  }

  const shown = displayOf(entry)
  const Kind = entry.repoId === null ? Folder : FolderGit2
  return (
    <div className="group/dir flex min-h-6 min-w-0 items-center gap-1" role="group" aria-label={name}>
      <Hint
        text={
          <span className="font-mono">
            {entry.repoId !== null && (
              <span className="block">{entry.worktree ? `${entry.label}, worktree` : entry.label}</span>
            )}
            {entry.dir}
          </span>
        }
      >
        <button
          type="button"
          aria-label={`Copy path of ${shown.name}${entry.worktree ? ', a worktree' : ''}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            copyPath(entry.dir)
          }}
        >
          <Kind aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{shown.name}</span>
          {entry.worktree && <GitBranch aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
          <span dir="rtl" className="min-w-0 flex-1 truncate text-left text-muted-foreground pointer-coarse:hidden">
            <span dir="ltr">{shown.where}</span>
          </span>
        </button>
      </Hint>
      {runsHere ? (
        <>
          <Hint text="The agent runs here">
            <span role="img" aria-label="Runs here" className={cn(SLOT, 'text-primary')}>
              <MapPin className="size-3" />
            </span>
          </Hint>
          <span aria-hidden className={SLOT} />
        </>
      ) : (
        <>
          <Hint text="Make this the working directory; the session restarts there at the next turn">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(SLOT, REVEAL)}
              aria-label={`Work in ${name}`}
              onClick={() => void moveHere()}
            >
              <MapPin />
            </Button>
          </Hint>
          <Hint text="Remove from this agent; nothing on disk is deleted">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(SLOT, REVEAL)}
              aria-label={`Remove ${name}`}
              onClick={() => void remove()}
            >
              <X />
            </Button>
          </Hint>
        </>
      )}
    </div>
  )
}

/** Where the agent works: its working directory, its repos and directories, and adding more. */
export function TaskLocation({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const entries = entriesOf(task)
  return (
    <div className="flex min-w-0 flex-col">
      {entries.map((entry) => (
        <EntryRow key={entry.dir} task={task} entry={entry} onChanged={onChanged} />
      ))}
      <div className="-ml-2 pt-0.5">
        <LocationAdder task={task} onChanged={onChanged} />
      </div>
    </div>
  )
}
