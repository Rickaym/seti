import { Archive, EllipsisVertical, Import, MessageCircleQuestion } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { chordAria, chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useOpenQuestions } from '@/hooks/useQuestions'
import { navigate } from '@/lib/route'
import { QUESTIONS_ROUTE } from '@/panels/questions/route'

interface AgentListMenuProps {
  archived: boolean
  onArchived: (archived: boolean) => void
  onImport: () => void
}

/** The Agents list's rarer actions behind one button, so its header holds only view, new and this. */
export function AgentListMenu({ archived, onArchived, onImport }: AgentListMenuProps) {
  const open = useOpenQuestions().length
  return (
    <DropdownMenu modal={false}>
      <Hint text="Archived agents, import and questions">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="outline" aria-label="More list actions">
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem checked={archived} onCheckedChange={onArchived}>
          <Archive />
          Archived
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          aria-label="Import sessions"
          aria-keyshortcuts={chordAria(CHORDS.importSessions)}
          onSelect={onImport}
        >
          <Import />
          Import
          <DropdownMenuShortcut>{chordLabel(CHORDS.importSessions)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigate('agents', QUESTIONS_ROUTE)
          }}
        >
          <MessageCircleQuestion />
          Questions
          {open > 0 && <DropdownMenuShortcut>{open}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
