export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

export type DiffRow = DiffLine | { kind: 'skip'; count: number }

/** Above this many table cells the changed middle shows as removed then added lines. */
const MAX_CELLS = 4_000_000

const line = (kind: DiffLine['kind']) => (text: string) => ({ kind, text })

/** Longest common subsequence walk over two line lists that share no prefix or suffix. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  const at = (i: number, j: number) => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i++] ?? '' })
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: a[i++] ?? '' })
    } else {
      out.push({ kind: 'add', text: b[j++] ?? '' })
    }
  }
  return [...out, ...a.slice(i).map(line('del')), ...b.slice(j).map(line('add'))]
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const middle =
    midA.length * midB.length > MAX_CELLS ? [...midA.map(line('del')), ...midB.map(line('add'))] : lcsDiff(midA, midB)
  return [...a.slice(0, start).map(line('same')), ...middle, ...a.slice(endA).map(line('same'))]
}

/** Keeps `context` unchanged lines around each change and folds longer unchanged runs. */
export function foldUnchanged(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const near = lines.map((_, index) =>
    lines.slice(Math.max(0, index - context), index + context + 1).some((l) => l.kind !== 'same'),
  )
  const rows: DiffRow[] = []
  lines.forEach((l, index) => {
    if (near[index] === true) {
      rows.push(l)
      return
    }
    const last = rows.at(-1)
    if (last?.kind === 'skip') {
      last.count++
    } else {
      rows.push({ kind: 'skip', count: 1 })
    }
  })
  return rows
}
