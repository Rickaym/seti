import { CommandItem, CommandShortcut } from '@/components/ui/command'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { ArchivedPill, StatusPill } from '@/panels/tasks/StatusPill'
import type { RankedEntry } from './rank'

function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) {
    return <>{text}</>
  }
  const marked = new Set(positions)
  const runs: { text: string; hit: boolean }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const hit = marked.has(index)
    const last = runs.at(-1)
    if (last?.hit === hit) {
      last.text += text.charAt(index)
    } else {
      runs.push({ text: text.charAt(index), hit })
    }
  }
  return (
    <>
      {runs.map((run, index) =>
        run.hit ? (
          <mark key={index} className="bg-transparent font-semibold text-primary">
            {run.text}
          </mark>
        ) : (
          run.text
        ),
      )}
    </>
  )
}

/** One palette row: icon, title over a second line, then a status pill or shortcut hint. */
export function PaletteRow({ item, onPick }: { item: RankedEntry; onPick: () => void }) {
  const { entry } = item
  const Icon = entry.icon
  return (
    <CommandItem value={entry.id} onSelect={onPick} {...agentColorAttr(entry.color ?? null)} className="agent-stripe">
      <Icon className="text-muted-foreground group-data-[selected=true]/command-item:text-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          <Highlighted text={entry.title} positions={item.title} />
        </span>
        {entry.detail !== undefined && entry.detail !== '' && (
          <span className="truncate text-2xs text-muted-foreground" title={entry.detailTitle}>
            <Highlighted text={entry.detail} positions={item.detail} />
          </span>
        )}
      </span>
      {entry.status === 'archived' && <ArchivedPill />}
      {entry.status !== undefined && entry.status !== 'archived' && <StatusPill status={entry.status} />}
      {entry.shortcut !== undefined && (
        <CommandShortcut className="pointer-coarse:hidden">{entry.shortcut}</CommandShortcut>
      )}
    </CommandItem>
  )
}
