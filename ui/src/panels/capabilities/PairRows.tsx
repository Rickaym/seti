import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { newPair, type Pair } from './pairs'

export function PairRows({
  label,
  item,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string
  /** One row's name on the add button, kept to a word. */
  item: string
  pairs: Pair[]
  keyPlaceholder: string
  valuePlaceholder: string
  onChange: (pairs: Pair[]) => void
}) {
  const update = (id: number, patch: Partial<Pair>) => {
    onChange(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }
  return (
    <div className="col-span-full grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {pairs.map((pair, i) => (
        <div key={pair.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            aria-label={`${label} ${String(i + 1)} name`}
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => {
              update(pair.id, { key: e.target.value })
            }}
          />
          <Input
            aria-label={`${label} ${String(i + 1)} value`}
            type="password"
            autoComplete="off"
            placeholder={pair.hint === '' ? valuePlaceholder : pair.hint}
            value={pair.value}
            onChange={(e) => {
              update(pair.id, { value: e.target.value })
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label.toLowerCase()} ${String(i + 1)}`}
            onClick={() => {
              onChange(pairs.filter((p) => p.id !== pair.id))
            }}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Add ${label.toLowerCase().replace(/s$/, '')}`}
          onClick={() => {
            onChange([...pairs, newPair()])
          }}
        >
          <Plus />
          Add {item}
        </Button>
      </div>
    </div>
  )
}
