import type { Task } from '@seti/shared'
import { Folder, FolderGit2, GitBranch, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'

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

function EntryRow({ entry, runsHere }: { entry: Entry; runsHere: boolean }) {
  const name = entry.repoId === null ? entry.dir : entry.label
  const shown = displayOf(entry)
  const Kind = entry.repoId === null ? Folder : FolderGit2
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1" role="group" aria-label={name}>
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
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:min-h-11"
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
      {runsHere && (
        <Hint text="The agent runs here">
          <span
            role="img"
            aria-label="Runs here"
            className="inline-flex size-6 shrink-0 items-center justify-center text-primary"
          >
            <MapPin className="size-3" />
          </span>
        </Hint>
      )}
    </div>
  )
}

/** Where the agent works, to read and copy: its own folder, and what an older agent was given. */
export function TaskLocation({ task }: { task: Task }) {
  const entries = entriesOf(task)
  return (
    <div className="flex min-w-0 flex-col">
      {entries.map((entry) => (
        <EntryRow key={entry.dir} entry={entry} runsHere={entries.length > 1 && entry.dir === task.cwd} />
      ))}
    </div>
  )
}
