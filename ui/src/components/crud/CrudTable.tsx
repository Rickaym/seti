import { Plus, RefreshCw } from 'lucide-react'
import { Fragment, useCallback, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNarrow } from '@/hooks/useMedia'
import { cn } from '@/lib/utils'
import { SortableTableHead } from './SortableTableHead'
import type { SortValue } from './tableSort'
import { useTableSort } from './useTableSort'

type SortableKeys<T> = { [K in keyof T]: T[K] extends SortValue ? K : never }[keyof T] & string

export interface CrudColumn<T> {
  key: SortableKeys<T>
  label: string
}

/** Refresh and Create, for the header of whatever holds the table. */
export function CrudActions({
  loading,
  onLoad,
  onCreateOpen,
}: {
  loading: boolean
  onLoad: () => void
  onCreateOpen: () => void
}) {
  return (
    <>
      <Button variant="outline" size="sm" onClick={onLoad} disabled={loading}>
        <RefreshCw className={cn(loading && 'animate-spin')} />
        Refresh
      </Button>
      <Button size="sm" onClick={onCreateOpen}>
        <Plus />
        Create
      </Button>
    </>
  )
}

/** Items as stacked entries on phones, where the table's columns do not fit. */
function CrudList<T>({
  columns,
  items,
  rowKey,
  actions,
}: {
  columns: readonly CrudColumn<T>[]
  items: readonly T[]
  rowKey: (item: T) => string
  actions: ((item: T) => ReactNode) | undefined
}) {
  const [first, ...rest] = columns
  return (
    <ul className="text-xs">
      {items.map((item) => (
        <li key={rowKey(item)} className="space-y-1 border-b border-border px-3 py-2 last:border-b-0">
          {first !== undefined && (
            <div className="text-sm font-medium wrap-anywhere">{String(item[first.key] ?? '-')}</div>
          )}
          {rest.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              {rest.map((col) => (
                <Fragment key={col.key}>
                  <dt className="text-muted-foreground">{col.label}</dt>
                  <dd className="wrap-anywhere">{String(item[col.key] ?? '-')}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {actions && <div className="flex items-center justify-end gap-1.5">{actions(item)}</div>}
        </li>
      ))}
    </ul>
  )
}

/** Sortable rows with their actions, or stacked entries on phones, under any edit dialog. */
export function CrudTable<T>({
  columns,
  items,
  loading,
  error,
  editForm,
  rowKey,
  actions,
}: {
  columns: readonly CrudColumn<T>[]
  items: readonly T[]
  loading: boolean
  error: string
  editForm?: ReactNode
  rowKey: (item: T) => string
  actions?: (item: T) => ReactNode
}) {
  const getSortValue = useCallback((item: T, key: SortableKeys<T>) => item[key] as SortValue, [])
  const { sort, toggleSort, sortedItems } = useTableSort(items, getSortValue)
  const narrow = useNarrow()

  return (
    <div className="space-y-4">
      {error !== '' && (
        <div className="rounded-none border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {editForm}
      <Card className="gap-0 py-0">
        <CardContent className="p-0">
          {items.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">{loading ? 'Loading...' : 'Nothing here yet.'}</p>
          )}
          {items.length > 0 && narrow && (
            <CrudList columns={columns} items={sortedItems} rowKey={rowKey} actions={actions} />
          )}
          {items.length > 0 && !narrow && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((col) => (
                      <SortableTableHead
                        key={col.key}
                        label={col.label}
                        direction={sort?.key === col.key ? sort.direction : null}
                        onSort={() => {
                          toggleSort(col.key)
                        }}
                      />
                    ))}
                    {actions && <TableHead className="w-[140px] text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedItems.map((item) => (
                    <TableRow key={rowKey(item)}>
                      {columns.map((col) => (
                        <TableCell key={col.key} className="max-w-[280px] truncate">
                          {String(item[col.key] ?? '-')}
                        </TableCell>
                      ))}
                      {actions && (
                        <TableCell>
                          <div className="flex items-center justify-end gap-1.5">{actions(item)}</div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
