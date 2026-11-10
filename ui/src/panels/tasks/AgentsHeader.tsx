import { Plus } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { chordAria, chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import { openStartPage } from '@/lib/start-context'
import { QuestionsButton } from '@/panels/questions/QuestionsButton'
import { AgentSearchButton } from '@/panels/tasks/AgentFilter'
import { AgentListMenu } from '@/panels/tasks/AgentListMenu'
import { LayoutToggles } from '@/panels/tasks/LayoutToggles'

interface Props {
  narrow: boolean
  /** Whether the filter is open; null where there is no filter to open. */
  searching: boolean | null
  onSearching: (open: boolean) => void
  archived: boolean
  onArchived: (archived: boolean) => void
  onImport: () => void
}

/** The Agents list title with layout toggles, Questions, the filter, new agent and the list menu. */
export function AgentsHeader({ narrow, searching, onSearching, archived, onArchived, onImport }: Props) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <h1 className="min-w-0 truncate text-sm font-semibold">Agents</h1>
      <div className="flex shrink-0 gap-1.5">
        <LayoutToggles narrow={narrow} />
        <QuestionsButton />
        {searching !== null && <AgentSearchButton open={searching} onOpen={onSearching} />}
        <Hint text={`New agent (${chordLabel(CHORDS.newAgent)})`}>
          <Button
            size="icon-sm"
            aria-label="New agent"
            aria-keyshortcuts={chordAria(CHORDS.newAgent)}
            onClick={() => {
              openStartPage()
            }}
          >
            <Plus />
          </Button>
        </Hint>
        <AgentListMenu archived={archived} onArchived={onArchived} onImport={onImport} />
      </div>
    </div>
  )
}
