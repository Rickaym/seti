import type { AccessItem, ContextPack, ContextPackSummary, EaPackPrompt, TaskContextPacksInput } from '@seti/shared'
import { BookOpen, Pencil, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { AccessList } from '@/panels/access/AccessList'

const APPLIES = "Applies from the EA's next turn"

const PACK_HINT =
  "Reference material in the EA's system prompt, after its base prompt. The EA starts with none; a pack's Default under Context is for agents only."

/** The packs linked to the EA and how long their text runs; loaded again when version changes. */
function useEaPacks(version: number) {
  const [linked, setLinked] = useState<ContextPackSummary[] | null>(null)
  const [prompt, setPrompt] = useState<EaPackPrompt | null>(null)
  const load = useCallback(() => {
    Promise.all([
      apiGet<ContextPackSummary[]>('/ea/context-packs'),
      apiGet<EaPackPrompt>('/ea/context-packs/prompt'),
    ]).then(
      ([packs, text]) => {
        setLinked(packs)
        setPrompt(text)
      },
      (e: unknown) => {
        toast.error(errorText(e))
      },
    )
  }, [])
  useEffect(load, [load, version])
  return { linked, prompt, load }
}

/** Says so once the linked packs run past what the EA's prompt takes. */
function CapWarning({ prompt }: { prompt: EaPackPrompt | null }) {
  if (prompt === null || prompt.chars <= prompt.max_chars) {
    return null
  }
  return (
    <p role="status" className="flex items-start gap-1 text-2xs text-warning-text">
      <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
      {`The role and packs run to ${prompt.chars.toLocaleString()} characters; the EA reads the first ${prompt.max_chars.toLocaleString()}, so the rest is cut.`}
    </p>
  )
}

function PackChips({ linked }: { linked: ContextPackSummary[] | null }) {
  if (linked === null) {
    return <span className="flex-1 text-muted-foreground">Loading...</span>
  }
  const references = linked.filter((pack) => pack.kind === 'reference')
  if (references.length === 0) {
    return <span className="flex-1 text-muted-foreground">None</span>
  }
  return (
    <ul aria-label="EA context packs" className="flex min-w-0 flex-1 flex-wrap gap-1">
      {references.map((pack) => (
        <li key={pack.id} className="flex max-w-56 items-center gap-1 border border-border px-1.5 py-px text-2xs">
          <BookOpen className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{pack.name}</span>
        </li>
      ))}
    </ul>
  )
}

/** The reference packs in the EA's prompt at a glance, with the editor one click away. */
export function EaContextPacks({ version, onEdit }: { version: number; onEdit: () => void }) {
  const { linked, prompt } = useEaPacks(version)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-1">
        <PackChips linked={linked} />
        <Hint text="Link or unlink context packs">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Edit EA context packs"
            className="-my-0.5 shrink-0 text-muted-foreground"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        </Hint>
      </div>
      <CapWarning prompt={prompt} />
    </div>
  )
}

const asItem = (pack: ContextPack, linked: readonly ContextPackSummary[]): AccessItem => ({
  kind: 'pack',
  id: pack.id,
  name: pack.name,
  detail: pack.description === '' ? null : pack.description,
  default_enabled: false,
  override: null,
  enabled: linked.some((link) => link.id === pack.id),
  jump_for: [],
  missing_key: [],
  in_set: false,
  session: null,
})

/** Links reference packs to the EA or unlinks them, with the agents' pack switches. */
export function EaPacksDialog({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
  const [version, setVersion] = useState(0)
  const { linked, prompt } = useEaPacks(version)
  const [packs, setPacks] = useState<ContextPack[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    apiGet<ContextPack[]>('/context/packs').then(
      (all) => {
        setPacks(all.filter((pack) => pack.kind === 'reference' && !pack.builtin))
      },
      (e: unknown) => {
        setPacks([])
        toast.error(errorText(e))
      },
    )
  }, [])

  const change = async (item: AccessItem, enabled: boolean | null) => {
    if (linked === null) {
      return
    }
    setBusy(`${item.kind}:${item.id}`)
    try {
      const rest = linked.map((pack) => pack.id).filter((id) => id !== item.id)
      const body: TaskContextPacksInput = { pack_ids: enabled === true ? [...rest, item.id] : rest }
      await apiPut<ContextPackSummary[]>('/ea/context-packs', body)
      setVersion((v) => v + 1)
      onChanged()
      toast.success(APPLIES)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
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
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-lg max-md:overflow-hidden"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Context packs of the EA</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-2xs text-muted-foreground">
          Linked packs follow the EA&apos;s base prompt from its next turn, typed or spoken. Its role is under Role in
          the EA settings.
        </p>
        <CapWarning prompt={prompt} />
        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search packs"
            placeholder="Search packs"
            className="pl-7"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
          />
        </div>
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 pb-1">
          {packs === null || linked === null ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <AccessList
              items={packs.map((pack) => asItem(pack, linked))}
              kinds={['pack']}
              query={query}
              busy={busy}
              plain
              hints={{ pack: PACK_HINT }}
              onChange={(item, enabled) => void change(item, enabled)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
