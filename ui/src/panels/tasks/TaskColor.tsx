import { normalizeAgentColor, type AgentColor, type Task } from '@seti/shared'
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Input } from '@/components/ui/input'
import { refreshTaskLists } from '@/hooks/useTasks'
import { agentColorLabel, PRESET_SWATCHES } from '@/lib/agent-color'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { cn } from '@/lib/utils'

const SWATCH = 'size-4 shrink-0 pointer-coarse:size-6'
const FALLBACK = normalizeAgentColor('blue') ?? ''

function NoneMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn('shrink-0 text-muted-foreground', className)}>
      <rect x={0.5} y={0.5} width={15} height={15} fill="none" stroke="currentColor" />
      <path d="M2 14 14 2" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  )
}

function Choice({
  label,
  pressed,
  onPick,
  children,
}: {
  label: string
  pressed: boolean
  onPick: () => void
  children: ReactNode
}) {
  return (
    <Hint text={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onPick}
        className="flex size-7 items-center justify-center border border-transparent outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-foreground pointer-coarse:size-11"
      >
        {children}
      </button>
    </Hint>
  )
}

/** The system colour picker, which applies its colour once the picker closes. */
function NativePicker({
  value,
  onDraft,
  onPick,
}: {
  value: AgentColor
  onDraft: (color: AgentColor) => void
  onPick: (color: AgentColor) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(onPick)
  useEffect(() => {
    latest.current = onPick
  })
  useEffect(() => {
    const element = input.current
    const changed = () => {
      if (element !== null) {
        latest.current(element.value)
      }
    }
    element?.addEventListener('change', changed)
    return () => {
      element?.removeEventListener('change', changed)
    }
  }, [])
  return (
    <Hint text="Pick any colour">
      <input
        ref={input}
        type="color"
        aria-label="Pick any colour"
        value={value}
        onChange={(event) => {
          onDraft(event.target.value)
        }}
        className="size-7 shrink-0 cursor-pointer border border-border bg-transparent p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11 [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
    </Hint>
  )
}

/** The current colour by name, which opens the choices below it. */
function ColorChip({
  color,
  expanded,
  controls,
  onToggle,
}: {
  color: AgentColor | null
  expanded: boolean
  controls: string
  onToggle: () => void
}) {
  const name = color === null ? 'None' : agentColorLabel(color)
  return (
    <Hint text={expanded ? 'Hide the colours' : 'Change the colour'}>
      <button
        type="button"
        aria-label={`Colour ${name}`}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
        className="inline-flex h-7 max-w-full items-center gap-1.5 border border-border px-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
      >
        {color === null ? (
          <NoneMark className="size-3.5" />
        ) : (
          <span aria-hidden {...agentColorAttr(color)} className="size-3.5 shrink-0 bg-(--agent-stripe)" />
        )}
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown aria-hidden className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
    </Hint>
  )
}

/** The agent's colour, folded to its name; it opens to swatches, the picker and a hex field. */
export function TaskColor({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [picked, setPicked] = useState<{ color: AgentColor | null; from: AgentColor | null } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const hint = useId()
  const shown = picked !== null && picked.from === task.color ? picked.color : task.color
  const typed = draft === null ? null : normalizeAgentColor(draft)
  const invalid = draft !== null && draft.trim() !== '' && typed === null
  const preview = typed ?? shown
  const [expanded, setExpanded] = useState(false)
  const pickerId = useId()

  const pick = async (color: AgentColor | null) => {
    setDraft(null)
    if (color === shown) {
      return
    }
    setPicked({ color, from: task.color })
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { color })
      onChanged()
      refreshTaskLists()
    } catch (e) {
      setPicked(null)
      toast.error(errorText(e))
    }
  }
  const apply = () => {
    if (typed !== null) {
      void pick(typed)
    }
  }
  return (
    <div className="space-y-1.5">
      <ColorChip
        color={shown}
        expanded={expanded}
        controls={pickerId}
        onToggle={() => {
          setExpanded(!expanded)
        }}
      />
      <div id={pickerId} hidden={!expanded} className="space-y-1.5">
        <div role="group" aria-label="Color" className="flex flex-wrap items-center gap-0.5">
          <Choice label="None" pressed={shown === null} onPick={() => void pick(null)}>
            <NoneMark className={SWATCH} />
          </Choice>
          {PRESET_SWATCHES.map(({ hex, label }) => (
            <Choice key={hex} label={label} pressed={shown === hex} onPick={() => void pick(hex)}>
              <span aria-hidden {...agentColorAttr(hex)} className={cn(SWATCH, 'bg-(--agent-stripe)')} />
            </Choice>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <NativePicker value={preview ?? FALLBACK} onDraft={setDraft} onPick={(color) => void pick(color)} />
          <Input
            aria-label="Hex colour"
            aria-invalid={invalid}
            aria-describedby={invalid ? hint : undefined}
            value={draft ?? shown ?? ''}
            placeholder="#rrggbb"
            maxLength={7}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                apply()
              }
            }}
            onBlur={apply}
            className="h-7 w-[5.5rem] shrink-0 px-1.5 tabular-nums"
          />
          <div
            data-testid="agent-color-preview"
            {...agentColorAttr(preview)}
            className="agent-stripe agent-tint flex h-7 min-w-0 flex-1 items-center border border-border pr-1.5 pl-2.5 text-2xs pointer-coarse:h-11"
          >
            <span className="truncate">{task.title}</span>
          </div>
        </div>
        {invalid && (
          <p id={hint} className="text-2xs text-muted-foreground">
            Use a hex such as #3b82f6 or #38f.
          </p>
        )}
      </div>
    </div>
  )
}
