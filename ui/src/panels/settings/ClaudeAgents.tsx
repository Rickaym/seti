import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { movedCard } from '@/lib/route'
import { ModelList, SubagentList } from '@/panels/capabilities/CommandSections'
import { useCapabilities } from '@/panels/capabilities/useCapabilities'
import { useMovedCard } from './use-moved-card'

const ID = 'claude-agents'

/** The subagents and models of the probe, read only once the section is open. */
function ProbedLists() {
  const { snapshot, loading, error } = useCapabilities()
  // The lists arrive after the rest of the page, so an old link scrolls again once they show.
  useMovedCard(snapshot !== null)
  if (error !== '') {
    return <p className="px-3 py-2 text-destructive">{error}</p>
  }
  if (snapshot === null) {
    return (
      <p className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
        {loading && <Loader2 className="size-3.5 animate-spin" />}
        Starting Claude Code to list them. This takes up to 20 s.
      </p>
    )
  }
  return (
    <div className="grid grid-cols-2 items-start max-md:grid-cols-1">
      <section aria-label="Subagents" className="border-border md:border-r max-md:border-b">
        <h5 className="px-3 pt-2 font-medium">Subagents</h5>
        <SubagentList agents={snapshot.subagents} />
      </section>
      <section aria-label="Models">
        <h5 className="px-3 pt-2 font-medium">Models</h5>
        <ModelList models={snapshot.models} />
      </section>
    </div>
  )
}

/** Claude Code's own subagents and the models it offers, collapsed until asked for. */
export function ClaudeAgents() {
  const [open, setOpen] = useState(() => movedCard() === ID)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section id={ID} aria-label="Subagents and models" className="scroll-mt-4 border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm font-medium pointer-coarse:min-h-11"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <Chevron className="size-4 shrink-0 text-muted-foreground" />
        Subagents and models
      </button>
      {open && <ProbedLists />}
    </section>
  )
}
