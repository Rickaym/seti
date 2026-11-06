import type { ModAsk, ModAskDecision } from '@seti/shared'
import { Check, Puzzle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { useMods } from '@/hooks/useMods'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const asks = createPolledResource<ModAsk[]>('/mod-asks', 10_000)

const ICON = <Puzzle className="size-4" />

const toastId = (ask: ModAsk) => `mod-ask-${ask.id}`

/** The prompt an Allow starts an agent with, in full; Seti's summary holds only its start. */
const fullPrompt = (ask: ModAsk): string | null =>
  ask.op === 'tasks.manage.start' && typeof ask.args.prompt === 'string' ? ask.args.prompt : null

/** What the ask does, in Seti's words; the agent's title is the mod's, so it is quoted. */
function headline(ask: ModAsk, prompt: string | null): string {
  if (prompt === null) {
    return ask.summary
  }
  const where = typeof ask.args.repo_slug === 'string' ? ` in ${ask.args.repo_slug}` : ''
  return `Start an agent "${String(ask.args.title)}"${where} with this prompt:`
}

async function decide(ask: ModAsk, decision: ModAskDecision, modName: string): Promise<void> {
  try {
    const answered = await apiPost<ModAsk>(`/mod-asks/${ask.id}`, { decision })
    if (answered.state === 'failed') {
      toast.error(`${modName}: the allowed action failed`, {
        description: answered.outcome ?? undefined,
        duration: Infinity,
      })
    } else if (answered.state === 'done') {
      toast.success(answered.outcome ?? 'Done')
    }
  } catch (e) {
    toast.error(`Your answer to ${modName} did not reach Seti`, { description: errorText(e), duration: Infinity })
  } finally {
    asks.refresh()
  }
}

function AskBody({ ask, modName }: { ask: ModAsk; modName: string }) {
  const [busy, setBusy] = useState(false)
  const prompt = fullPrompt(ask)
  const answer = (decision: ModAskDecision) => () => {
    setBusy(true)
    void decide(ask, decision, modName).finally(() => {
      setBusy(false)
    })
  }
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-line">{headline(ask, prompt)}</p>
      {prompt !== null && (
        <blockquote
          aria-label="Prompt"
          className="max-h-40 overflow-y-auto border-l-2 border-border pl-2 text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {prompt}
        </blockquote>
      )}
      <div className="flex items-center gap-2" role="group" aria-label={`Answer ${modName}`}>
        <Button size="sm" disabled={busy} onClick={answer('allow')}>
          <Check />
          Allow
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={answer('deny')}>
          <X />
          Deny
        </Button>
      </div>
    </div>
  )
}

/**
 * A toast that stays for each thing a mod asked the user to allow, such as starting an agent.
 * Only the user's own session answers; the EA, agents and mods are refused by Seti.
 */
export function ModAskToasts() {
  const { data } = usePolled(asks)
  const mods = useMods().data
  const shown = useRef(new Set<string>())
  const dismissed = useRef(new Set<string>())

  useEffect(() => {
    const open = (data ?? []).filter((ask) => ask.state === 'pending' && !dismissed.current.has(ask.id))
    const wanted = new Set(open.map(toastId))
    for (const id of shown.current) {
      if (!wanted.has(id)) {
        toast.dismiss(id)
      }
    }
    for (const ask of open) {
      const modName = mods?.mods.find((mod) => mod.id === ask.mod_id)?.name ?? ask.mod_id
      toast(`${modName} asks you`, {
        id: toastId(ask),
        icon: ICON,
        duration: Number.POSITIVE_INFINITY,
        description: <AskBody ask={ask} modName={modName} />,
        onDismiss: () => {
          dismissed.current.add(ask.id)
        },
      })
    }
    shown.current = wanted
  }, [data, mods])

  return null
}
