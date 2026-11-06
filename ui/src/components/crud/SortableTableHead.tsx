import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { TableHead } from '@/components/ui/table'
import type { SortDirection } from './tableSort'

function SortIcon({ direction }: { direction: SortDirection | null }) {
  if (direction === 'asc') {
    return <ArrowUp className="size-3 shrink-0" />
  }
  if (direction === 'desc') {
    return <ArrowDown className="size-3 shrink-0" />
  }
  return <ArrowUpDown className="size-3 shrink-0 opacity-45 dark:opacity-50" />
}

export function SortableTableHead({
  label,
  direction,
  onSort,
}: {
  label: string
  direction: SortDirection | null
  onSort: () => void
}) {
  return (
    <TableHead>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-inherit select-none hover:text-foreground"
        title={`Sort by ${label}`}
        onClick={onSort}
      >
        {label}
        <SortIcon direction={direction} />
      </button>
    </TableHead>
  )
}
