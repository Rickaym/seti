import { History } from 'lucide-react'
import type { ReactNode } from 'react'
import { ToggleButton } from '@/components/ToggleButton'

export function HistoryButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <ToggleButton
      pressed={open}
      onPressedChange={onToggle}
      icon={History}
      label="History"
      hint="Changes by you and agents, with a revert for each"
    />
  )
}

export function HistoryAside({ children }: { children: ReactNode }) {
  return (
    <aside aria-label="Change history" className="flex w-[440px] shrink-0 flex-col border-l border-border">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Change history</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  )
}
