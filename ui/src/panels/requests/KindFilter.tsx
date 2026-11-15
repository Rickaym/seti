import type { RequestKind } from '@seti/shared'
import { Hand, Inbox, KeyRound, Lightbulb, ListChecks, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { kindsWaiting, type KindFilter } from '@/panels/requests/groups'

const KINDS: Record<RequestKind, { label: string; icon: LucideIcon; hint: string }> = {
  questions: { label: 'Questions', icon: MessageCircleQuestion, hint: 'Questions agents asked you' },
  access: { label: 'Access', icon: KeyRound, hint: 'Hosts, connections and MCP servers agents asked for' },
  plans: { label: 'Plans', icon: ListChecks, hint: 'Plans agents wait on you to approve' },
  tools: { label: 'Tools', icon: Hand, hint: 'Tool calls no rule allows, waiting on you' },
  notes: { label: 'Notes', icon: Lightbulb, hint: 'Knowledge notes waiting for your approval' },
}

const CHIP = 'pointer-coarse:h-11 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary'

interface ChipProps {
  value: KindFilter
  label: string
  icon: LucideIcon
  count: number
  hint: string
  pressed: boolean
  onPick: (value: KindFilter) => void
}

function Chip({ value, label, icon: Icon, count, hint, pressed, onPick }: ChipProps) {
  return (
    <Button
      size="sm"
      variant="outline"
      title={hint}
      aria-pressed={pressed}
      className={CHIP}
      onClick={() => {
        onPick(value)
      }}
    >
      <Icon />
      {label}
      <span className="text-muted-foreground tabular-nums">{count}</span>
    </Button>
  )
}

interface KindFilterProps {
  counts: Record<RequestKind, number>
  value: KindFilter
  onChange: (value: KindFilter) => void
}

/** All, or one kind of request, each with how many wait; it shows only once two kinds wait. */
export function KindFilterBar({ counts, value, onChange }: KindFilterProps) {
  const kinds = kindsWaiting(counts)
  if (kinds.length < 2) {
    return null
  }
  const total = kinds.reduce((sum, kind) => sum + counts[kind], 0)
  return (
    <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1.5">
      <Chip
        value="all"
        label="All"
        icon={Inbox}
        count={total}
        hint="Every kind of request"
        pressed={value === 'all'}
        onPick={onChange}
      />
      {kinds.map((kind) => (
        <Chip
          key={kind}
          value={kind}
          {...KINDS[kind]}
          count={counts[kind]}
          pressed={value === kind}
          onPick={onChange}
        />
      ))}
    </div>
  )
}
