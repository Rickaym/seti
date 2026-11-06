import { useMemo, useState } from 'react'
import { sortItems, type SortDirection, type SortValue } from './tableSort'

export function useTableSort<T, K extends string>(items: readonly T[], getSortValue: (item: T, key: K) => SortValue) {
  const [sort, setSort] = useState<{ key: K; direction: SortDirection } | null>(null)

  const toggleSort = (key: K) => {
    setSort((prev) => ({
      key,
      direction: prev?.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const sortedItems = useMemo(
    () => (sort ? sortItems(items, (item) => getSortValue(item, sort.key), sort.direction) : items),
    [items, sort, getSortValue],
  )

  return { sort, toggleSort, sortedItems }
}
