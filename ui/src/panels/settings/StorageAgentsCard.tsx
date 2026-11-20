import { FILES_TREE_ROOT, filesLinkHash, type AgentStorage } from '@seti/shared'
import { BrushCleaning, FolderTree } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/time'
import { bytesLabel, sizeLabel } from '@/panels/resources/format'
import { CleanDialog } from './CleanDialog'
import { SettingsCard } from './layout'

const STATE_WORDS = { running: 'Running', idle: 'Idle', archived: 'Archived' } as const

const treeLink = (taskId: string) =>
  `#${filesLinkHash({ task_id: taskId, root: FILES_TREE_ROOT, path: '', type: 'dir' })}`

function rebuildableWords(agent: AgentStorage): string {
  if (agent.rebuildable_bytes === null) {
    return 'rebuildable: measuring'
  }
  return `${bytesLabel(agent.rebuildable_bytes)} rebuildable`
}

function AgentRow({ agent, onClean }: { agent: AgentStorage; onClean: () => void }) {
  const running = agent.state === 'running'
  const nothing = agent.rebuildable_bytes === 0
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <a href={treeLink(agent.task_id)} className="flex min-w-0 items-center gap-1.5 hover:underline">
          <FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{agent.title}</span>
        </a>
        <div className="truncate text-2xs text-muted-foreground">
          {STATE_WORDS[agent.state]}, active {relativeTime(agent.last_activity)}, {rebuildableWords(agent)}
        </div>
      </div>
      <span className="shrink-0 text-right tabular-nums">{sizeLabel(agent.size)}</span>
      <Hint text={running ? 'Clean waits until the agent stops' : 'Remove rebuildable folders after a preview'}>
        <span>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Clean ${agent.title}`}
            disabled={running || nothing}
            onClick={onClean}
          >
            <BrushCleaning />
            <span className="max-sm:sr-only">Clean</span>
          </Button>
        </span>
      </Hint>
    </li>
  )
}

/** One row per agent, largest first, each linking to its tree and offering Clean. */
export function StorageAgentsCard({ agents }: { agents: readonly AgentStorage[] }) {
  const [cleaning, setCleaning] = useState<AgentStorage | null>(null)
  return (
    <SettingsCard title="Agents">
      {agents.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">No agents yet.</p>
      ) : (
        <ul aria-label="Agents by size" className="divide-y divide-border">
          {agents.map((agent) => (
            <AgentRow
              key={agent.task_id}
              agent={agent}
              onClean={() => {
                setCleaning(agent)
              }}
            />
          ))}
        </ul>
      )}
      {cleaning !== null && (
        <CleanDialog
          taskId={cleaning.task_id}
          title={cleaning.title}
          onClose={() => {
            setCleaning(null)
          }}
        />
      )}
    </SettingsCard>
  )
}
