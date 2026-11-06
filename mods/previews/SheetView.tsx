import type { ModKit } from '@seti/mod-api'
import { Copy, Heading, Rows3, Search } from 'lucide-react'
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { SheetTable, type CellRef } from './SheetTable'
import { columnName, rowText, type Grid } from './grid'
import { useKit } from './kit'

const count = (n: number) => n.toLocaleString('en-US')

function matching(grid: Grid, from: number, query: string): number[] {
  const rows: number[] = []
  for (let r = from; r < grid.rows.length; r++) {
    if (query === '' || (grid.rows[r] ?? []).some((cell) => cell.toLowerCase().includes(query))) {
      rows.push(r)
    }
  }
  return rows
}

function copyText(kit: ModKit, text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => {
      kit.succeed(`${what} copied`)
    },
    (e: unknown) => {
      kit.fail('Copy failed', kit.errorText(e))
    },
  )
}

/** A table with a filter, an optional header row, and copying of the selected cell or row. */
export function SheetView({
  grid,
  label,
  headerFirst,
  notice,
}: {
  grid: Grid
  label: string
  /** Start with the first row as column names, as a csv usually has. */
  headerFirst: boolean
  /** Shown above the table, such as why rows are missing. */
  notice?: ReactNode
}) {
  const kit = useKit()
  const { Button, Hint, Input, ToggleButton } = kit
  const [header, setHeader] = useState(headerFirst && grid.rows.length > 1)
  const [filter, setFilter] = useState('')
  const query = useDeferredValue(filter.trim().toLowerCase())
  const [selected, setSelected] = useState<CellRef | null>(null)
  const visible = useMemo(() => matching(grid, header ? 1 : 0, query), [grid, header, query])
  const names = useMemo(() => {
    const first = header ? (grid.rows[0] ?? []) : []
    return Array.from({ length: grid.columns }, (_, c) => {
      const name = first[c] ?? ''
      return name === '' ? columnName(c) : name
    })
  }, [grid, header])
  const total = grid.rows.length - (header ? 1 : 0)
  const selectedRow = selected === null ? null : (grid.rows[selected.row] ?? [])
  const copyCell = () => {
    if (selected !== null && selectedRow !== null) {
      copyText(kit, selectedRow[selected.col] ?? '', 'Cell')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="relative max-w-64 min-w-36 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter rows"
            placeholder="Filter rows"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
            }}
            className="h-7 pl-7"
          />
        </div>
        <ToggleButton
          pressed={header}
          onPressedChange={setHeader}
          icon={<Heading />}
          label="Header"
          hint={header ? 'Show the first row as data' : 'Use the first row as column names'}
        />
        <Hint text="Copy the selected cell (Ctrl+C)">
          <Button variant="outline" size="sm" disabled={selected === null} onClick={copyCell}>
            <Copy />
            Cell
          </Button>
        </Hint>
        <Hint text="Copy the selected row as tab-separated text">
          <Button
            variant="outline"
            size="sm"
            disabled={selectedRow === null}
            onClick={() => {
              copyText(kit, rowText(selectedRow ?? []), 'Row')
            }}
          >
            <Rows3 />
            Row
          </Button>
        </Hint>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {query === '' ? `${count(total)} rows` : `${count(visible.length)} of ${count(total)} rows`}
        </span>
      </div>
      {notice}
      {visible.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{query === '' ? 'No rows.' : 'No rows match the filter.'}</p>
      ) : (
        <SheetTable
          grid={grid}
          visible={visible}
          names={names}
          selected={selected}
          onSelect={setSelected}
          onCopy={copyCell}
          label={label}
        />
      )}
    </div>
  )
}
