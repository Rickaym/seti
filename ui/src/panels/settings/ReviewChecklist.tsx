import { type PermissionRule, type ReviewCoverage, type ReviewTool } from '@seti/shared'
import { Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { basisLine } from './review-coverage'

function noteOf(tool: Pick<ReviewTool, 'basis' | 'reviewed'>, locked: boolean): string | null {
  if (tool.reviewed) {
    return 'Reviewed'
  }
  return tool.basis === 'unknown' && !locked ? 'Unknown' : null
}

function ToolRow({
  tool,
  locked,
  checked,
  onToggle,
}: {
  tool: Pick<ReviewTool, 'rule' | 'name' | 'basis' | 'reviewed'>
  /** The rule the user typed: always added. */
  locked: boolean
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  const id = useId()
  const note = noteOf(tool, locked)
  return (
    <li className="flex min-h-8 items-center gap-2.5 border-b border-border px-2.5 last:border-b-0 pointer-coarse:min-h-11">
      <Checkbox
        id={id}
        checked={tool.reviewed || locked || checked}
        disabled={tool.reviewed || locked}
        onCheckedChange={(next) => {
          onToggle(next === true)
        }}
      />
      <label htmlFor={id} className="min-w-0 flex-1 py-1 font-mono text-2xs break-all">
        {tool.name}
      </label>
      {note !== null && <span className="shrink-0 text-2xs text-muted-foreground">{note}</span>}
    </li>
  )
}

/** The typed tool first, then the server's other writing tools. */
function rowsOf(coverage: ReviewCoverage): ReviewTool[] {
  const typed = coverage.tools.find((tool) => tool.rule === coverage.tool)
  const others = coverage.tools.filter((tool) => tool.rule !== coverage.tool)
  if (coverage.tool === null) {
    return others
  }
  const name = coverage.tool.slice(coverage.server.length + 2)
  return [typed ?? { rule: coverage.tool, name, basis: 'unknown', outward: true, reviewed: false }, ...others]
}

/**
 * The tools of one MCP server that write or send, as a checklist, and one switch for a rule that
 * covers the whole server; one confirm adds the review rules chosen.
 */
export function ReviewChecklist({
  coverage,
  path,
  onClose,
  onAdded,
}: {
  coverage: ReviewCoverage
  /** Where the scope's rules live, such as /permissions/rules. */
  path: string
  onClose: () => void
  onAdded: () => void
}) {
  const rows = rowsOf(coverage)
  const open = rows.filter((tool) => !tool.reviewed)
  const [whole, setWhole] = useState(false)
  const [picked, setPicked] = useState(
    () => new Set(open.filter((tool) => tool.outward || tool.rule === coverage.tool).map((tool) => tool.rule)),
  )
  const [busy, setBusy] = useState(false)
  const wholeId = useId()
  const rules = whole ? [coverage.server] : open.filter((tool) => picked.has(tool.rule)).map((tool) => tool.rule)

  const add = async () => {
    setBusy(true)
    try {
      await apiPost<PermissionRule[]>(`${path}/batch`, { behavior: 'review', rules })
      onAdded()
      onClose()
    } catch (e) {
      toast.error(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Review {coverage.label}</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground">A review rule holds only the tool it names. {basisLine(coverage)}</p>
        <div className="flex items-center gap-2.5 border border-border px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={wholeId} className="font-medium">
              Every tool of {coverage.label}
            </label>
            <p className="text-2xs text-muted-foreground">
              One rule for the server: reads and tools it adds later too.
            </p>
          </div>
          <Switch id={wholeId} checked={whole} onCheckedChange={setWhole} />
        </div>
        {!whole && (
          <ul
            aria-label={`${coverage.label} tools`}
            className="max-h-[min(22rem,45dvh)] overflow-y-auto border border-border"
          >
            {rows.map((tool) => (
              <ToolRow
                key={tool.rule}
                tool={tool}
                locked={tool.rule === coverage.tool}
                checked={picked.has(tool.rule)}
                onToggle={(on) => {
                  const next = new Set(picked)
                  if (on) {
                    next.add(tool.rule)
                  } else {
                    next.delete(tool.rule)
                  }
                  setPicked(next)
                }}
              />
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            <X />
            Cancel
          </Button>
          <Button size="sm" disabled={busy || rules.length === 0} onClick={() => void add()}>
            <Plus />
            {whole || rules.length < 2 ? 'Add' : `Add ${String(rules.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
