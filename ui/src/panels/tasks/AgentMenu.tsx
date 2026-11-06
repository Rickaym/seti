import { EllipsisVertical } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { AgentAction } from '@/panels/tasks/agent-actions'

interface AgentMenuProps {
  actions: readonly AgentAction[]
  /** Rows after a separator, such as a frame's own. */
  more?: readonly AgentAction[]
  /** Marks the button, as while processes run. */
  dot?: boolean
}

function ActionItem({ action, onPick }: { action: AgentAction; onPick: (run: () => void) => void }) {
  const Icon = action.icon
  return (
    <DropdownMenuItem
      aria-label={action.ariaLabel}
      onSelect={() => {
        onPick(action.onSelect)
      }}
    >
      <Icon />
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.detail !== undefined && <DropdownMenuShortcut>{action.detail}</DropdownMenuShortcut>}
      {action.shortcut !== undefined && <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
}

/** A compact More actions menu: labeled rows, then any rows of the frame it shows in. */
export function AgentMenu({ actions, more = [], dot = false }: AgentMenuProps) {
  const chosen = useRef(false)
  const pick = (run: () => void) => {
    chosen.current = true
    run()
  }
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) {
          chosen.current = false
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="relative" aria-label="More actions">
          <EllipsisVertical />
          {dot && <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (chosen.current) {
            event.preventDefault()
          }
        }}
      >
        {actions.map((action) => (
          <ActionItem key={action.label} action={action} onPick={pick} />
        ))}
        {more.length > 0 && <DropdownMenuSeparator />}
        {more.map((action) => (
          <ActionItem key={action.label} action={action} onPick={pick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
