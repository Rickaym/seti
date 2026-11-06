export type SortDirection = 'asc' | 'desc'

export type SortValue = string | number | boolean | null | undefined

const isEmpty = (v: SortValue) => v === null || v === undefined || v === ''

function compareForSort(a: SortValue, b: SortValue): number {
  if (isEmpty(a) || isEmpty(b)) {
    return Number(isEmpty(a)) - Number(isEmpty(b))
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function sortItems<T>(items: readonly T[], getValue: (item: T) => SortValue, direction: SortDirection): T[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...items].sort((x, y) => sign * compareForSort(getValue(x), getValue(y)))
}
