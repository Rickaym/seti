import { Archive, CircleDollarSign, FolderGit2, Plug, Scan, Workflow, type LucideIcon } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { useNarrow } from '@/hooks/useMedia'
import type { GraphFilters } from './graph-model'

const TOGGLES: [key: keyof GraphFilters, label: string, icon: LucideIcon, hint: string][] = [
  ['repos', 'Repos', FolderGit2, 'Show the repos agents work in'],
  ['tools', 'Tools', Plug, 'Show the MCP servers agents called in 30 days, and tool calls running now'],
  ['subagents', 'Subagents', Workflow, 'Show the subagents running now'],
  ['archived', 'Archived', Archive, 'Show archived agents'],
  ['cost', 'Cost', CircleDollarSign, 'Size agents by cost over 30 days instead of turns'],
]

/** The graph's filters as toggles, and a button that frames every node. */
export function GraphToolbar({
  filters,
  onChange,
  onFit,
}: {
  filters: GraphFilters
  onChange: (key: keyof GraphFilters, on: boolean) => void
  onFit: () => void
}) {
  const narrow = useNarrow()
  return (
    <div role="toolbar" aria-label="Graph" className="flex items-center gap-1">
      {TOGGLES.map(([key, label, icon, hint]) => (
        <ToggleButton
          key={key}
          pressed={filters[key]}
          onPressedChange={(on) => {
            onChange(key, on)
          }}
          icon={icon}
          label={label}
          hint={hint}
          iconOnly={narrow}
        />
      ))}
      <Hint text="Frame every node">
        <Button
          variant="outline"
          size={narrow ? 'icon-sm' : 'sm'}
          aria-label={narrow ? 'Fit' : undefined}
          onClick={onFit}
        >
          <Scan />
          {!narrow && 'Fit'}
        </Button>
      </Hint>
    </div>
  )
}
