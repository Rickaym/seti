import { Archive, EllipsisVertical, Import } from 'lucide-react'
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

interface AgentListMenuProps {
  archived: boolean
  onArchived: (archived: boolean) => void
  onImport: () => void
}

/** The Agents list's rarer actions behind one button, so its header holds only view, new and this. */
export function AgentListMenu({ archived, onArchived, onImport }: AgentListMenuProps) {
  return (
    <DropdownMenu modal={false}>
      <Hint text="Archived agents and import">
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
